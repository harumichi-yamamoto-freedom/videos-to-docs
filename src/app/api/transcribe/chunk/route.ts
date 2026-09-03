/**
 * POST /api/transcribe/chunk — 長時間音声の 1 チャンクを文字起こしする (設計 §3.2)。
 *
 * 契約は `src/lib/transcribeChunkContract.ts`。
 * 検査順は `/api/generate` に揃える:
 *   本文 → 主体 (401) → パス/所有権/MIME (400/403) → キー在否 (503)
 *   → Storage 存在/サイズ (404/413) → 時間あたり上限 (429) → 取得 → Gemini (502/504)
 *   → 品質ゲート → 200
 *
 * 🔴 品質ゲートに落ちても HTTP は 200 で返す。
 * 「文字起こしはできたが使えない」は API の失敗ではなく**結果の性質**であり、
 * どのゲートで落ちたかをクライアントが見て再試行の戦略を決める (設計 §4.3)。
 */
import {
    TRANSCRIBE_CHUNK_ALLOWED_MIME_PREFIXES,
    TRANSCRIBE_CHUNK_MAX_AUDIO_SEC,
    type TranscribeChunkRequestBody,
    type TranscribeChunkResponseBody,
} from '@/lib/transcribeChunkContract';
import { createLogger } from '@/lib/logger';
import { evaluateChunkQuality } from '@/lib/transcriptQuality';
import { resolveRequestSubject } from '@/server/auth';
import { GenerateApiError } from '@/server/errors';
import { assertGeminiConfigured } from '@/server/geminiServer';
import { downloadMedia, isOwnedBySubject, parseStoragePath, statMedia } from '@/server/mediaSource';
import { clientIpFromHeaders, enforceRateLimit } from '@/server/rateLimit';
import { TranscribeChunkClient } from '@/server/transcribeChunk';
import type { TranscriptAnnotation as RawServerAnnotation } from '@/lib/transcribeApiContract';
import type { TranscriptAnnotation as GateAnnotation } from '@/lib/transcriptQuality';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const logger = createLogger('api/transcribe/chunk');

const jsonResponse = (body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
    });

const errorResponse = (error: GenerateApiError): Response => {
    const headers: Record<string, string> = error.retryAfterSec !== undefined
        ? { 'retry-after': String(error.retryAfterSec) }
        : {};
    return jsonResponse(error.toBody(), error.status, headers);
};

const invalid = (message: string): GenerateApiError => new GenerateApiError('invalid_request', message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** 正の有限数だけを通す。0 と負数と NaN は弾く (ゲートの分母になるため) */
const positiveNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

export function validateRequestBody(raw: unknown): TranscribeChunkRequestBody {
    const reload = 'ページを再読み込みして、もう一度お試しください。';
    if (!isRecord(raw)) throw invalid(`リクエストの形式が不正です。${reload}`);

    const { storagePath, fileName, mimeType, audioSec, speechSec } = raw;
    if (typeof storagePath !== 'string' || !storagePath) throw invalid(`アップロード先の情報がありません。${reload}`);
    if (typeof fileName !== 'string' || !fileName) throw invalid(`ファイル名がありません。${reload}`);
    if (typeof mimeType !== 'string' || !TRANSCRIBE_CHUNK_ALLOWED_MIME_PREFIXES.some(p => mimeType.startsWith(p))) {
        throw invalid('音声ファイルのみ文字起こしできます。');
    }
    if (!positiveNumber(audioSec)) throw invalid(`チャンクの長さが不正です。${reload}`);
    if (audioSec > TRANSCRIBE_CHUNK_MAX_AUDIO_SEC) {
        // 上限を超えた音声は、静かに一部だけ起こされて `completed` が返ることがある (設計 §3.3)。
        // サーバ側で先に落として、その失敗様式に入らせない。
        throw invalid(
            `チャンクが長すぎます (上限 ${Math.floor(TRANSCRIBE_CHUNK_MAX_AUDIO_SEC / 60)} 分)。`
            + 'より短く分割してから再試行してください。',
        );
    }
    // speechSec は 0 でありうる (完全に無音のチャンク)。0 は許すが、負数と NaN は弾く。
    if (typeof speechSec !== 'number' || !Number.isFinite(speechSec) || speechSec < 0) {
        throw invalid(`発話時間の測定値が不正です。${reload}`);
    }
    if (speechSec > audioSec + 1) throw invalid(`発話時間が音声の長さを超えています。${reload}`);

    return { storagePath, fileName, mimeType, audioSec, speechSec };
}

function assertOwnership(storagePath: string, subject: Awaited<ReturnType<typeof resolveRequestSubject>>): void {
    const parsed = parseStoragePath(storagePath);
    if (!parsed) throw invalid('アップロード先の形式が不正です。ページを再読み込みして、もう一度お試しください。');
    if (!isOwnedBySubject(parsed.ownerId, subject)) {
        logger.warn('storagePath の所有者が主体と不一致', { ownerId: parsed.ownerId, subjectKind: subject.kind });
        throw new GenerateApiError('forbidden', 'このファイルを処理する権限がありません。');
    }
}

/**
 * サーバ側の注釈 (すべて任意・`startSec`/`endSec`) を、
 * 品質ゲートと結合が要求する形 (すべて必須・`startOffsetSec`/`endOffsetSec`) に正規化する。
 *
 * 🔴 **時刻が読めなかった注釈は落とす。** 0 で埋めるとカバレッジ (G8) が壊れ、
 * 「音声の先頭まで起こした」ように見えてしまう。
 * ただし**落とした件数は必ず返し、ログに出す** — 黙って減らすと、
 * カバレッジ不足の原因が「モデルが起こさなかった」のか「こちらが捨てた」のか区別できなくなる。
 */
export function normalizeAnnotations(
    raw: readonly RawServerAnnotation[],
): { annotations: GateAnnotation[]; droppedCount: number } {
    const annotations: GateAnnotation[] = [];
    let droppedCount = 0;
    for (const item of raw) {
        if (typeof item.startSec !== 'number' || typeof item.endSec !== 'number') {
            droppedCount += 1;
            continue;
        }
        annotations.push({
            text: item.text ?? '',
            startOffsetSec: item.startSec,
            endOffsetSec: item.endSec,
            speaker: item.speaker ?? null,
        });
    }
    return { annotations, droppedCount };
}

async function readJsonBody(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        throw invalid('リクエストの本文を読み取れませんでした。ページを再読み込みして、もう一度お試しください。');
    }
}

export async function POST(request: Request): Promise<Response> {
    const startedAt = Date.now();
    try {
        const body = validateRequestBody(await readJsonBody(request));
        const subject = await resolveRequestSubject(request.headers);
        assertOwnership(body.storagePath, subject);
        assertGeminiConfigured();

        const info = await statMedia(body.storagePath);
        const rate = await enforceRateLimit(subject, clientIpFromHeaders(request.headers));
        const media = await downloadMedia(info);

        const client = new TranscribeChunkClient();
        const result = await client.transcribe({
            bytes: media.bytes,
            mimeType: body.mimeType,
            fileName: body.fileName,
            // 🔴 クライアントの実測を優先する。注釈から導くと末尾の無音が落ち、
            //    G8 (カバレッジ) が常に甘くなる。
            audioSec: body.audioSec,
        });

        const { annotations, droppedCount } = normalizeAnnotations(result.annotations);

        // 🔴 ゲートの入力は、呼び出し側が設定を知っている前提で明示的に渡す (設計 §4.2.5)。
        //    既定の推定に任せると「設定したのに注釈 0 本」= silent fail-open を検出できない。
        const quality = evaluateChunkQuality(
            {
                status: result.status,
                text: result.text,
                annotations,
                audioSec: body.audioSec,
                speechSec: body.speechSec,
                ...(result.outputTokens !== undefined && { outputTokens: result.outputTokens }),
            },
            { diarizationEnabled: true, timestampsEnabled: true },
        );

        const elapsedMs = Date.now() - startedAt;
        const response: TranscribeChunkResponseBody = {
            status: result.status,
            text: result.text,
            annotations,
            quality: {
                passed: quality.passed,
                failedGates: quality.failedGates,
                warnedGates: quality.warnedGates,
                indeterminateGates: quality.indeterminateGates,
            },
            ...(result.cachedTokens !== undefined && { cachedTokens: result.cachedTokens }),
            elapsedMs,
        };

        // 計器: Vercel runtime logs で 1 行 JSON として拾えるようにする (logger の整形を通さない)。
        // 🔴 cachedTokens と indeterminateGates を必ず載せる。
        //    前者は「キャッシュを見ていただけ」の走を、後者は「検査が走らなかった」ことを後から数えるため。
        console.log(JSON.stringify({
            event: 'transcribe.chunk',
            passed: quality.passed,
            failedGates: quality.failedGates,
            warnedGates: quality.warnedGates,
            indeterminateGates: quality.indeterminateGates,
            status: result.status,
            chars: result.text.length,
            annotations: annotations.length,
            droppedAnnotations: droppedCount,
            audioSec: body.audioSec,
            speechSec: body.speechSec,
            cachedTokens: result.cachedTokens,
            elapsedMs,
            subjectKind: subject.kind,
            rateCount: rate.count,
            rateLimit: rate.limit,
            sizeBytes: media.sizeBytes,
        }));
        return jsonResponse(response, 200);
    } catch (error) {
        if (error instanceof GenerateApiError) {
            logger.warn('transcribe/chunk を拒否/失敗', {
                code: error.code, status: error.status, elapsedMs: Date.now() - startedAt,
                cause: error.cause instanceof Error ? error.cause.message : undefined,
            });
            return errorResponse(error);
        }
        logger.error('transcribe/chunk で想定外のエラー', error, { elapsedMs: Date.now() - startedAt });
        return errorResponse(new GenerateApiError('upstream_error',
            '文字起こし中にエラーが発生しました。しばらくしてから再試行してください。'));
    }
}

export function GET(): Response {
    return jsonResponse({ error: 'invalid_request', message: 'POST でのみ利用できます。' }, 405, { allow: 'POST' });
}

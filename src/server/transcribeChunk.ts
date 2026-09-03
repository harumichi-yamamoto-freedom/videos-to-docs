/**
 * サーバ側のチャンク文字起こし (Interactions API `POST /v1beta/interactions`)。
 * 音声は Files API へ上げてから uri で渡す (25 分チャンク ≒ 18MB でインラインは入らない)。
 *
 * 既存の `geminiServer.ts` は変更せず、Files API のアップロード / ACTIVE 待ち / 生成後の削除は
 * `GeminiServerClient` をそのまま合成して使う。エラー写像も `classifyGeminiError` を共有する。
 *
 * 品質ゲート (`src/lib/transcriptQuality.ts`) はここでは呼ばない。ゲートが必要とする形
 * (`status` / `text` / `annotations` / `audioSec` / `outputTokens` / `cachedTokens` / `transport`) を返すところまで。
 */
import {
    TRANSCRIBE_API_KEY_HEADER,
    TRANSCRIBE_DIARIZATION_MODE,
    TRANSCRIBE_INTERACTIONS_URL,
    TRANSCRIBE_LANGUAGE_CODES,
    TRANSCRIBE_MODE_TYPE,
    TRANSCRIBE_MODEL,
    TRANSCRIBE_TIMESTAMP_GRANULARITIES,
    type RawTranscriptAnnotation,
    type TranscribeChunkResult,
    type TranscribeRequestBody,
    type TranscriptAnnotation,
} from '@/lib/transcribeApiContract';
import { createLogger } from '@/lib/logger';
import { GenerateApiError } from './errors';
import { GeminiServerClient, classifyGeminiError, getGeminiApiKey, type GeminiServerOptions } from './geminiServer';

const logger = createLogger('server/transcribeChunk');

/** Interactions API 1 回あたりの待ち上限。route の maxDuration 内に収める */
export const TRANSCRIBE_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * リクエスト JSON を組み立てる唯一の場所。
 * 🔴 `mode` はオブジェクトで、`type` を必ず持つ (無いと 400、`transcription_config` 直下に置いても 400)。
 * 🔴 `diarization_mode` / `timestamp_granularities` は API 側で検証されないので、
 *    値は contract の定数からしか来ない (リテラルを書かない)。
 */
export function buildTranscribeRequest(fileUri: string, mimeType: string): TranscribeRequestBody {
    return {
        model: TRANSCRIBE_MODEL,
        input: [{ type: 'audio', uri: fileUri, mime_type: mimeType }],
        generation_config: {
            transcription_config: {
                language_codes: TRANSCRIBE_LANGUAGE_CODES,
                mode: {
                    type: TRANSCRIBE_MODE_TYPE,
                    diarization_mode: TRANSCRIBE_DIARIZATION_MODE,
                    timestamp_granularities: TRANSCRIBE_TIMESTAMP_GRANULARITIES,
                },
            },
        },
    };
}

/** `"3.900s"` → 3.9。数として読めなければ undefined (0 に丸めない) */
export function parseOffsetSeconds(offset: unknown): number | undefined {
    if (typeof offset === 'number') return Number.isFinite(offset) ? offset : undefined;
    if (typeof offset !== 'string') return undefined;
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*s?\s*$/.exec(offset);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const asArray = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * 🔴 出力トークンの取り出し。`usage.total_output_tokens` は上限到達時でも常に 0 を返すので見ない。
 * `usage.model_invocation_token_counts[].candidates_tokens_details[]` のうち
 * `modality === 'text'` の `tokenCount` を **全要素合計** する (複数要素があり得る)。
 * 明細そのものが 1 つも無ければ undefined (0 に丸めない)。
 */
export function extractOutputTokens(usage: unknown): number | undefined {
    const invocations = asArray(asRecord(usage)?.model_invocation_token_counts);
    if (!invocations) return undefined;

    let sawDetails = false;
    let total = 0;
    for (const invocation of invocations) {
        const details = asArray(asRecord(invocation)?.candidates_tokens_details);
        if (!details) continue;
        sawDetails = true;
        for (const entry of details) {
            const detail = asRecord(entry);
            if (!detail) continue;
            if (detail.modality !== 'text') continue;
            total += asNumber(detail.tokenCount) ?? asNumber(detail.token_count) ?? 0;
        }
    }
    return sawDetails ? total : undefined;
}

/**
 * `steps[].content[]` から本文と注釈を集める。
 * content が複数に割れている場合、注釈の `start_index` / `end_index` は各 content 内の位置なので、
 * 連結後の本文に対して有効になるよう、それまでの本文長でずらす。
 */
function collectStepContents(payload: Record<string, unknown>): { text: string; annotations: TranscriptAnnotation[] } {
    const steps = asArray(payload.steps) ?? [];
    let text = '';
    const annotations: TranscriptAnnotation[] = [];

    for (const step of steps) {
        const contents = asArray(asRecord(step)?.content) ?? [];
        for (const entry of contents) {
            const content = asRecord(entry);
            if (!content) continue;
            const offset = text.length;
            const chunkText = typeof content.text === 'string' ? content.text : '';
            for (const rawEntry of asArray(content.annotations) ?? []) {
                const raw = asRecord(rawEntry) as RawTranscriptAnnotation | undefined;
                if (!raw) continue;
                const startIndex = asNumber(raw.start_index);
                const endIndex = asNumber(raw.end_index);
                annotations.push({
                    ...(startIndex !== undefined && { startIndex: startIndex + offset }),
                    ...(endIndex !== undefined && { endIndex: endIndex + offset }),
                    ...(typeof raw.text === 'string' && { text: raw.text }),
                    ...(parseOffsetSeconds(raw.start_offset) !== undefined && { startSec: parseOffsetSeconds(raw.start_offset) }),
                    ...(parseOffsetSeconds(raw.end_offset) !== undefined && { endSec: parseOffsetSeconds(raw.end_offset) }),
                    ...(raw.speaker !== undefined && { speaker: raw.speaker }),
                    ...(typeof raw.type === 'string' && { type: raw.type }),
                });
            }
            text += chunkText;
        }
    }
    return { text, annotations };
}

/** 応答 JSON → 呼び出し側の形。空本文・注釈 0 件・`incomplete` はそのまま通す (例外にしない) */
export function parseTranscribeResponse(body: unknown, audioSecHint?: number): TranscribeChunkResult {
    const payload = asRecord(body) ?? {};
    const { text, annotations } = collectStepContents(payload);
    const usage = asRecord(payload.usage);

    const endSecs = annotations.map(a => a.endSec).filter((v): v is number => v !== undefined);
    const audioSec = audioSecHint ?? (endSecs.length > 0 ? Math.max(...endSecs) : undefined);

    return {
        status: typeof payload.status === 'string' ? payload.status : 'unknown',
        text,
        annotations,
        ...(audioSec !== undefined && { audioSec }),
        ...(extractOutputTokens(usage) !== undefined && { outputTokens: extractOutputTokens(usage) }),
        ...(asNumber(usage?.total_cached_tokens) !== undefined && { cachedTokens: asNumber(usage?.total_cached_tokens) }),
        transport: 'files_api',
    };
}

export interface TranscribeChunkInput {
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    /** チャンクの音声長 (秒)。分かっていれば渡す。無ければ注釈から導く */
    audioSec?: number;
}

export interface TranscribeChunkOptions extends GeminiServerOptions {
    /** Interactions API 1 回あたりの待ち上限 */
    requestTimeoutMs?: number;
    /** テスト用の差し替え口 (既定はグローバル fetch) */
    fetchImpl?: typeof fetch;
}

export class TranscribeChunkClient {
    private readonly apiKey: string;
    private readonly files: GeminiServerClient;
    private readonly requestTimeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(options: TranscribeChunkOptions = {}) {
        const { requestTimeoutMs, fetchImpl, ...geminiOptions } = options;
        this.apiKey = options.apiKey ?? getGeminiApiKey();
        this.files = new GeminiServerClient({ ...geminiOptions, apiKey: this.apiKey });
        this.requestTimeoutMs = requestTimeoutMs ?? TRANSCRIBE_REQUEST_TIMEOUT_MS;
        this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    }

    /** チャンク 1 本を文字起こしする。Files API に上げたファイルは成否によらず削除する */
    async transcribe(input: TranscribeChunkInput): Promise<TranscribeChunkResult> {
        const { bytes, mimeType, fileName } = input;
        if (bytes.length === 0) {
            throw new GenerateApiError('invalid_request',
                '音声チャンクが空です。分割からやり直してください。');
        }

        let uploadedName: string | null = null;
        try {
            const uploaded = await this.files.uploadMedia(bytes, mimeType, fileName);
            uploadedName = uploaded.name;

            const requestBody = buildTranscribeRequest(uploaded.fileUri, uploaded.mimeType);
            logger.info('文字起こしを開始', {
                fileName, mimeType, model: TRANSCRIBE_MODEL, sizeBytes: bytes.length, fileUri: uploaded.fileUri,
            });

            const response = await this.fetchImpl(TRANSCRIBE_INTERACTIONS_URL, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    [TRANSCRIBE_API_KEY_HEADER]: this.apiKey,
                },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(this.requestTimeoutMs),
            });

            if (!response.ok) {
                // 生英文は logger と classify 用にだけ使い、利用者向け文言は classifyGeminiError が付ける
                const detail = await response.text().catch(() => '');
                throw new Error(`Transcribe API ${response.status}: ${detail.slice(0, 500)}`);
            }

            const result = parseTranscribeResponse(await response.json(), input.audioSec);
            logger.info('文字起こしが完了', {
                fileName, status: result.status, textLength: result.text.length,
                annotationCount: result.annotations.length, audioSec: result.audioSec,
                outputTokens: result.outputTokens, cachedTokens: result.cachedTokens,
            });
            return result;
        } catch (error) {
            logger.error('文字起こしでエラーが発生', error, { fileName, model: TRANSCRIBE_MODEL });
            throw classifyGeminiError(error, TRANSCRIBE_MODEL);
        } finally {
            if (uploadedName) {
                await this.files.deleteUploadedMedia(uploadedName);
            }
        }
    }
}

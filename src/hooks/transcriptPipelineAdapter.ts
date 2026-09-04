/**
 * 分割パイプライン（`runTranscriptionJob`）を、既存の生成処理と**同じ戻り値の形**に揃えるアダプタ。
 *
 * 🔴 これがあることで、`useVideoProcessing` 側の分岐は1箇所で済み、
 * 下流の下書き・保存・冪等キー・中断・監査ログは**まったく変更せずに**そのまま効く。
 *
 * 失敗の扱いは既存に合わせる: 例外を投げず `{ success: false, error }` を返す。
 * 既存の生成失敗と同じ経路で利用者に伝わる。
 */
import type { VideoConverter } from '@/lib/ffmpeg';
import type { TranscriptionResult } from '@/lib/gemini';
import { createLogger } from '@/lib/logger';
import {
    createFfmpegSilenceScanner,
    runTranscriptionJob,
    type TranscriptionJobDeps,
} from '@/hooks/useTranscriptionJob';
import { deleteAudioFromStorage, uploadAudioToStorage } from '@/lib/storage';
import { TRANSCRIBE_CHUNK_API_PATH, type TranscribeChunkResponseBody } from '@/lib/transcribeChunkContract';
import { GENERATE_AUTH_HEADER } from '@/lib/generateApiContract';

const logger = createLogger('transcriptPipeline');

export interface RunTranscriptPipelineInput {
    file: File;
    /** ffmpeg。無音走査もこのインスタンスを使う（別に立てると wasm を再ロードする） */
    converter: VideoConverter | null;
    signal?: AbortSignal;
    /** テスト用の差し替え。本番では省略する */
    deps?: Partial<TranscriptionJobDeps>;
    runJob?: typeof runTranscriptionJob;
}

/**
 * 本番の依存一式。テストは個別に差し替えるので、ここは**実物だけ**を組む。
 *
 * 🔴 `converter` は `load()` 済みであること。別インスタンスを立てると wasm を再ロードする。
 */
export function buildTranscriptionJobDeps(converter: VideoConverter): TranscriptionJobDeps {
    return {
        converter,
        // 🔴 無音走査は**同じ ffmpeg インスタンス**を使う（設計 §3.1）。
        //    別に立てると wasm core をもう一度ロードする。
        // 🔴 ffmpeg の取り出しは**走査するときまで遅らせる**。ここで呼ぶと、
        //    走らせないのに load 済みであることを要求してしまう。
        scanSilence: (file, options) => createFfmpegSilenceScanner(
            converter.getFfmpeg(),
            async (f) => new Uint8Array(await f.arrayBuffer()),
        )(file, options),
        uploadChunk: (blob, fileName) =>
            uploadAudioToStorage(blob, fileName, {
                originalFileName: fileName,
                originalFileType: 'audio',
            }),
        deleteChunk: (storagePath) => deleteAudioFromStorage(storagePath),
        postChunk: async (body, signal) => {
            // 認証は既存の生成 API と同じ形。未ログイン (ゲスト) はヘッダを付けない
            // 🔴 firebase はここで**遅延 import** する。モジュール先頭で読むと、
            //    このアダプタを import しただけで Auth が初期化され、
            //    鍵の無い環境（テスト・prerender）が `auth/invalid-api-key` で落ちる。
            let token: string | null = null;
            try {
                const { auth } = await import('@/lib/firebase');
                token = (await auth.currentUser?.getIdToken()) ?? null;
            } catch {
                token = null;
            }
            const headers: Record<string, string> = { 'content-type': 'application/json' };
            if (token) headers[GENERATE_AUTH_HEADER] = `Bearer ${token}`;
            const response = await fetch(TRANSCRIBE_CHUNK_API_PATH, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                ...(signal ? { signal } : {}),
            });
            const json = (await response.json()) as TranscribeChunkResponseBody & { message?: string };
            if (!response.ok) {
                // 🔴 サーバの文言をそのまま使う。ここで作文すると、上限超過などの
                //    「次に何をすればよいか」が書かれた文言が失われる
                throw new Error(json.message ?? `チャンクの文字起こしに失敗しました (${response.status})`);
            }
            return json;
        },
    };
}

export async function runTranscriptPipeline(
    input: RunTranscriptPipelineInput,
): Promise<TranscriptionResult> {
    const { file, converter, signal, deps, runJob = runTranscriptionJob } = input;

    if (!converter) {
        // 変換器が無い状態はここまで来ない想定だが、来たときに黙って成功にしない。
        return { success: false, error: '音声変換の準備ができていません。ページを再読み込みしてください。' };
    }

    try {
        // 🔴 **本番の依存をここで実際に組み立てる。**
        //    以前は `{ converter, ...deps } as TranscriptionJobDeps` と**型を黙らせて**いたため、
        //    `scanSilence` / `uploadChunk` / `deleteChunk` / `postChunk` が 1 つも配線されておらず、
        //    本番で必ず `scanSilence is not a function` で落ちていた（2026-09-04・実ブラウザで発見）。
        //    型アサーションで穴を塞ぐと、tsc もテストも緑のまま本番だけ壊れる。
        const job = await runJob(
            file,
            { ...buildTranscriptionJobDeps(converter), ...(deps ?? {}) },
            { ...(signal ? { signal } : {}) },
        );

        if (!job.ok) {
            // 🔴 1本でも失敗チャンクがあれば成功にしない（設計 §4.4）。
            //    ただし**本文は捨てない** — 取れたところまでは読める形で返し、
            //    欠落は本文中に注記として残っている。
            const detail = job.aborted
                ? '文字起こしを中止しました。'
                : `${job.failedChunkIndexes.length} 個の区間を文字起こしできませんでした。`;
            logger.warn('文字起こしが完全には終わらなかった', {
                fileName: file.name,
                aborted: job.aborted,
                failedChunks: job.failedChunkIndexes.length,
                chars: job.markdown?.length ?? 0,
            });
            return { success: false, error: detail, ...(job.markdown ? { text: job.markdown } : {}) };
        }

        logger.info('文字起こしが完了', {
            fileName: file.name,
            chunks: job.chunks.length,
            chars: job.markdown.length,
            // 🔴 MAI (preview) が落ちて Gemini に回った区間。用語集が効いていないのはここ (設計 §3.7)
            fallbackChunks: job.fallbackChunks.length,
            durationSec: job.durationSec,
            noiseFloorDb: job.noiseFloorDb,
            silenceThresholdDb: job.silenceThresholdDb,
            // 🔴 キャッシュに当たった走は「測り直していない」ので残す（設計 §3.3）
            cachedRuns: job.cachedRuns.length,
            // 🔴 結合の不変条件。破れていたらマージのバグ（設計 §3.4）
            invariantsOk: job.invariants.ok,
        });
        if (!job.invariants.ok) {
            // 本文は返すが、成功にはしない。黙って壊れた結合を保存させない。
            return {
                success: false,
                error: '文字起こしの結合結果が検査に通りませんでした。もう一度お試しください。',
                text: job.markdown,
            };
        }
        // 🔴 「どのモデルで起こしたか」は 1 つに決まらない。チャンクごとに MAI か Gemini かが変わる
        //    (設計 §3.7)。全部 MAI なら MAI、1 本でも落ちていれば両方を書く。
        //    片方だけ書くと、用語集が効いていない区間がある事実が記録から消える。
        const usedModel = job.fallbackChunks.length === 0
            ? 'MAI-Transcribe-2'
            : `MAI-Transcribe-2 + gemini-3.5-transcribe (${job.fallbackChunks.length}/${job.chunks.length} 区間)`;
        return {
            success: true,
            text: job.markdown,
            usedModel,
        };
    } catch (error) {
        logger.error('文字起こしで想定外のエラー', error, { fileName: file.name });
        return {
            success: false,
            error: error instanceof Error
                ? error.message
                : '文字起こし中にエラーが発生しました。しばらくしてから再試行してください。',
        };
    }
}

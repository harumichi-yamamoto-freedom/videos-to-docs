/**
 * チャンク 1 本を **MAI-Transcribe-2 で起こし、落ちたら Gemini へ回す**（設計 §3.7・東野裁定）。
 *
 * なぜ二重化するか:
 * - MAI は用語集・話者分離・単語時刻が**同時に**成立する（Gemini は API が 400 で拒否・§1.5）。
 *   同一 10 分窓 7 本の実測で、本文は 2.3 倍（中央 2,338 字 vs 1,038 字）、
 *   最長穴は 3 秒 vs 8 秒、話者 2 名以上は 7/7 vs 4/7、時刻の暴走は 0 件だった。
 * - 🔴 一方 MAI は **public preview で SLA が無く、実際に落ちる**。
 *   実測した失敗: 408 Timeout / 503 `diarization_unavailable` / 500 / 接続断。
 *
 * 🔴 **切り替えはチャンク単位**。1 本落ちてもジョブ全体を巻き戻さない（§4.3 の再試行と同じ思想）。
 * 🔴 **フォールバックした事実を必ず返す**。用語集は MAI でしか効かないので、
 *    Gemini に落ちた区間だけ用語の反映が弱い。黙って混ぜると理由が追えなくなる。
 */
import type { TranscribeChunkResult } from '@/lib/transcribeApiContract';
import type { TranscribeEngine } from '@/lib/maiTranscribeContract';
import { createLogger } from '@/lib/logger';
import { MaiTranscribeClient, getMaiCredentials, type MaiCredentials } from './maiTranscribe';
import { TranscribeChunkClient } from './transcribeChunk';

const logger = createLogger('server/transcribeWithFallback');

export interface EngineInput {
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    audioSec: number;
    phraseList?: readonly string[];
}

export interface EngineOutcome {
    result: TranscribeChunkResult;
    /** 実際にこの本文を起こしたエンジン */
    engine: TranscribeEngine;
    /**
     * MAI を試して落ちた理由。**Gemini に落ちたときだけ**入る。
     * 🔴 利用者に見せる文言ではなく、記録と計器のための短い理由。
     */
    fallbackReason?: string;
    /** MAI を試したか。資格情報が無ければ false（＝落ちたのではなく、そもそも試していない） */
    maiAttempted: boolean;
}

export interface FallbackDeps {
    credentials?: MaiCredentials | null;
    makeMai?: (credentials: MaiCredentials) => Pick<MaiTranscribeClient, 'transcribe'>;
    makeGemini?: () => Pick<TranscribeChunkClient, 'transcribe'>;
}

export async function transcribeWithFallback(
    input: EngineInput,
    deps: FallbackDeps = {},
): Promise<EngineOutcome> {
    const credentials = deps.credentials !== undefined ? deps.credentials : getMaiCredentials();
    const makeGemini = deps.makeGemini ?? (() => new TranscribeChunkClient());

    if (!credentials) {
        // 🔴 「試して落ちた」と「設定が無くて試していない」を混同しない。
        //    前者は preview の不安定さ、後者は運用の設定漏れで、打つ手が違う。
        logger.info('MAI の資格情報が無いので Gemini だけで起こす');
        const result = await makeGemini().transcribe(input);
        return { result, engine: 'gemini', maiAttempted: false };
    }

    const makeMai = deps.makeMai ?? ((c: MaiCredentials) => new MaiTranscribeClient(c));
    try {
        const result = await makeMai(credentials).transcribe(input);
        return { result, engine: 'mai', maiAttempted: true };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // 🔴 warn で残す。preview の可用性はここでしか数えられない
        logger.warn('MAI が失敗したので Gemini へフォールバックする', {
            reason, audioSec: input.audioSec, fileName: input.fileName,
        });
        const result = await makeGemini().transcribe(input);
        return { result, engine: 'gemini', fallbackReason: reason, maiAttempted: true };
    }
}

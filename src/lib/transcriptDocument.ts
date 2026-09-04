/**
 * 文書が「文字起こし」として扱われるかの判定。
 *
 * 🔴 条件は「音声があるか」ではなく **「本文に時刻リンクがあるか」**。
 *
 * `audioStoragePath` は音声から生成した**すべての**文書に入っている。
 * それを条件に文字起こし用の UI (時刻リンクからの再生・話者改名・従属プレイヤー) を出すと、
 * **既存の議事録文書にもプレイヤーが出て見た目が変わる**。
 * 実際に飛べる先がある文書だけを対象にする (設計 §6.5-3)。
 *
 * 判定を UI から切り離してあるのは、コンポーネントを import せずに錠をかけられるようにするため
 * (`DocumentDetailPanel` を import すると Firebase の初期化が走る)。
 */
import { parseTranscriptTimestamps } from '@/lib/transcriptMerge';

/** 判定に必要な最小限。`Transcription` でも `TranscriptionDocument` でも受けられる */
export interface TranscriptCandidateDocument {
    text?: string;
    transcription?: string;
    audioStoragePath?: string;
}

export function shouldEnableTranscriptUi(doc: TranscriptCandidateDocument | null | undefined): boolean {
    if (!doc) return false;
    const body = typeof doc.text === 'string' ? doc.text
        : typeof doc.transcription === 'string' ? doc.transcription
            : null;
    if (body === null) return false;
    return parseTranscriptTimestamps(body).length > 0;
}

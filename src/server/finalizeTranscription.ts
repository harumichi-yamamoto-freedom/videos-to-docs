/**
 * バッチ結果 → 既存の文書と同じ Markdown。
 *
 * 🔴 既存の結合・整形（mergeTranscriptChunks / toTranscriptMarkdown）を**そのまま再利用**する。
 *    バッチは 1 ファイル = 1 結果なのでチャンクは 1 本。出力の見た目（段落・時刻リンク・話者ラベル）は
 *    同期チャンク方式のときと変わらない（時刻シーク再生・PDF・編集の回帰の錠がそのまま効く）。
 * 🔴 バッチは単一エンジン（Azure 標準モデル）なので、フォールバック注記は付かない。
 */
import { mergeTranscriptChunks, toTranscriptMarkdown, type MergeChunk } from '@/lib/transcriptMerge';
import type { ParsedBatch } from './azureBatchTranscribe';

/** バッチ結果 1 本を、文書へ保存できる Markdown にする。 */
export function buildTranscriptMarkdownFromBatch(parsed: ParsedBatch): string {
    const chunk: MergeChunk = {
        index: 0,
        startSec: 0,
        prefixSec: 0,
        endSec: parsed.audioSec,
        failed: false,
        // 句単位の注釈。チャンク開始が 0 なので、区間内オフセット = 元音声の絶対秒。
        annotations: parsed.annotations.map((a) => ({
            text: a.text ?? '',
            startOffsetSec: a.startSec ?? 0,
            endOffsetSec: a.endSec ?? a.startSec ?? 0,
            speaker: a.speaker ?? null,
        })),
    };
    const merged = mergeTranscriptChunks([chunk]);
    return toTranscriptMarkdown(merged);
}

/**
 * 完成した文書に載せる「使用モデル」表示。バッチは Azure 標準モデル。
 * 話者が付かなかった場合はその旨を添える（利用者が「話者が出ない」と混乱しないように）。
 */
export function describeBatchModel(parsed: ParsedBatch): string {
    const base = 'Azure 音声認識（バッチ）';
    return parsed.speakers >= 2 ? base : `${base}・話者分離なし`;
}

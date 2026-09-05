/**
 * バッチ結果 → 既存の文書と同じ Markdown（＋要確認候補の段落アンカー・本文ハッシュ・保存予算）。
 *
 * 🔴 既存の結合・整形（mergeTranscriptChunks / toTranscriptMarkdown）を**そのまま再利用**する。
 *    バッチは 1 ファイル = 1 結果なのでチャンクは 1 本。出力の見た目（段落・時刻リンク・話者ラベル）は
 *    同期チャンク方式のときと変わらない（時刻シーク再生・PDF・編集の回帰の錠がそのまま効く）。
 * 🔴 バッチは単一エンジン（Azure 標準モデル）なので、フォールバック注記は付かない。
 * 🔴 要確認候補（設計 B2/B4）: 句 → 段落開始行の対応は**生成時に決定的に**作る。本文の文字列検索・最寄り時刻・
 *    `#t=` の先頭一致で推測しない。対応が確定しない句はアンカー無し（undefined）にする。
 */
import { createHash } from 'node:crypto';
import {
    formatTimestampLink,
    mergeTranscriptChunks,
    midpointSec,
    toAbsoluteSec,
    toTranscriptMarkdown,
    type MergeChunk,
    type MergedSegment,
} from '@/lib/transcriptMerge';
import type { TranscriptReview } from '@/lib/transcriptReviewContract';
import { createLogger } from '@/lib/logger';
import type { ParsedBatch } from './azureBatchTranscribe';
import { measureReviewJsonBytes } from './reviewCandidates';

const logger = createLogger('server/finalizeTranscription');

/** バッチ結果 1 本を結合器の入力（チャンク 1 本）にする。チャンク開始が 0 なので、区間内オフセット = 元音声の絶対秒。 */
const toMergeChunk = (parsed: ParsedBatch): MergeChunk => ({
    index: 0,
    startSec: 0,
    prefixSec: 0,
    endSec: parsed.audioSec,
    failed: false,
    // 句単位の注釈。
    annotations: parsed.annotations.map((a) => ({
        text: a.text ?? '',
        startOffsetSec: a.startSec ?? 0,
        endOffsetSec: a.endSec ?? a.startSec ?? 0,
        speaker: a.speaker ?? null,
    })),
});

/** バッチ結果 1 本を、文書へ保存できる Markdown にする。 */
export function buildTranscriptMarkdownFromBatch(parsed: ParsedBatch): string {
    return toTranscriptMarkdown(mergeTranscriptChunks([toMergeChunk(parsed)]));
}

export interface TranscriptWithAnchors {
    markdown: string;
    /**
     * 句 index（`TranscriptAnnotation.phraseIndex`）→ その句が属する段落の開始行（生成 Markdown の 1 始まり）。
     * 対応が確定しない句（本文が改行を含む段落・順序や描画形が期待と一致しない段落）は入らない。
     */
    phraseLineByIndex: Map<number, number>;
}

/** `toTranscriptMarkdown` の既定と同じ: 同じ話者なら間隔に関係なく段落を分けない。 */
const PARAGRAPH_BREAK_GAP_SEC = Number.POSITIVE_INFINITY;

const countNewlines = (text: string): number => {
    let count = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count += 1;
    return count;
};

interface ParagraphRef {
    startSec: number;
    speaker: string | null;
    /** この段落に畳まれた `parsed.annotations` の添字 */
    annotationIndices: number[];
    /** 段落本文に含まれる改行数。0 でないと段落と行の対応が確定しない */
    newlines: number;
}

/**
 * 句 → 段落開始行。`toTranscriptMarkdown` の段落化規則（話者が変わったときだけ段落を分ける・段落は空行 1 行で区切る）を
 * 同じ入力に適用して行番号を算出し、各段落の描画形（時刻リンク＋話者ラベル）が実際の行と一致することを確認する。
 * 一致しない段落以降は対応を確定できないので付けない。
 */
function paragraphLinesByPhraseIndex(
    parsed: ParsedBatch,
    chunk: MergeChunk,
    segments: readonly MergedSegment[],
    gapCount: number,
    markdown: string,
): Map<number, number> {
    const lines = new Map<number, number>();
    // 単一の非失敗チャンクでは欠落注記は出ない。出ていれば段落の並びが読めないので付けない。
    if (gapCount !== 0) return lines;

    // 1) 結合で残る注釈を、mergeTranscriptChunks と同じ規則（中点がチャンク開始より前なら捨てる）で特定する
    const kept: number[] = [];
    chunk.annotations.forEach((annotation, i) => {
        const startSec = toAbsoluteSec(annotation.startOffsetSec, chunk);
        const endSec = toAbsoluteSec(annotation.endOffsetSec, chunk);
        if (midpointSec(startSec, endSec) < chunk.startSec) return;
        kept.push(i);
    });
    if (kept.length !== segments.length) return lines;

    // 2) 段落へ畳む（toTranscriptMarkdown の既定と同じ規則）。各段が元の注釈と一致することも確認する
    const paragraphs: ParagraphRef[] = [];
    let current: ParagraphRef | null = null;
    let lastEndSec = 0;
    for (let k = 0; k < segments.length; k += 1) {
        const segment = segments[k];
        const annotation = chunk.annotations[kept[k]];
        if (segment.text !== annotation.text || segment.startSec !== toAbsoluteSec(annotation.startOffsetSec, chunk)) {
            return lines;
        }
        const continues =
            current !== null &&
            current.speaker === segment.speaker &&
            segment.startSec - lastEndSec <= PARAGRAPH_BREAK_GAP_SEC;
        if (current !== null && continues) {
            current.annotationIndices.push(kept[k]);
            current.newlines += countNewlines(segment.text);
            lastEndSec = Math.max(lastEndSec, segment.endSec);
            continue;
        }
        current = {
            startSec: segment.startSec,
            speaker: segment.speaker,
            annotationIndices: [kept[k]],
            newlines: countNewlines(segment.text),
        };
        paragraphs.push(current);
        lastEndSec = segment.endSec;
    }

    // 3) 行番号: 段落 k の開始行 = 1 + Σ(前の段落の行数 + 空行 1)。段落の行数 = 1 + 本文中の改行数。
    //    各段落の先頭（時刻リンク＋話者ラベル＋空白）が実際の行と一致することを確認する（推測ではなく算出値の検算）。
    const markdownLines = markdown.split('\n');
    let line = 1;
    for (const paragraph of paragraphs) {
        const label = paragraph.speaker ? ` **${paragraph.speaker}**` : '';
        const prefix = `${formatTimestampLink(paragraph.startSec)}${label} `;
        const actual = markdownLines[line - 1];
        if (actual === undefined || !actual.startsWith(prefix)) break;
        // 本文が改行を含む段落は Markdown 上で複数行・複数ブロックになり得るので、その句にはアンカーを付けない
        if (paragraph.newlines === 0) {
            for (const annotationIndex of paragraph.annotationIndices) {
                const phraseIndex = parsed.annotations[annotationIndex]?.phraseIndex;
                if (typeof phraseIndex === 'number') lines.set(phraseIndex, line);
            }
        }
        line += paragraph.newlines + 1 + 1;
    }
    return lines;
}

/**
 * バッチ結果 1 本を Markdown にし、同時に「句 index → 段落開始行」の対応を作る（設計 B2）。
 * Markdown は `buildTranscriptMarkdownFromBatch` と同一。アンカーの算出に失敗しても本文は返す（設計 B4: 候補のために本文を失敗させない）。
 */
export function buildTranscriptWithAnchors(parsed: ParsedBatch): TranscriptWithAnchors {
    const chunk = toMergeChunk(parsed);
    const merged = mergeTranscriptChunks([chunk]);
    const markdown = toTranscriptMarkdown(merged);
    let phraseLineByIndex: Map<number, number>;
    try {
        phraseLineByIndex = paragraphLinesByPhraseIndex(parsed, chunk, merged.segments, merged.gaps.length, markdown);
    } catch (error) {
        logger.warn('段落アンカーの算出に失敗（本文は保存・アンカー無し）', {
            reason: error instanceof Error ? error.message : String(error),
        });
        phraseLineByIndex = new Map();
    }
    return { markdown, phraseLineByIndex };
}

/**
 * 保存する Markdown の UTF-8 バイト列の SHA-256（hex）。
 * UI は表示本文を同じ規則でハッシュし、一致する間だけ本文の段落バッジ・移動を有効にする（設計 B2）。
 */
export const sourceTextHashOf = (markdown: string): string =>
    createHash('sha256').update(markdown, 'utf8').digest('hex');

/** 候補に段落開始行を補う。対応の無い候補には付けない（推測しない）。候補の順序・件数は変えない。 */
export function withParagraphAnchors(
    review: TranscriptReview,
    lineByPhraseId: ReadonlyMap<string, number>,
): TranscriptReview {
    return {
        ...review,
        candidates: review.candidates.map((candidate) => {
            const line = lineByPhraseId.get(candidate.phraseId);
            return line === undefined ? candidate : { ...candidate, paragraphStartLine: line };
        }),
    };
}

/** Firestore の 1 文書上限（バイト）。本文＋候補＋他フィールドの合計がこれを超えると終端 commit 自体が失敗する。 */
export const FIRESTORE_MAX_DOCUMENT_BYTES = 1024 * 1024;
/**
 * title / fileName / 音声参照 / 時刻 / フィールド名などのぶんの見込み。JSON バイト数は Firestore の実サイズと一致しないので
 * 余裕を取る（候補を省く側に倒す。本文は本機能では切り詰めない）。
 */
export const DOCUMENT_OVERHEAD_HEADROOM_BYTES = 64 * 1024;

/**
 * 本文＋候補＋見込みが Firestore の 1 文書上限に収まるか（設計 B2: JSON サイズだけで保存可否を判定しない。文書全体で見る）。
 * 🔴 候補件数・128 KiB の予算そのものは抽出側の applyReviewBudget が単一の正。ここはその後の文書全体の見積りだけを担う。
 *    収まらないときの扱い（unavailable の最小形 → それでも超えるなら review を省く）は呼び出し側（status route）。
 */
export const reviewFitsDocument = (review: TranscriptReview, markdownBytes: number): boolean =>
    markdownBytes + measureReviewJsonBytes(review) + DOCUMENT_OVERHEAD_HEADROOM_BYTES <= FIRESTORE_MAX_DOCUMENT_BYTES;

/**
 * 完成した文書に載せる「使用モデル」表示。バッチは Azure 標準モデル。
 * 話者が付かなかった場合はその旨を添える（利用者が「話者が出ない」と混乱しないように）。
 */
export function describeBatchModel(parsed: ParsedBatch): string {
    const base = 'Azure 音声認識（バッチ）';
    return parsed.speakers >= 2 ? base : `${base}・話者分離なし`;
}

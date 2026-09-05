/**
 * バッチ結果 → 既存の文書と同じ Markdown（＋要確認候補の段落アンカー・本文ハッシュ・保存予算）。
 *
 * 🔴 既存の結合・整形（mergeTranscriptChunks / toTranscriptMarkdown）を**そのまま再利用**する。
 *    バッチは 1 ファイル = 1 結果なのでチャンクは 1 本。出力の見た目（段落・時刻リンク・話者ラベル）は
 *    同期チャンク方式のときと変わらない（時刻シーク再生・PDF・編集の回帰の錠がそのまま効く）。
 * 🔴 バッチは単一エンジン（Azure 標準モデル）なので、フォールバック注記は付かない。
 * 🔴 要確認候補（設計 B2/B4）: 句 → 段落開始行の対応は**生成時に決定的に**作る。本文の文字列検索・最寄り時刻・
 *    `#t=` の先頭一致で推測しない。対応が確定しない句はアンカー無し（undefined）にする。
 *    行番号は描画側（react-markdown / micromark）と同じ規則で数え（CRLF・単独 CR・LF はいずれも 1 改行）、
 *    アンカーは Markdown 上で必ず 1 つの段落ブロックになる「プレーンな 1 行の段落」にだけ付ける。
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
     * 行は描画側と同じく CRLF・単独 CR・LF をいずれも 1 改行として数える。
     * 対応が確定しない句は入らない: 本文が改行や Markdown 構文になり得る書き方を含む段落、
     * 改行を含む段落の続きの行がフェンス・HTML ブロックを開き得るときのそれ以降の全段落、描画形が期待と一致しない段落以降。
     */
    phraseLineByIndex: Map<number, number>;
}

/** `toTranscriptMarkdown` の既定と同じ: 同じ話者なら間隔に関係なく段落を分けない。 */
const PARAGRAPH_BREAK_GAP_SEC = Number.POSITIVE_INFINITY;

/** `toTranscriptMarkdown` のブロック区切り（空行 1 行） */
const BLOCK_SEPARATOR = '\n\n';

/**
 * 描画側（react-markdown → micromark）と同じ改行規則。CommonMark は CRLF・単独 CR・LF をいずれも 1 つの行末として扱うので、
 * 行番号もこの規則で数える（LF だけを数えると、本文に CR を含む句以降の行番号が描画とずれる）。
 */
const LINE_ENDING = /\r\n?|\n/;

/** `text` に含まれる行末の数（= 行数 − 1）。 */
const countLineEndings = (text: string): number => text.split(LINE_ENDING).length - 1;

/** コードフェンス。開いたまま閉じないと、空行を越えて文末まで後続ブロックを飲み込む。 */
const FENCE_RUN = /```|~~~/;

/**
 * 本文の先頭が行頭に出たとき Markdown のブロック構造に化け得る書き方: 見出し（#）・引用（>）・表（|）・箇条書き（- * + と
 * 「数字.」「数字)」の後ろに空白か行末）・区切り線（--- *** ___）。時刻リンクで始まる 1 行の段落では実際には行頭に出ないが、
 * B2 は保守的に倒し、迷う書き方には付けない。
 */
const BLOCK_MARKER_AT_BODY_START = /^[ \t]*(?:#|>|\||[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|-{3,}|\*{3,}|_{3,})/;

/**
 * 「プレーンな段落」= 1 つの段落ブロックになることが確定しているブロック。
 * 改行を含まず（続きの行が行頭に出ない）、フェンス・`<`（HTML）を含まず、本文の先頭がブロックの目印にならない。
 * `block` は保存 Markdown 上のブロック全文（時刻リンク＋話者ラベル＋空白＋本文）、`bodyStart` は本文の開始位置。
 */
const isPlainBlock = (block: string, bodyStart: number): boolean =>
    !/[\r\n<]/.test(block) && !FENCE_RUN.test(block) && !BLOCK_MARKER_AT_BODY_START.test(block.slice(bodyStart));

/**
 * 改行を含むブロックの続きの行は行頭に出る。そこでコードフェンス（``` / ~~~）や HTML ブロック（`<` 始まり: script / pre /
 * style / textarea / コメント等）が開くと、閉じるまで空行を越えて後続のブロックまで飲み込む（閉じなければ文末まで）。
 * その後の段落は行番号が文字列上は正しくても描画上は段落でないので、対応を確定できない。
 * 引用・箇条書き・見出し・表は空行で必ず終わるので後続には波及しない。判定は保守的（フェンス片はブロック内のどこにあっても真）。
 */
const mayLeakIntoFollowingBlocks = (block: string): boolean => {
    const [, ...continuationLines] = block.split(LINE_ENDING);
    if (continuationLines.length === 0) return false;
    return FENCE_RUN.test(block) || continuationLines.some((row) => /^[ \t]*</.test(row));
};

interface ParagraphRef {
    startSec: number;
    speaker: string | null;
    /** この段落に畳まれた `parsed.annotations` の添字 */
    annotationIndices: number[];
}

/**
 * 句 → 段落開始行。`toTranscriptMarkdown` の段落化規則（話者が変わったときだけ段落を分ける・段落は空行 1 行で区切る）を
 * 同じ入力に適用して段落列を得て、保存 Markdown を先頭から 1 文字ずつ照合しながら各段落ブロックの開始位置を確定し、
 * 開始行はその位置までの実際の行末の数から求める（算出値の推測ではなく、実際の文字列に対する検算）。
 * 照合が崩れた段落以降は対応を確定できないので付けない。
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
            lastEndSec = Math.max(lastEndSec, segment.endSec);
            continue;
        }
        current = { startSec: segment.startSec, speaker: segment.speaker, annotationIndices: [kept[k]] };
        paragraphs.push(current);
        lastEndSec = segment.endSec;
    }

    // 3) 保存 Markdown を先頭から照合する。ブロック = 時刻リンク＋話者ラベル＋空白＋句の連結（英数字の境目にだけ空白 1 個が
    //    入り得る）。ブロック間は空行 1 行、末尾のブロックは文末まで。開始行 = 1 + その位置より前にある行末の数
    //    （区切りも含めて実際の文字列で数えるので、本文末尾の CR が区切りの LF と CRLF に合流する場合も描画と一致する）。
    let offset = 0;
    let line = 1;
    for (let k = 0; k < paragraphs.length; k += 1) {
        const paragraph = paragraphs[k];
        const label = paragraph.speaker ? ` **${paragraph.speaker}**` : '';
        const prefix = `${formatTimestampLink(paragraph.startSec)}${label} `;
        if (!markdown.startsWith(prefix, offset)) break;
        let cursor = offset + prefix.length;
        let matched = true;
        for (const annotationIndex of paragraph.annotationIndices) {
            const { text } = chunk.annotations[annotationIndex];
            if (markdown.startsWith(text, cursor)) {
                cursor += text.length;
            } else if (markdown[cursor] === ' ' && markdown.startsWith(text, cursor + 1)) {
                cursor += 1 + text.length;
            } else {
                matched = false;
                break;
            }
        }
        if (!matched) break;
        const separator = k === paragraphs.length - 1 ? '' : BLOCK_SEPARATOR;
        if (separator === '' ? cursor !== markdown.length : !markdown.startsWith(separator, cursor)) break;

        const block = markdown.slice(offset, cursor);
        if (isPlainBlock(block, prefix.length)) {
            for (const annotationIndex of paragraph.annotationIndices) {
                const phraseIndex = parsed.annotations[annotationIndex]?.phraseIndex;
                if (typeof phraseIndex === 'number') lines.set(phraseIndex, line);
            }
        } else if (mayLeakIntoFollowingBlocks(block)) {
            // 後続の段落は描画上の段落であることを保証できない（B2: 対応が確定しない句にはアンカーを付けない）
            break;
        }
        const next = cursor + separator.length;
        line += countLineEndings(markdown.slice(offset, next));
        offset = next;
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

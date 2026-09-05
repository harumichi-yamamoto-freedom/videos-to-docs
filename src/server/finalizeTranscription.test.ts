import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { TranscriptAnnotation } from '@/lib/transcribeApiContract';
import {
    LOW_CONFIDENCE_THRESHOLD,
    REVIEW_MAX_JSON_BYTES,
    TRANSCRIPT_REVIEW_VERSION,
    type ReviewCandidate,
    type TranscriptReview,
} from '@/lib/transcriptReviewContract';
import type { ParsedBatch } from './azureBatchTranscribe';
import {
    buildTranscriptMarkdownFromBatch,
    buildTranscriptWithAnchors,
    DOCUMENT_OVERHEAD_HEADROOM_BYTES,
    FIRESTORE_MAX_DOCUMENT_BYTES,
    fitReviewToDocumentBudget,
    sourceTextHashOf,
    withParagraphAnchors,
} from './finalizeTranscription';
import { buildUnavailableReview } from './reviewCandidates';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: warnMock, info: vi.fn(), error: vi.fn() }) }));

/** 合成の句（架空の会話）。phraseIndex は元 recognizedPhrases の配列 index。 */
const phrase = (
    phraseIndex: number,
    text: string,
    startSec: number,
    endSec: number,
    speaker: string | null,
    extra: Partial<TranscriptAnnotation> = {},
): TranscriptAnnotation => ({ text, startSec, endSec, speaker, phraseIndex, ...extra });

const parsedOf = (annotations: TranscriptAnnotation[], patch: Partial<ParsedBatch> = {}): ParsedBatch => ({
    status: 'completed',
    text: annotations.map((a) => a.text ?? '').join('\n'),
    annotations,
    audioSec: 60,
    speakers: 2,
    droppedPhrases: 0,
    droppedAnnotations: [],
    ...patch,
});

const twoSpeakers = (): ParsedBatch => parsedOf([
    phrase(0, 'こんにちは。', 0.5, 2, 'spk:1'),
    phrase(1, '本日はよろしくお願いします。', 2, 4, 'spk:1'),
    phrase(2, 'こちらこそ。', 4.2, 5, 'spk:2'),
    phrase(3, 'では始めます。', 5.5, 7, 'spk:1'),
    phrase(4, '資料をご覧ください。', 7, 9, 'spk:1'),
]);

describe('buildTranscriptWithAnchors', () => {
    it('Markdown は buildTranscriptMarkdownFromBatch と同一（見た目の回帰なし）', () => {
        const parsed = twoSpeakers();
        expect(buildTranscriptWithAnchors(parsed).markdown).toBe(buildTranscriptMarkdownFromBatch(parsed));
    });

    it('同一話者の連続句は 1 段落に畳まれ、各句はその段落の開始行（1 始まり）に対応する', () => {
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(twoSpeakers());
        const lines = markdown.split('\n');
        // 段落は空行 1 行で区切られる: 1 行目 spk:1、3 行目 spk:2、5 行目 spk:1
        expect(lines).toHaveLength(5);
        expect(lines[0]).toBe('[00:00](#t=0) **spk:1** こんにちは。本日はよろしくお願いします。');
        expect(lines[1]).toBe('');
        expect(lines[2]).toBe('[00:04](#t=4) **spk:2** こちらこそ。');
        expect(lines[3]).toBe('');
        expect(lines[4]).toBe('[00:05](#t=5) **spk:1** では始めます。資料をご覧ください。');
        expect([...phraseLineByIndex.entries()]).toEqual([[0, 1], [1, 1], [2, 3], [3, 5], [4, 5]]);
    });

    it('話者ラベルの無い句も段落として対応する', () => {
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf([
            phrase(0, '話者なしの句', 0, 1, null),
            phrase(1, '続きの句', 1, 2, null),
        ], { speakers: 0 }));
        expect(markdown).toBe('[00:00](#t=0) 話者なしの句続きの句');
        expect([...phraseLineByIndex.entries()]).toEqual([[0, 1], [1, 1]]);
    });

    it('英数字の境目に空白が入る段落でも対応は段落開始行', () => {
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf([
            phrase(0, 'ABC', 0, 1, 'spk:1'),
            phrase(1, 'DEF', 1, 2, 'spk:1'),
        ]));
        expect(markdown).toBe('[00:00](#t=0) **spk:1** ABC DEF');
        expect([...phraseLineByIndex.entries()]).toEqual([[0, 1], [1, 1]]);
    });

    it('空の表示テキストの句も段落に属し対応を持つ（empty_text 候補の移動先）', () => {
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf([
            phrase(0, '', 0, 1, 'spk:1'),
            phrase(1, '本文', 1, 2, 'spk:2'),
        ]));
        expect(markdown.split('\n')[0]).toBe('[00:00](#t=0) **spk:1** ');
        expect([...phraseLineByIndex.entries()]).toEqual([[0, 1], [1, 3]]);
    });

    it('🔴 本文に改行を含む段落の句には対応を付けず、後続の段落の行番号はずらさない', () => {
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf([
            phrase(0, '一段落目。', 0, 1, 'spk:1'),
            phrase(1, '改行を\n含む句。', 1, 2, 'spk:2'),
            phrase(2, '三段落目。', 2, 3, 'spk:1'),
        ]));
        const lines = markdown.split('\n');
        // 2 段落目は 2 行（3・4 行目）。空行を挟んで 3 段落目は 6 行目
        expect(lines[2]).toBe('[00:01](#t=1) **spk:2** 改行を');
        expect(lines[3]).toBe('含む句。');
        expect(lines[4]).toBe('');
        expect(lines[5]).toBe('[00:02](#t=2) **spk:1** 三段落目。');
        expect([...phraseLineByIndex.entries()]).toEqual([[0, 1], [2, 6]]);
    });

    it('同一話者の連続句のどこかに改行があれば、その段落全体の句に対応を付けない', () => {
        const { phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf([
            phrase(0, '先頭。', 0, 1, 'spk:1'),
            phrase(1, '途中\n改行。', 1, 2, 'spk:1'),
            phrase(2, '次の話者。', 2, 3, 'spk:2'),
        ]));
        expect([...phraseLineByIndex.entries()]).toEqual([[2, 4]]);
    });

    it('phraseIndex の無い注釈は対応に入れない（他の句は付ける）', () => {
        const { phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf([
            { text: '旧形式の注釈', startSec: 0, endSec: 1, speaker: 'spk:1' },
            phrase(7, '新形式の句', 1, 2, 'spk:2'),
        ]));
        expect([...phraseLineByIndex.entries()]).toEqual([[7, 3]]);
    });

    it('結合で捨てられる句（中点がチャンク開始より前）は対応に入れず、残りの行は正しい', () => {
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf([
            phrase(0, '負の時刻の句', -5, -1, 'spk:1'),
            phrase(1, '有効な句', 0, 1, 'spk:1'),
        ]));
        expect(markdown).toBe('[00:00](#t=0) **spk:1** 有効な句');
        expect([...phraseLineByIndex.entries()]).toEqual([[1, 1]]);
    });

    it('注釈が無ければ空の Markdown と空の対応', () => {
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf([], { speakers: 0 }));
        expect(markdown).toBe('');
        expect(phraseLineByIndex.size).toBe(0);
    });

    it('多数の段落でも行番号が実際の行と一致する（検算）', () => {
        const annotations = Array.from({ length: 200 }, (_, i) => phrase(i, `句${i}。`, i, i + 1, `spk:${i % 3}`));
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(parsedOf(annotations, { speakers: 3 }));
        const lines = markdown.split('\n');
        expect(phraseLineByIndex.size).toBe(200);
        for (const [phraseIndex, line] of phraseLineByIndex) {
            expect(lines[line - 1]).toBe(`[${String(Math.floor(phraseIndex / 60)).padStart(2, '0')}:${String(phraseIndex % 60).padStart(2, '0')}](#t=${phraseIndex}) **spk:${phraseIndex % 3}** 句${phraseIndex}。`);
        }
    });

    it('アンカー算出の内部エラーは本文に影響させず、警告して対応なしにする（設計 B4）', () => {
        const poisoned = new Proxy(phrase(1, '句', 1, 2, 'spk:1'), {
            get: (target, key) => {
                if (key === 'phraseIndex') throw new Error('合成の内部エラー');
                return Reflect.get(target, key);
            },
        });
        const parsed = parsedOf([phrase(0, '先頭', 0, 1, 'spk:2'), poisoned]);
        const { markdown, phraseLineByIndex } = buildTranscriptWithAnchors(parsed);
        expect(markdown).toBe(buildTranscriptMarkdownFromBatch(parsed));
        expect(phraseLineByIndex.size).toBe(0);
        expect(warnMock).toHaveBeenCalledWith('段落アンカーの算出に失敗（本文は保存・アンカー無し）', { reason: '合成の内部エラー' });
    });
});

describe('sourceTextHashOf', () => {
    it('UTF-8 バイト列の SHA-256（hex）', () => {
        expect(sourceTextHashOf('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(sourceTextHashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(sourceTextHashOf('日本語\n')).toBe(createHash('sha256').update(Buffer.from('日本語\n', 'utf8')).digest('hex'));
    });

    it('改行 1 文字の違いでも一致しない（本文の厳密一致判定用）', () => {
        expect(sourceTextHashOf('本文')).not.toBe(sourceTextHashOf('本文\n'));
    });
});

const candidate = (phraseId: string, patch: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
    phraseId,
    reasons: ['low_confidence'],
    excerpt: `抜粋 ${phraseId}`,
    excerptTruncated: false,
    ...patch,
});

const reviewOf = (candidates: ReviewCandidate[], patch: Partial<TranscriptReview> = {}): TranscriptReview => ({
    version: TRANSCRIPT_REVIEW_VERSION,
    threshold: LOW_CONFIDENCE_THRESHOLD,
    sourceTextHash: 'f'.repeat(64),
    sourceJobId: 'synthetic-job',
    summary: {
        totalPhrases: 10,
        lowConfidence: candidates.length,
        recognitionFlagged: 0,
        candidateTotal: candidates.length,
        unknownConfidence: 0,
        unknownRecognitionStatus: 0,
        noTimeCandidates: 0,
        savedCandidates: candidates.length,
    },
    availability: 'complete',
    candidates,
    ...patch,
});

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('withParagraphAnchors', () => {
    it('対応のある候補にだけ paragraphStartLine を付け、順序・件数・他の項目は変えない', () => {
        const review = reviewOf([candidate('p0'), candidate('p1'), candidate('p2')]);
        const result = withParagraphAnchors(review, new Map([['p0', 1], ['p2', 5], ['p9', 7]]));
        expect(result.candidates.map((c) => c.paragraphStartLine)).toEqual([1, undefined, 5]);
        expect(result.candidates[1]).not.toHaveProperty('paragraphStartLine');
        expect(result.candidates.map((c) => c.phraseId)).toEqual(['p0', 'p1', 'p2']);
        expect(result.summary).toEqual(review.summary);
        expect(result.availability).toBe('complete');
        // 入力は変更しない
        expect(review.candidates[0]).not.toHaveProperty('paragraphStartLine');
    });
});

describe('fitReviewToDocumentBudget', () => {
    it('予算内なら内容そのまま（none）。undefined 値だけ落とす（Admin SDK は undefined を拒否する）', () => {
        const review = reviewOf([candidate('p0', { paragraphStartLine: 3, confidence: undefined })]);
        const fitted = fitReviewToDocumentBudget(review, 10_000);
        expect(fitted.adjustment).toBe('none');
        expect(fitted.review).toEqual(reviewOf([candidate('p0', { paragraphStartLine: 3 })]));
        expect(fitted.review?.candidates[0]).not.toHaveProperty('confidence');
        expect(JSON.stringify(fitted.review)).toBe(JSON.stringify(review));
    });

    it('🔴 アンカー込みで 128 KiB を超えるなら抽出側の規則で末尾候補を落とし partial にする（総件数とアンカーは保つ）', () => {
        // 抽出側の予算（アンカー無し）ちょうど 128 KiB に合わせ、アンカーを足すと超える形を作る
        const base = Array.from({ length: 100 }, (_, i) => candidate(`p${i}`, { excerpt: 'あ'.repeat(100), startSec: i, endSec: i + 1 }));
        const padding = REVIEW_MAX_JSON_BYTES - jsonBytes(reviewOf(base));
        expect(padding).toBeGreaterThan(0);
        const padded = reviewOf(base.map((c, i) => i === 0 ? { ...c, excerpt: c.excerpt + 'x'.repeat(padding) } : c));
        expect(jsonBytes(padded)).toBe(REVIEW_MAX_JSON_BYTES);
        const anchored = withParagraphAnchors(padded, new Map(base.map((c, i) => [c.phraseId, i * 2 + 1] as const)));
        expect(jsonBytes(anchored)).toBeGreaterThan(REVIEW_MAX_JSON_BYTES);

        const fitted = fitReviewToDocumentBudget(anchored, 10_000);
        expect(fitted.adjustment).toBe('trimmed');
        const saved = fitted.review!;
        expect(saved.availability).toBe('partial');
        expect(saved.candidates.length).toBeLessThan(100);
        expect(saved.candidates.length).toBeGreaterThan(0);
        expect(saved.summary.savedCandidates).toBe(saved.candidates.length);
        expect(saved.summary.candidateTotal).toBe(100);
        // 先頭からの並びを保ち、残った候補のアンカーは残る
        expect(saved.candidates.map((c) => c.phraseId)).toEqual(anchored.candidates.slice(0, saved.candidates.length).map((c) => c.phraseId));
        expect(saved.candidates.every((c) => typeof c.paragraphStartLine === 'number')).toBe(true);
        expect(jsonBytes(saved)).toBeLessThanOrEqual(REVIEW_MAX_JSON_BYTES);
    });

    it('unavailable はそのまま通す（summary(0) を complete に化けさせない）', () => {
        const unavailable = buildUnavailableReview('synthetic-job', 'f'.repeat(64), 'internal_error');
        expect(fitReviewToDocumentBudget(unavailable, 10_000)).toEqual({ review: unavailable, adjustment: 'none' });
    });

    it('本文＋候補＋見込みが Firestore 上限を超えるなら unavailable（storage_budget）。本文は切り詰めない', () => {
        const review = reviewOf([candidate('p0', { paragraphStartLine: 1 })]);
        const limit = FIRESTORE_MAX_DOCUMENT_BYTES - DOCUMENT_OVERHEAD_HEADROOM_BYTES;
        // ちょうど収まる
        expect(fitReviewToDocumentBudget(review, limit - jsonBytes(review)).adjustment).toBe('none');
        // 1 バイト超えると最小形へ
        const fitted = fitReviewToDocumentBudget(review, limit - jsonBytes(review) + 1);
        expect(fitted.adjustment).toBe('unavailable');
        expect(fitted.review).toEqual(buildUnavailableReview('synthetic-job', 'f'.repeat(64), 'storage_budget', LOW_CONFIDENCE_THRESHOLD));
    });

    it('最小形でも収まらなければ review 自体を省く（omitted）', () => {
        const review = reviewOf([candidate('p0')]);
        const fitted = fitReviewToDocumentBudget(review, FIRESTORE_MAX_DOCUMENT_BYTES - DOCUMENT_OVERHEAD_HEADROOM_BYTES);
        expect(fitted).toEqual({ review: undefined, adjustment: 'omitted' });
    });
});

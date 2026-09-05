import { describe, it, expect } from 'vitest';
import {
    applyReviewBudget,
    buildReviewCandidates,
    buildReviewCandidatesSafe,
    buildUnavailableReview,
    measureReviewJsonBytes,
    phraseIdFor,
    KNOWN_RECOGNITION_STATUSES,
    type ReviewPhraseInput,
} from './reviewCandidates';
import {
    LOW_CONFIDENCE_THRESHOLD,
    REVIEW_EXCERPT_MAX_CHARS,
    REVIEW_MAX_CANDIDATES,
    REVIEW_MAX_JSON_BYTES,
    TRANSCRIPT_REVIEW_VERSION,
} from '@/lib/transcriptReviewContract';

/**
 * 🔴 fixture は合成（架空）のみ。実顧客の発話・ジョブ ID・ハッシュは置かない。
 * 既定の句は「Success・confidence 0.9・時刻あり・話者あり」で、候補にならない健全な句。
 */
const JOB = 'job-synthetic-0001';
const HASH = 'f'.repeat(64);

const phrase = (index: number, overrides: Partial<ReviewPhraseInput> = {}): ReviewPhraseInput => ({
    index,
    text: `合成の発話 ${index} です。`,
    confidence: 0.9,
    recognitionStatus: 'Success',
    speaker: 'spk:1',
    startSec: index * 2,
    endSec: index * 2 + 1.5,
    ...overrides,
});

const build = (phrases: ReviewPhraseInput[], options?: Parameters<typeof buildReviewCandidates>[3]) =>
    buildReviewCandidates(phrases, JOB, HASH, options);

describe('buildReviewCandidates: 閾値境界', () => {
    it.each([
        [0, true],
        [0.5, true],
        [0.749, true],
        [0.7499999, true],
        [0.75, false],
        [0.76, false],
        [1, false],
    ])('confidence=%s → 低信頼候補=%s（0.75 ちょうどは含めない）', (confidence, expected) => {
        const review = build([phrase(0, { confidence })]);
        expect(review.availability).toBe('complete');
        expect(review.summary.lowConfidence).toBe(expected ? 1 : 0);
        expect(review.summary.candidateTotal).toBe(expected ? 1 : 0);
        expect(review.summary.unknownConfidence).toBe(0);
        if (expected) {
            expect(review.candidates[0]).toMatchObject({ phraseId: 'p0', reasons: ['low_confidence'], confidence });
        } else {
            expect(review.candidates).toEqual([]);
        }
    });

    it('閾値オプションを使い、使った閾値を記録する', () => {
        const review = build([phrase(0, { confidence: 0.85 })], { threshold: 0.9 });
        expect(review.threshold).toBe(0.9);
        expect(review.summary.lowConfidence).toBe(1);
        const byDefault = build([phrase(0, { confidence: 0.85 })]);
        expect(byDefault.threshold).toBe(LOW_CONFIDENCE_THRESHOLD);
        expect(byDefault.summary.lowConfidence).toBe(0);
    });

    it.each([1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY])('不正な閾値 %s は RangeError', (threshold) => {
        expect(() => build([phrase(0)], { threshold })).toThrow(RangeError);
    });
});

describe('buildReviewCandidates: confidence 不明', () => {
    it.each([
        ['欠損', undefined],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['負', -0.1],
        ['1 超', 1.5],
        ['文字列', '0.5' as unknown as number],
    ])('%s は不明として数え、候補にも 0 の低信頼にもしない', (_label, confidence) => {
        const review = build([phrase(0, { confidence })]);
        expect(review.summary.unknownConfidence).toBe(1);
        expect(review.summary.lowConfidence).toBe(0);
        expect(review.summary.candidateTotal).toBe(0);
        expect(review.candidates).toEqual([]);
        expect(review.availability).toBe('complete');
    });

    it('confidence も recognitionStatus も無い句は候補にせず、両方の不明に数える', () => {
        const review = build([phrase(0, { confidence: undefined, recognitionStatus: undefined })]);
        expect(review.summary).toMatchObject({
            totalPhrases: 1,
            unknownConfidence: 1,
            unknownRecognitionStatus: 1,
            candidateTotal: 0,
            lowConfidence: 0,
            recognitionFlagged: 0,
        });
        expect(review.candidates).toEqual([]);
    });
});

describe('buildReviewCandidates: 認識結果要確認', () => {
    const nonSuccess = [...KNOWN_RECOGNITION_STATUSES].filter((s) => s !== 'Success');

    it('既知の非 Success は全て把握している', () => {
        expect(nonSuccess).toEqual(['Failure', 'NoMatch', 'InitialSilenceTimeout', 'BabbleTimeout', 'Error']);
    });

    it.each(nonSuccess)('recognitionStatus=%s → recognition_status 候補（status を保持）', (recognitionStatus) => {
        const review = build([phrase(0, { recognitionStatus, text: '' })]);
        expect(review.summary.recognitionFlagged).toBe(1);
        expect(review.summary.lowConfidence).toBe(0);
        expect(review.summary.unknownRecognitionStatus).toBe(0);
        expect(review.candidates).toHaveLength(1);
        expect(review.candidates[0]).toMatchObject({ reasons: ['recognition_status'], recognitionStatus });
    });

    it('非 Success の句は confidence が低くても理由は recognition_status だけ（低信頼に数えない）', () => {
        const review = build([phrase(0, { recognitionStatus: 'NoMatch', confidence: 0.1 })]);
        expect(review.candidates[0].reasons).toEqual(['recognition_status']);
        expect(review.summary.lowConfidence).toBe(0);
        expect(review.summary.recognitionFlagged).toBe(1);
        expect(review.summary.candidateTotal).toBe(1);
    });

    it.each([['空文字', ''], ['空白のみ', ' \n\t ']])('Success だが text が%s → empty_text（excerpt は空・truncated=false）', (_label, text) => {
        const review = build([phrase(0, { text })]);
        expect(review.candidates).toHaveLength(1);
        expect(review.candidates[0]).toMatchObject({
            reasons: ['empty_text'],
            excerpt: '',
            excerptTruncated: false,
            recognitionStatus: 'Success',
        });
        expect(review.summary.recognitionFlagged).toBe(1);
        expect(review.summary.lowConfidence).toBe(0);
    });

    it('未知の recognitionStatus でも confidence が閾値未満なら low_confidence + unknown_confidence の候補', () => {
        const review = build([phrase(0, { recognitionStatus: 'SomethingNew', confidence: 0.5 })]);
        expect(review.candidates).toHaveLength(1);
        expect(review.candidates[0]).toMatchObject({
            reasons: ['low_confidence', 'unknown_confidence'],
            recognitionStatus: 'SomethingNew',
            confidence: 0.5,
        });
        expect(review.summary).toMatchObject({
            lowConfidence: 1,
            recognitionFlagged: 0,
            unknownRecognitionStatus: 1,
            candidateTotal: 1,
        });
    });

    it('recognitionStatus 欠落でも confidence が閾値未満なら候補（status キーは置かない）', () => {
        const review = build([phrase(0, { recognitionStatus: undefined, confidence: 0.2 })]);
        expect(review.candidates[0].reasons).toEqual(['low_confidence', 'unknown_confidence']);
        expect(review.candidates[0]).not.toHaveProperty('recognitionStatus');
        expect(review.summary.unknownRecognitionStatus).toBe(1);
    });

    it('未知の recognitionStatus で confidence が高い句は候補にしない（不明に数えるだけ）', () => {
        const review = build([phrase(0, { recognitionStatus: 'SomethingNew', confidence: 0.95 })]);
        expect(review.candidates).toEqual([]);
        expect(review.summary.unknownRecognitionStatus).toBe(1);
        expect(review.summary.candidateTotal).toBe(0);
    });

    it('未知の recognitionStatus・text 空・confidence 無しは判定材料が無いので候補にしない', () => {
        const review = build([phrase(0, { recognitionStatus: 'SomethingNew', text: '', confidence: undefined })]);
        expect(review.candidates).toEqual([]);
        expect(review.summary).toMatchObject({ unknownRecognitionStatus: 1, unknownConfidence: 1, candidateTotal: 0 });
    });

    it('recognitionStatus の前後空白は無視して既知値に合わせる', () => {
        const review = build([phrase(0, { recognitionStatus: ' NoMatch ' })]);
        expect(review.candidates[0]).toMatchObject({ reasons: ['recognition_status'], recognitionStatus: 'NoMatch' });
    });
});

describe('buildReviewCandidates: 複数理由と ID の和集合', () => {
    it('Success・text 空・confidence 低 → 候補 1 件に理由 2 つ', () => {
        const review = build([phrase(0, { text: '', confidence: 0.3 })]);
        expect(review.candidates).toHaveLength(1);
        expect(review.candidates[0].reasons).toEqual(['low_confidence', 'empty_text']);
        expect(review.summary).toMatchObject({
            totalPhrases: 1,
            lowConfidence: 1,
            recognitionFlagged: 1,
            candidateTotal: 1,
            savedCandidates: 1,
        });
    });

    it('候補総数はカテゴリの和ではなく ID の和集合', () => {
        const review = build([
            phrase(0, { confidence: 0.4 }),                 // 低信頼のみ
            phrase(1, { recognitionStatus: 'NoMatch' }),     // 認識結果のみ
            phrase(2, { text: '', confidence: 0.2 }),        // 両方
            phrase(3),                                       // 健全
        ]);
        expect(review.summary).toMatchObject({
            totalPhrases: 4,
            lowConfidence: 2,
            recognitionFlagged: 2,
            candidateTotal: 3,
            savedCandidates: 3,
        });
        expect(review.candidates.map((c) => c.phraseId)).toEqual(['p0', 'p1', 'p2']);
    });

    it('同じ index が二重に渡っても候補は 1 件（ID の和集合・保存数も 1）', () => {
        const review = build([phrase(5, { confidence: 0.1 }), phrase(5, { confidence: 0.2 })]);
        expect(review.summary.candidateTotal).toBe(1);
        expect(review.summary.savedCandidates).toBe(1);
        expect(review.candidates).toHaveLength(1);
        expect(review.candidates[0].confidence).toBe(0.1);
        expect(review.availability).toBe('complete');
    });
});

describe('buildReviewCandidates: 時刻', () => {
    it('有限かつ 0 <= start <= end の時刻だけ候補に持たせる', () => {
        const review = build([phrase(0, { confidence: 0.1, startSec: 12.5, endSec: 15 })]);
        expect(review.candidates[0]).toMatchObject({ startSec: 12.5, endSec: 15 });
        expect(review.summary.noTimeCandidates).toBe(0);
    });

    it('開始と終了が同じ（長さ 0）でも時刻として有効', () => {
        const review = build([phrase(0, { confidence: 0.1, startSec: 3, endSec: 3 })]);
        expect(review.candidates[0]).toMatchObject({ startSec: 3, endSec: 3 });
    });

    it.each([
        ['end 欠損', { startSec: 1, endSec: undefined }],
        ['start 欠損', { startSec: undefined, endSec: 1 }],
        ['両方欠損', { startSec: undefined, endSec: undefined }],
        ['start > end', { startSec: 5, endSec: 4 }],
        ['負の start', { startSec: -1, endSec: 4 }],
        ['NaN', { startSec: Number.NaN, endSec: 4 }],
        ['Infinity', { startSec: 1, endSec: Number.POSITIVE_INFINITY }],
    ])('%s の時刻は持たせず（0 にしない）、時刻不明候補に数える', (_label, time) => {
        const review = build([phrase(0, { confidence: 0.1, ...time })]);
        expect(review.candidates).toHaveLength(1);
        expect(review.candidates[0]).not.toHaveProperty('startSec');
        expect(review.candidates[0]).not.toHaveProperty('endSec');
        expect(review.summary.noTimeCandidates).toBe(1);
        expect(review.summary.candidateTotal).toBe(1);
    });

    it('audioSec が分かるとき、開始がそれを超える時刻は読めない扱い（0 や不正な audioSec は無視）', () => {
        const over = build([phrase(0, { confidence: 0.1, startSec: 500, endSec: 501 })], { audioSec: 100 });
        expect(over.candidates[0]).not.toHaveProperty('startSec');
        expect(over.summary.noTimeCandidates).toBe(1);

        const within = build([phrase(0, { confidence: 0.1, startSec: 99, endSec: 101 })], { audioSec: 100 });
        expect(within.candidates[0]).toMatchObject({ startSec: 99, endSec: 101 });

        for (const audioSec of [0, -5, Number.NaN]) {
            const ignored = build([phrase(0, { confidence: 0.1, startSec: 500, endSec: 501 })], { audioSec });
            expect(ignored.candidates[0]).toMatchObject({ startSec: 500, endSec: 501 });
        }
    });

    it('時刻あり候補を時刻昇順（同時刻は index 順）、その後に時刻なしを index 順で並べる', () => {
        const review = build([
            phrase(7, { confidence: 0.1, startSec: undefined, endSec: undefined }),
            phrase(3, { confidence: 0.1, startSec: 10, endSec: 11 }),
            phrase(9, { confidence: 0.1, startSec: 4, endSec: 5 }),
            phrase(2, { confidence: 0.1, startSec: undefined, endSec: undefined }),
            phrase(8, { confidence: 0.1, startSec: 4, endSec: 6 }),
            phrase(1, { confidence: 0.1, startSec: 4, endSec: 4.5 }),
        ]);
        expect(review.candidates.map((c) => c.phraseId)).toEqual(['p1', 'p8', 'p9', 'p3', 'p2', 'p7']);
        expect(review.summary.noTimeCandidates).toBe(2);
    });
});

describe('buildReviewCandidates: excerpt', () => {
    it('上限ちょうどは切らない・1 文字超えたら上限まで切って truncated=true', () => {
        const exact = 'あ'.repeat(REVIEW_EXCERPT_MAX_CHARS);
        const over = 'い'.repeat(REVIEW_EXCERPT_MAX_CHARS + 1);
        const review = build([phrase(0, { confidence: 0.1, text: exact }), phrase(1, { confidence: 0.1, text: over })]);
        expect(review.candidates[0]).toMatchObject({ excerpt: exact, excerptTruncated: false });
        expect(review.candidates[1].excerptTruncated).toBe(true);
        expect(Array.from(review.candidates[1].excerpt)).toHaveLength(REVIEW_EXCERPT_MAX_CHARS);
        expect(review.candidates[1].excerpt).toBe('い'.repeat(REVIEW_EXCERPT_MAX_CHARS));
    });

    it('サロゲートペアは 1 文字として数え、途中で割らない', () => {
        const emoji = '😀';
        const exact = emoji.repeat(REVIEW_EXCERPT_MAX_CHARS);
        const over = emoji.repeat(REVIEW_EXCERPT_MAX_CHARS + 1);
        const review = build([phrase(0, { confidence: 0.1, text: exact }), phrase(1, { confidence: 0.1, text: over })]);
        expect(review.candidates[0]).toMatchObject({ excerpt: exact, excerptTruncated: false });
        expect(review.candidates[1]).toMatchObject({ excerpt: exact, excerptTruncated: true });
    });

    it('前後の空白は抜粋から落とす', () => {
        const review = build([phrase(0, { confidence: 0.1, text: '  合成の発話です。  ' })]);
        expect(review.candidates[0].excerpt).toBe('合成の発話です。');
    });
});

describe('buildReviewCandidates: 候補の形', () => {
    it('取れなかった任意項目はキー自体を置かない（Firestore の undefined 拒否対策）・paragraphStartLine は付けない', () => {
        const review = build([
            phrase(4, {
                confidence: 0.1,
                recognitionStatus: undefined,
                speaker: undefined,
                startSec: undefined,
                endSec: undefined,
            }),
        ]);
        expect(review.candidates[0]).toStrictEqual({
            phraseId: 'p4',
            reasons: ['low_confidence', 'unknown_confidence'],
            excerpt: '合成の発話 4 です。',
            excerptTruncated: false,
            confidence: 0.1,
        });
        expect(Object.keys(review.candidates[0])).not.toContain('paragraphStartLine');
        expect(JSON.stringify(review)).not.toContain('paragraphStartLine');
    });

    it('取れた任意項目は全て持つ・speaker null は置かない', () => {
        const full = build([phrase(2, { confidence: 0.4, speaker: 'spk:3', startSec: 1, endSec: 2 })]);
        expect(full.candidates[0]).toStrictEqual({
            phraseId: 'p2',
            reasons: ['low_confidence'],
            excerpt: '合成の発話 2 です。',
            excerptTruncated: false,
            confidence: 0.4,
            recognitionStatus: 'Success',
            speaker: 'spk:3',
            startSec: 1,
            endSec: 2,
        });
        const noSpeaker = build([phrase(2, { confidence: 0.4, speaker: null })]);
        expect(noSpeaker.candidates[0]).not.toHaveProperty('speaker');
    });

    it('phraseId は index から決定的（同じ入力なら同じ出力・index は連番でなくてよい）', () => {
        const input = [phrase(12, { confidence: 0.1 }), phrase(40, { recognitionStatus: 'NoMatch' })];
        const a = build(input);
        const b = build(input.map((p) => ({ ...p })));
        expect(a).toStrictEqual(b);
        expect(a.candidates.map((c) => c.phraseId)).toEqual(['p12', 'p40']);
        expect(phraseIdFor(0)).toBe('p0');
    });

    it.each([-1, 1.5, Number.NaN, undefined as unknown as number])('index=%s は契約違反として TypeError', (index) => {
        expect(() => build([{ ...phrase(0, { confidence: 0.1 }), index }])).toThrow(TypeError);
    });

    it('version・threshold・sourceTextHash・sourceJobId を記録する', () => {
        const review = build([phrase(0)]);
        expect(review).toMatchObject({
            version: TRANSCRIPT_REVIEW_VERSION,
            threshold: LOW_CONFIDENCE_THRESHOLD,
            sourceTextHash: HASH,
            sourceJobId: JOB,
        });
        expect(review).not.toHaveProperty('unavailableReason');
    });
});

describe('buildReviewCandidates: 保存予算', () => {
    it('件数上限を超えたら先頭 REVIEW_MAX_CANDIDATES 件だけ保存し partial・総件数は全句の値を保つ', () => {
        const total = REVIEW_MAX_CANDIDATES + 50;
        const phrases = Array.from({ length: total }, (_, i) => phrase(i, { confidence: 0.1 }));
        const review = build(phrases);
        expect(review.availability).toBe('partial');
        expect(review.candidates).toHaveLength(REVIEW_MAX_CANDIDATES);
        expect(review.summary).toMatchObject({
            totalPhrases: total,
            lowConfidence: total,
            candidateTotal: total,
            savedCandidates: REVIEW_MAX_CANDIDATES,
        });
        // 時刻昇順の先頭 = index 0..199（fixture は index に比例した時刻）
        expect(review.candidates[0].phraseId).toBe('p0');
        expect(review.candidates[REVIEW_MAX_CANDIDATES - 1].phraseId).toBe(`p${REVIEW_MAX_CANDIDATES - 1}`);
    });

    it('JSON が REVIEW_MAX_JSON_BYTES を超えたら末尾から落として収める（partial・総件数は保つ）', () => {
        // 300 文字 × 3 バイトの抜粋 ≒ 1 KB/件。150 件で 128 KiB を超える。
        const total = 150;
        const phrases = Array.from({ length: total }, (_, i) =>
            phrase(i, { confidence: 0.1, text: '合'.repeat(REVIEW_EXCERPT_MAX_CHARS) }));
        const review = build(phrases);
        expect(review.availability).toBe('partial');
        expect(measureReviewJsonBytes(review)).toBeLessThanOrEqual(REVIEW_MAX_JSON_BYTES);
        expect(review.summary.savedCandidates).toBe(review.candidates.length);
        expect(review.summary.savedCandidates).toBeLessThan(total);
        expect(review.summary.savedCandidates).toBeGreaterThan(0);
        expect(review.summary.candidateTotal).toBe(total);
        // 1 件戻すと予算を超える（落とし過ぎていない）。戻す 1 件は実際に落とされた次の候補
        // （fixture は index から決定的なので予算なしで同じ形を組める）。
        const saved = review.summary.savedCandidates;
        const dropped = build([phrases[saved]]).candidates[0];
        expect(dropped.phraseId).toBe(`p${saved}`);
        const oneMore: typeof review = {
            ...review,
            summary: { ...review.summary, savedCandidates: saved + 1 },
            candidates: [...review.candidates, dropped],
        };
        expect(measureReviewJsonBytes(oneMore)).toBeGreaterThan(REVIEW_MAX_JSON_BYTES);
        // 残すのは並び順の先頭
        expect(review.candidates.map((c) => c.phraseId)).toEqual(
            Array.from({ length: review.summary.savedCandidates }, (_, i) => `p${i}`));
    });

    it('上限内なら全件保存で complete', () => {
        const phrases = Array.from({ length: 30 }, (_, i) => phrase(i, { confidence: 0.1 }));
        const review = build(phrases);
        expect(review.availability).toBe('complete');
        expect(review.summary.savedCandidates).toBe(30);
        expect(measureReviewJsonBytes(review)).toBeLessThanOrEqual(REVIEW_MAX_JSON_BYTES);
    });
});

describe('applyReviewBudget（永続化レーンがアンカーを補った後の再適用）', () => {
    const nearBudget = () =>
        build(Array.from({ length: 150 }, (_, i) =>
            phrase(i, { confidence: 0.1, text: '合'.repeat(REVIEW_EXCERPT_MAX_CHARS) })));

    it('paragraphStartLine を足して予算を超えた review を末尾から落として収める（総件数は保つ）', () => {
        const trimmed = nearBudget();
        const anchored = {
            ...trimmed,
            candidates: trimmed.candidates.map((c, i) => ({ ...c, paragraphStartLine: 1000 + i * 2 })),
        };
        // 前提: アンカー分のバイト増で上限を超えている（超えていなければこのテストの素材が弱い）
        expect(measureReviewJsonBytes(anchored)).toBeGreaterThan(REVIEW_MAX_JSON_BYTES);

        const reapplied = applyReviewBudget(anchored);
        expect(measureReviewJsonBytes(reapplied)).toBeLessThanOrEqual(REVIEW_MAX_JSON_BYTES);
        expect(reapplied.availability).toBe('partial');
        expect(reapplied.summary.savedCandidates).toBe(reapplied.candidates.length);
        expect(reapplied.summary.savedCandidates).toBeLessThan(trimmed.summary.savedCandidates);
        expect(reapplied.summary.candidateTotal).toBe(150);
        // 残すのは並び順の先頭。アンカーは保持される
        expect(reapplied.candidates.map((c) => c.phraseId)).toEqual(
            anchored.candidates.slice(0, reapplied.candidates.length).map((c) => c.phraseId));
        expect(reapplied.candidates.every((c) => typeof c.paragraphStartLine === 'number')).toBe(true);
        // 入力は変更しない
        expect(anchored.candidates).toHaveLength(trimmed.candidates.length);
        expect(anchored.summary.savedCandidates).toBe(trimmed.summary.savedCandidates);
    });

    it('予算内の review には何もしない（冪等）', () => {
        const review = build(Array.from({ length: 30 }, (_, i) => phrase(i, { confidence: 0.1 })));
        expect(applyReviewBudget(review)).toStrictEqual(review);
        const anchored = {
            ...review,
            candidates: review.candidates.map((c, i) => ({ ...c, paragraphStartLine: 1 + i * 2 })),
        };
        expect(applyReviewBudget(anchored)).toStrictEqual(anchored);
    });

    it('件数上限も再適用する', () => {
        const review = build(Array.from({ length: 30 }, (_, i) => phrase(i, { confidence: 0.1 })));
        const inflated = {
            ...review,
            summary: { ...review.summary, candidateTotal: REVIEW_MAX_CANDIDATES + 30 },
            candidates: Array.from({ length: REVIEW_MAX_CANDIDATES + 30 }, (_, i) => ({
                ...review.candidates[i % 30],
                phraseId: `p${i}`,
            })),
        };
        const reapplied = applyReviewBudget(inflated);
        expect(reapplied.candidates).toHaveLength(REVIEW_MAX_CANDIDATES);
        expect(reapplied.summary.savedCandidates).toBe(REVIEW_MAX_CANDIDATES);
        expect(reapplied.availability).toBe('partial');
    });

    it('unavailable はそのまま返す（summary(0) から complete に化けさせない）', () => {
        const review = buildUnavailableReview(JOB, HASH, 'storage_budget');
        expect(applyReviewBudget(review)).toBe(review);
        expect(applyReviewBudget(review).availability).toBe('unavailable');
    });
});

describe('buildReviewCandidates: availability', () => {
    it('句はあるが候補 0 件でも complete（素材はあった）', () => {
        const review = build([phrase(0), phrase(1), phrase(2)]);
        expect(review.availability).toBe('complete');
        expect(review.candidates).toEqual([]);
        expect(review.summary).toMatchObject({ totalPhrases: 3, candidateTotal: 0, savedCandidates: 0 });
        expect(review).not.toHaveProperty('unavailableReason');
    });

    it('句が 0 件なら unavailable（reason no_phrases）・使った閾値を記録', () => {
        const review = build([], { threshold: 0.8 });
        expect(review.availability).toBe('unavailable');
        expect(review.unavailableReason).toBe('no_phrases');
        expect(review.threshold).toBe(0.8);
        expect(review.candidates).toEqual([]);
        expect(review.summary.totalPhrases).toBe(0);
    });

    it('配列でない入力（実行時の壊れた値）も unavailable no_phrases', () => {
        const review = buildReviewCandidates(null as unknown as ReviewPhraseInput[], JOB, HASH);
        expect(review.availability).toBe('unavailable');
        expect(review.unavailableReason).toBe('no_phrases');
    });
});

describe('buildUnavailableReview', () => {
    it('最小形: version・threshold・hash・jobId・summary(0)・unavailable・reason・空 candidates', () => {
        const review = buildUnavailableReview(JOB, HASH, 'storage_budget');
        expect(review).toStrictEqual({
            version: TRANSCRIPT_REVIEW_VERSION,
            threshold: LOW_CONFIDENCE_THRESHOLD,
            sourceTextHash: HASH,
            sourceJobId: JOB,
            summary: {
                totalPhrases: 0,
                lowConfidence: 0,
                recognitionFlagged: 0,
                candidateTotal: 0,
                unknownConfidence: 0,
                unknownRecognitionStatus: 0,
                noTimeCandidates: 0,
                savedCandidates: 0,
            },
            availability: 'unavailable',
            unavailableReason: 'storage_budget',
            candidates: [],
        });
        expect(measureReviewJsonBytes(review)).toBeLessThan(1024);
    });

    it('閾値を指定できる', () => {
        expect(buildUnavailableReview(JOB, HASH, 'internal_error', 0.6).threshold).toBe(0.6);
    });
});

describe('buildReviewCandidatesSafe', () => {
    it('正常系は buildReviewCandidates と同じ結果', () => {
        const input = [phrase(0, { confidence: 0.1 }), phrase(1)];
        expect(buildReviewCandidatesSafe(input, JOB, HASH)).toStrictEqual(buildReviewCandidates(input, JOB, HASH));
    });

    it('内部で投げたら unavailable internal_error（本文完成を失敗させない）', () => {
        const badIndex = buildReviewCandidatesSafe(
            [{ ...phrase(0, { confidence: 0.1 }), index: undefined as unknown as number }], JOB, HASH);
        expect(badIndex.availability).toBe('unavailable');
        expect(badIndex.unavailableReason).toBe('internal_error');
        expect(badIndex.candidates).toEqual([]);

        const badThreshold = buildReviewCandidatesSafe([phrase(0)], JOB, HASH, { threshold: 2 });
        expect(badThreshold.availability).toBe('unavailable');
        expect(badThreshold.unavailableReason).toBe('internal_error');
        expect(badThreshold.threshold).toBe(LOW_CONFIDENCE_THRESHOLD);
    });
});

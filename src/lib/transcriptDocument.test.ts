import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    hashTranscriptText,
    hasTranscriptTimestampLinks,
    orderReviewCandidates,
    reviewAnchorsByLine,
    reviewCandidateStartSec,
    reviewHasPlayableTime,
    sha256Hex,
    shouldEnableTranscriptUi,
    shouldShowTranscriptReviewPanel,
} from './transcriptDocument';
import type { ReviewCandidate, TranscriptReview } from './transcriptReviewContract';

/** 合成の文字起こし本文（架空の会話） */
const TRANSCRIPT = [
    '[00:12](#t=12) **お客様** いえ、こちらこそ。',
    '',
    '[00:30](#t=30) **営業** 本日はお時間ありがとうございます。',
].join('\n');

/** 時刻リンクの無い通常の議事録 */
const ORDINARY = '# 商談メモ\n\n- 予算はおよそ1億2,000万円\n';

const candidate = (overrides: Partial<ReviewCandidate> & { phraseId: string }): ReviewCandidate => ({
    reasons: ['low_confidence'],
    excerpt: '抜粋',
    excerptTruncated: false,
    ...overrides,
});

const review = (overrides: Partial<TranscriptReview> = {}): TranscriptReview => ({
    version: 1,
    threshold: 0.75,
    sourceTextHash: 'deadbeef',
    sourceJobId: 'job-synthetic',
    summary: {
        totalPhrases: 3, lowConfidence: 1, recognitionFlagged: 0, candidateTotal: 1,
        unknownConfidence: 0, unknownRecognitionStatus: 0, noTimeCandidates: 0, savedCandidates: 1,
    },
    availability: 'complete',
    candidates: [candidate({ phraseId: 'p-0', startSec: 12.2, endSec: 14 })],
    ...overrides,
});

describe('候補の時刻（再生に使える開始秒）', () => {
    it('有限・0 以上・start ≤ end のときだけ返す', () => {
        expect(reviewCandidateStartSec({ startSec: 12.25, endSec: 14 })).toBe(12.25);
        expect(reviewCandidateStartSec({ startSec: 0, endSec: 0 })).toBe(0);
        expect(reviewCandidateStartSec({ startSec: 5 })).toBe(5);
    });

    it.each([
        ['startSec 無し', {}],
        ['負の秒', { startSec: -1, endSec: 3 }],
        ['NaN', { startSec: Number.NaN, endSec: 3 }],
        ['Infinity', { startSec: Number.POSITIVE_INFINITY }],
        ['end < start', { startSec: 10, endSec: 9 }],
        ['end が NaN', { startSec: 10, endSec: Number.NaN }],
        ['文字列', { startSec: '12' as unknown as number }],
    ])('%s は null（ゼロ秒に置き換えない）', (_label, value) => {
        expect(reviewCandidateStartSec(value as Partial<ReviewCandidate>)).toBeNull();
    });

    it('null / undefined は null', () => {
        expect(reviewCandidateStartSec(null)).toBeNull();
        expect(reviewCandidateStartSec(undefined)).toBeNull();
    });
});

describe('文字起こし UI の有効化（仕様 B3）', () => {
    it('🔴 本文に時刻リンクが無く review も無い文書は、音声があっても対象外（audioStoragePath を条件にしない）', () => {
        expect(shouldEnableTranscriptUi({ text: ORDINARY, audioStoragePath: 'audio/u/a.mp3' })).toBe(false);
        expect(hasTranscriptTimestampLinks({ text: ORDINARY })).toBe(false);
    });

    it('本文に時刻リンクがあれば review が無くても対象', () => {
        expect(shouldEnableTranscriptUi({ text: TRANSCRIPT })).toBe(true);
        expect(shouldEnableTranscriptUi({ transcription: TRANSCRIPT })).toBe(true);
    });

    it('🔴 本文編集で時刻リンクが全て消えても、review に有効な時刻の候補があれば再確認用に有効化する', () => {
        expect(shouldEnableTranscriptUi({ text: ORDINARY, transcriptReview: review() })).toBe(true);
        expect(reviewHasPlayableTime(review())).toBe(true);
    });

    it('review があっても有効な時刻の候補が無ければ有効化しない（音声があっても）', () => {
        const noTime = review({ candidates: [candidate({ phraseId: 'p-0' })] });
        expect(shouldEnableTranscriptUi({ text: ORDINARY, audioStoragePath: 'audio/u/a.mp3', transcriptReview: noTime })).toBe(false);
        const badTime = review({ candidates: [candidate({ phraseId: 'p-0', startSec: 10, endSec: 3 })] });
        expect(shouldEnableTranscriptUi({ text: ORDINARY, transcriptReview: badTime })).toBe(false);
        expect(shouldEnableTranscriptUi({ text: ORDINARY, transcriptReview: review({ candidates: [] }) })).toBe(false);
    });

    it('null / 本文なしは対象外（例外にしない）', () => {
        expect(shouldEnableTranscriptUi(null)).toBe(false);
        expect(shouldEnableTranscriptUi(undefined)).toBe(false);
        expect(shouldEnableTranscriptUi({})).toBe(false);
        expect(shouldEnableTranscriptUi({ transcriptReview: { candidates: 'broken' } as unknown as TranscriptReview })).toBe(false);
    });
});

describe('要確認パネルを置く文書か', () => {
    it('🔴 時刻リンクの無い通常の議事録には置かない（既存文書の見た目を変えない）', () => {
        expect(shouldShowTranscriptReviewPanel({ text: ORDINARY, audioStoragePath: 'audio/u/a.mp3' })).toBe(false);
    });

    it('review を持つ完成文書には置く（候補 0 件・unavailable でも）', () => {
        expect(shouldShowTranscriptReviewPanel({ text: ORDINARY, transcriptReview: review({ candidates: [] }) })).toBe(true);
        expect(shouldShowTranscriptReviewPanel({
            text: TRANSCRIPT,
            transcriptReview: review({ availability: 'unavailable', unavailableReason: 'no_phrases', candidates: [] }),
        })).toBe(true);
    });

    it('review の無い旧文書は、本文が文字起こし（時刻リンクあり）のときだけ置く', () => {
        expect(shouldShowTranscriptReviewPanel({ text: TRANSCRIPT })).toBe(true);
        expect(shouldShowTranscriptReviewPanel({ text: ORDINARY })).toBe(false);
    });

    it('処理中の仮本文には置かない', () => {
        expect(shouldShowTranscriptReviewPanel({ text: TRANSCRIPT, status: 'processing', transcriptReview: review() })).toBe(false);
        expect(shouldShowTranscriptReviewPanel(null)).toBe(false);
    });
});

describe('候補の表示順（時刻順・時刻なしは末尾・同時刻は元 index 順）', () => {
    it('保存順に依存せず並べ直し、中身は変えない', () => {
        const candidates = [
            candidate({ phraseId: 'late', startSec: 120, endSec: 121 }),
            candidate({ phraseId: 'no-time-b' }),
            candidate({ phraseId: 'early', startSec: 12, endSec: 13 }),
            candidate({ phraseId: 'no-time-a', startSec: -5 }),
            candidate({ phraseId: 'tie-2', startSec: 30, endSec: 31 }),
            candidate({ phraseId: 'tie-1', startSec: 30, endSec: 33 }),
        ];
        const ordered = orderReviewCandidates(candidates);
        expect(ordered.map(entry => entry.candidate.phraseId)).toEqual([
            'early', 'tie-2', 'tie-1', 'late', 'no-time-b', 'no-time-a',
        ]);
        expect(ordered.map(entry => entry.startSec)).toEqual([12, 30, 30, 120, null, null]);
        expect(ordered[0].candidate).toBe(candidates[2]);
    });

    it('配列でない／壊れた要素は落として例外にしない', () => {
        expect(orderReviewCandidates(undefined)).toEqual([]);
        expect(orderReviewCandidates('x' as unknown as ReviewCandidate[])).toEqual([]);
        const mixed = [null, { reasons: [] }, candidate({ phraseId: 'ok' })] as unknown as ReviewCandidate[];
        expect(orderReviewCandidates(mixed).map(entry => entry.candidate.phraseId)).toEqual(['ok']);
    });
});

describe('段落アンカー（開始行 → 候補 ID）', () => {
    it('生成時の paragraphStartLine だけを使い、無い候補は載せない', () => {
        const byLine = reviewAnchorsByLine([
            candidate({ phraseId: 'b', startSec: 30, paragraphStartLine: 3 }),
            candidate({ phraseId: 'a', startSec: 12, paragraphStartLine: 3 }),
            candidate({ phraseId: 'c', startSec: 40 }),
            candidate({ phraseId: 'd', paragraphStartLine: 0 }),
            candidate({ phraseId: 'e', paragraphStartLine: 2.5 }),
            candidate({ phraseId: 'f', paragraphStartLine: 7 }),
        ]);
        expect([...byLine.entries()]).toEqual([[3, ['a', 'b']], [7, ['f']]]);
    });
});

describe('本文ハッシュ（UTF-8 の SHA-256・hex）', () => {
    const nodeSha256 = (text: string): string =>
        createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

    const samples = [
        '',
        'a',
        '日本語\n',
        TRANSCRIPT,
        'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65),
        'あ'.repeat(119), 'あ'.repeat(120), 'あ'.repeat(1000),
        '改行\r\nと CRLF\r\n',
        '🙂 サロゲートペア',
    ];

    it('純 JS の実装はサーバ（node:crypto）と同じ値を返す（ブロック境界・多バイト文字を含む）', () => {
        for (const sample of samples) {
            expect(sha256Hex(sample)).toBe(nodeSha256(sample));
        }
        expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('hashTranscriptText もサーバと同じ値（crypto.subtle または純 JS）', async () => {
        for (const sample of samples) {
            await expect(hashTranscriptText(sample)).resolves.toBe(nodeSha256(sample));
        }
    });

    it('同じ本文は同じ Promise を返す（パネルと本文で二重計算しない）', () => {
        const first = hashTranscriptText('同じ本文');
        expect(hashTranscriptText('同じ本文')).toBe(first);
    });

    it('改行 1 文字の違いで値が変わる（厳密一致の判定用）', async () => {
        await expect(hashTranscriptText(TRANSCRIPT)).resolves.not.toBe(await hashTranscriptText(`${TRANSCRIPT}\n`));
    });
});

import { describe, expect, it } from 'vitest';
import {
    checkMergeInvariants,
    cutLineSec,
    expectedCoverageSec,
    formatGapNote,
    formatTimestamp,
    formatTimestampLink,
    maxSpeakersPerChunk,
    mergeTranscriptChunks,
    parseTimestampHref,
    parseTranscriptTimestamps,
    toAbsoluteSec,
    toTranscriptMarkdown,
    type MergeAnnotation,
    type MergeChunk,
    type MergedTranscript,
} from './transcriptMerge';

// ---------------------------------------------------------------------------
// 合成データ（人名・社名はすべて架空。実顧客の発話は一切使わない）
// ---------------------------------------------------------------------------

const annotation = (
    text: string,
    startOffsetSec: number,
    endOffsetSec: number,
    speaker: string | null,
): MergeAnnotation => ({ text, startOffsetSec, endOffsetSec, speaker });

/** 絶対秒からチャンク内オフセットへ（テスト側で fixture を組むための逆算） */
const offsetOf = (absoluteSec: number, chunk: { startSec: number; prefixSec: number }) =>
    absoluteSec - chunk.startSec + chunk.prefixSec;

/**
 * 3チャンク＋失敗1チャンクの標準 fixture。
 *   chunk0 本体 [0,150)   prefix 0
 *   chunk1 本体 [120,270) prefix 10  → 切断線 cut(0,1) = 135
 *   chunk2 本体 [240,390) prefix 4   → 切断線 cut(1,2) = 255
 *   chunk3 本体 [360,420) failed     → 切断線 cut(2,3) = 375
 * オーバーラップ区間の発話は、両側のチャンクに同じ内容で入っている（実際に両方が文字起こしする）。
 */
const buildStandardChunks = (): MergeChunk[] => {
    const c0 = { index: 0, startSec: 0, prefixSec: 0, endSec: 150 };
    const c1 = { index: 1, startSec: 120, prefixSec: 10, endSec: 270 };
    const c2 = { index: 2, startSec: 240, prefixSec: 4, endSec: 390 };

    // 切断線を跨ぐ発話。S1 は中点 132（線の手前）、S2 は中点ちょうど 135、S3 は中点 256
    const s1 = { text: 'そちらの資料は先ほどお送りしました', start: 128, end: 136, speaker: 'spk:0' };
    const s2 = { text: 'ありがとうございます、確認いたします', start: 130, end: 140, speaker: 'spk:1' };
    const s3 = { text: '御社の みらい工房 さんの事例ですね', start: 250, end: 262, speaker: 'spk:0' };
    // オーバーラップ内だが線を跨がない発話（chunk1 側に落ちる）
    const inner = { text: 'では次のページを', start: 240, end: 250, speaker: 'spk:1' };

    const abs = (chunk: { startSec: number; prefixSec: number }) => (item: typeof s1) =>
        annotation(item.text, offsetOf(item.start, chunk), offsetOf(item.end, chunk), item.speaker);

    return [
        {
            ...c0,
            annotations: [
                annotation('本日はお忙しい中ありがとうございます', 0, 6, 'spk:0'),
                annotation('いえ、こちらこそ', 12, 18, 'spk:1'),
                abs(c0)(s1),
                abs(c0)(s2),
            ],
        },
        {
            ...c1,
            annotations: [
                // プレフィックスとして先頭に連結した音声（結合時に破棄される）
                annotation('（話者プレフィックス spk:0）', 0, 4, 'spk:0'),
                annotation('（話者プレフィックス spk:1）', 5, 9, 'spk:1'),
                abs(c1)(s1),
                abs(c1)(s2),
                annotation('ランディ の画面をご覧ください', offsetOf(170, c1), offsetOf(180, c1), 'spk:0'),
                abs(c1)(inner),
                abs(c1)(s3),
            ],
        },
        {
            ...c2,
            annotations: [
                annotation('（話者プレフィックス spk:0）', 0, 4, 'spk:0'),
                abs(c2)(inner),
                abs(c2)(s3),
                annotation('お見積りは来週お出しします', offsetOf(300, c2), offsetOf(310, c2), 'spk:1'),
                annotation('よろしくお願いします', offsetOf(365, c2), offsetOf(372, c2), 'spk:0'),
            ],
        },
        { index: 3, startSec: 360, prefixSec: 0, endSec: 420, annotations: [], failed: true },
    ];
};

/** プレフィックスの罠を測るための最小 fixture（末尾ぎりぎりまで喋る） */
const buildPrefixProbeChunks = (): MergeChunk[] => {
    const c0 = { index: 0, startSec: 0, prefixSec: 0, endSec: 100 };
    const c1 = { index: 1, startSec: 90, prefixSec: 20, endSec: 200 };
    return [
        {
            ...c0,
            annotations: [
                annotation('はじめまして', 0, 2, 'spk:0'),
                annotation('よろしくお願いします', 95, 99, 'spk:1'),
            ],
        },
        {
            ...c1,
            annotations: [
                annotation('（話者プレフィックス）', 0, 8, 'spk:0'),
                annotation('本題に入ります', offsetOf(110, c1), offsetOf(115, c1), 'spk:0'),
                annotation('では失礼いたします', offsetOf(190, c1), offsetOf(199, c1), 'spk:1'),
            ],
        },
    ];
};

// ---------------------------------------------------------------------------
// 罠を踏んだ実装（この3つが「落ちる側」であることを固定する）
// ---------------------------------------------------------------------------

/** 罠1: プレフィックス長を引かずに絶対時刻へ直す */
const mergeWithoutPrefixSubtraction = (chunks: MergeChunk[]) =>
    mergeTranscriptChunks(
        chunks.map((chunk) => ({
            ...chunk,
            // 返却値をそのまま startSec に足す ＝ prefixSec の分だけ後ろへずれる
            annotations: chunk.annotations.map((a) => ({
                ...a,
                startOffsetSec: a.startOffsetSec + chunk.prefixSec,
                endOffsetSec: a.endOffsetSec + chunk.prefixSec,
            })),
        })),
    );

/** 罠3: チャンクを跨いで時刻を累積させる（オーバーラップを二重に数える） */
const mergeWithAccumulatedAnchor = (chunks: MergeChunk[]) => {
    let anchor = 0;
    const shifted = chunks.map((chunk) => {
        const sentLengthSec = chunk.prefixSec + ((chunk.endSec ?? 0) - chunk.startSec);
        const patched = { ...chunk, startSec: anchor };
        anchor += sentLengthSec - chunk.prefixSec;
        return patched;
    });
    return mergeTranscriptChunks(shifted);
};

type SimpleSegment = { text: string; startSec: number };

/**
 * 罠2a: start 基準。
 * チャンク N は「start が切断線より前」を、N+1 は「end が切断線より後」を採る。
 * → 切断線を跨ぐ発話は両側から採られて重複する。
 */
const mergeByStart = (chunks: MergeChunk[]): SimpleSegment[] => {
    const ordered = [...chunks].sort((a, b) => a.index - b.index);
    const out: SimpleSegment[] = [];
    ordered.forEach((chunk, i) => {
        if (chunk.failed) return;
        const lower = i > 0 ? cutLineSec(ordered[i - 1], chunk) : Number.NEGATIVE_INFINITY;
        const upper = ordered[i + 1] ? cutLineSec(chunk, ordered[i + 1]) : Number.POSITIVE_INFINITY;
        for (const a of chunk.annotations) {
            const startSec = toAbsoluteSec(a.startOffsetSec, chunk);
            const endSec = toAbsoluteSec(a.endOffsetSec, chunk);
            if ((startSec + endSec) / 2 < chunk.startSec) continue;
            if (startSec < upper && endSec > lower) out.push({ text: a.text, startSec });
        }
    });
    return out;
};

/**
 * 罠2b: end 基準。
 * チャンク N は「end が切断線より手前」を、N+1 は「start が切断線より後」を採る。
 * → 切断線を跨ぐ発話は両側から落ちて欠落する。
 */
const mergeByEnd = (chunks: MergeChunk[]): SimpleSegment[] => {
    const ordered = [...chunks].sort((a, b) => a.index - b.index);
    const out: SimpleSegment[] = [];
    ordered.forEach((chunk, i) => {
        if (chunk.failed) return;
        const lower = i > 0 ? cutLineSec(ordered[i - 1], chunk) : Number.NEGATIVE_INFINITY;
        const upper = ordered[i + 1] ? cutLineSec(chunk, ordered[i + 1]) : Number.POSITIVE_INFINITY;
        for (const a of chunk.annotations) {
            const startSec = toAbsoluteSec(a.startOffsetSec, chunk);
            const endSec = toAbsoluteSec(a.endOffsetSec, chunk);
            if ((startSec + endSec) / 2 < chunk.startSec) continue;
            if (endSec <= upper && startSec >= lower) out.push({ text: a.text, startSec });
        }
    });
    return out;
};

const countText = (segments: Array<{ text: string }>, text: string) =>
    segments.filter((s) => s.text === text).length;

// ---------------------------------------------------------------------------

describe('cutLineSec / expectedCoverageSec（切断線と尺）', () => {
    it('切断線はオーバーラップ区間の中点', () => {
        const [c0, c1, c2] = buildStandardChunks();
        expect(cutLineSec(c0, c1)).toBe(135);
        expect(cutLineSec(c1, c2)).toBe(255);
    });

    it('重なりが無ければ境界そのものが切断線', () => {
        const a: MergeChunk = { index: 0, startSec: 0, prefixSec: 0, endSec: 100, annotations: [] };
        const b: MergeChunk = { index: 1, startSec: 100, prefixSec: 0, endSec: 200, annotations: [] };
        expect(cutLineSec(a, b)).toBe(100);
    });

    it('期待カバー時間 ＝ Σチャンク長 − Σオーバーラップ − Σプレフィックス', () => {
        // 本体 150+150+150+60 = 510、プレフィックス 14、オーバーラップ 30×3 = 90
        expect(expectedCoverageSec(buildStandardChunks())).toBe(510 + 14 - 90 - 14);
        expect(expectedCoverageSec(buildStandardChunks())).toBe(420);
    });
});

describe('罠1: プレフィックス長を引いてから絶対時刻に直す', () => {
    it('返却値 − prefixSec + startSec が絶対時刻', () => {
        expect(toAbsoluteSec(18, { startSec: 120, prefixSec: 10 })).toBe(128);
        // 引き忘れると 138 になる（チャンクごとに違う量だけずれる）
        expect(toAbsoluteSec(18, { startSec: 120, prefixSec: 0 })).toBe(138);
    });

    it('プレフィックス区間の注釈は結合時に破棄される', () => {
        const merged = mergeTranscriptChunks([
            {
                index: 0,
                startSec: 600,
                prefixSec: 10,
                endSec: 700,
                annotations: [
                    annotation('（話者プレフィックス）', 0, 8, 'spk:0'),
                    annotation('お待たせしました', 12, 16, 'spk:0'),
                ],
            },
        ]);
        expect(merged.segments.map((s) => s.text)).toEqual(['お待たせしました']);
        expect(merged.segments[0].startSec).toBe(602);
    });

    it('正しい実装は絶対時刻が一致し、罠1 を踏んだ実装は prefixSec の分だけ後ろへずれる', () => {
        const chunks = buildStandardChunks();
        const merged = mergeTranscriptChunks(chunks);
        const good = merged.segments.find((s) => s.text === 'ランディ の画面をご覧ください');
        expect(good?.startSec).toBe(170);

        const bad = mergeWithoutPrefixSubtraction(chunks).segments.find(
            (s) => s.text === 'ランディ の画面をご覧ください',
        );
        expect(bad?.startSec).toBe(180); // chunk1 は +10
        const badChunk2 = mergeWithoutPrefixSubtraction(chunks).segments.find(
            (s) => s.text === 'お見積りは来週お出しします',
        );
        expect(badChunk2?.startSec).toBe(304); // chunk2 は +4 ＝ チャンクごとに違う量
    });

    it('罠1 を踏むと不変条件 (b) が落ち、踏まなければ通る', () => {
        const chunks = buildPrefixProbeChunks();
        const good = checkMergeInvariants(mergeTranscriptChunks(chunks), chunks);
        expect(good.ok).toBe(true);
        expect(good.coverageSec).toBe(199);
        expect(good.expectedCoverageSec).toBe(200);

        const bad = checkMergeInvariants(mergeWithoutPrefixSubtraction(chunks), chunks);
        expect(bad.ok).toBe(false);
        expect(bad.coverageSec).toBe(219); // 尺 200 を超える ＝ 時刻計算のバグ
        expect(bad.violations.join('\n')).toContain('(b)');
    });
});

describe('罠2: 採否は中点で判定する', () => {
    it('切断線を跨ぐ発話は、中点判定なら過不足なく1回だけ採られる', () => {
        const merged = mergeTranscriptChunks(buildStandardChunks());
        const texts = merged.segments.map((s) => s.text);
        expect(countText(merged.segments, 'そちらの資料は先ほどお送りしました')).toBe(1);
        expect(countText(merged.segments, 'ありがとうございます、確認いたします')).toBe(1);
        expect(countText(merged.segments, '御社の みらい工房 さんの事例ですね')).toBe(1);
        expect(countText(merged.segments, 'では次のページを')).toBe(1);
        expect(new Set(texts).size).toBe(texts.length); // 重複ゼロ
    });

    it('罠2a（start 基準）は切断線を跨ぐ発話を両側から採って重複させる', () => {
        const bad = mergeByStart(buildStandardChunks());
        expect(countText(bad, 'そちらの資料は先ほどお送りしました')).toBe(2);
        expect(countText(bad, 'ありがとうございます、確認いたします')).toBe(2);
        expect(countText(bad, '御社の みらい工房 さんの事例ですね')).toBe(2);
    });

    it('罠2b（end 基準）は切断線を跨ぐ発話を両側から落として欠落させる', () => {
        const bad = mergeByEnd(buildStandardChunks());
        expect(countText(bad, 'そちらの資料は先ほどお送りしました')).toBe(0);
        expect(countText(bad, 'ありがとうございます、確認いたします')).toBe(0);
        expect(countText(bad, '御社の みらい工房 さんの事例ですね')).toBe(0);
        // 線を跨がない発話は落ちない ＝ 欠落は「跨いだものだけ」
        expect(countText(bad, 'では次のページを')).toBe(1);
    });

    it('中点が切断線の手前なら N 側、ちょうど線上なら N+1 側（境界の対）', () => {
        const merged = mergeTranscriptChunks(buildStandardChunks());
        const before = merged.segments.find((s) => s.text === 'そちらの資料は先ほどお送りしました');
        const onLine = merged.segments.find((s) => s.text === 'ありがとうございます、確認いたします');
        expect(before?.chunkIndex).toBe(0); // 中点 132 < 135
        expect(onLine?.chunkIndex).toBe(1); // 中点 135 = 135
    });

    it('start と end はどちらも線の反対側にあり得る ＝ 中点でしか決まらない', () => {
        const merged = mergeTranscriptChunks(buildStandardChunks());
        const before = merged.segments.find((s) => s.text === 'そちらの資料は先ほどお送りしました');
        expect(before?.startSec).toBeLessThan(135);
        expect(before?.endSec).toBeGreaterThan(135); // end 基準なら chunk0 から落ちていた
    });
});

describe('罠3: チャンクを跨いで時刻を累積させない', () => {
    it('累積アンカーはオーバーラップを二重に数え、不変条件 (b) が落ちる', () => {
        const chunks = buildPrefixProbeChunks();
        expect(checkMergeInvariants(mergeTranscriptChunks(chunks), chunks).ok).toBe(true);

        const drifted = mergeWithAccumulatedAnchor(chunks);
        const result = checkMergeInvariants(drifted, chunks);
        expect(result.ok).toBe(false);
        expect(result.coverageSec).toBe(209); // chunk1 が オーバーラップ 10 秒ぶん後ろへ ＝ 尺 200 を超える
        expect(result.violations.join('\n')).toContain('(b)');
    });

    it('チャンク内の時刻は自分の startSec にアンカーされる（前のチャンクの長さに依らない）', () => {
        const late: MergeChunk = {
            index: 5,
            startSec: 7200,
            prefixSec: 6,
            endSec: 7500,
            annotations: [annotation('最後にご質問はありますか', 106, 112, 'spk:0')],
        };
        const merged = mergeTranscriptChunks([late]);
        expect(merged.segments[0].startSec).toBe(7300);
    });
});

describe('不変条件 (a)(b)(c)', () => {
    const chunks = buildStandardChunks();

    it('正しい結合結果はすべて通る', () => {
        const result = checkMergeInvariants(mergeTranscriptChunks(chunks), chunks);
        expect(result.violations).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it('(a) start が単調非減少でなければ落ちる', () => {
        const merged = mergeTranscriptChunks(chunks);
        const broken: MergedTranscript = {
            gaps: merged.gaps,
            segments: [merged.segments[3], merged.segments[1], ...merged.segments.slice(4)],
        };
        const result = checkMergeInvariants(broken, chunks);
        expect(result.ok).toBe(false);
        expect(result.violations.join('\n')).toContain('(a)');
    });

    it('(b) カバー時間が尺より大幅に短ければ落ちる / 許容内なら通る', () => {
        const merged = mergeTranscriptChunks(chunks);
        const head = merged.segments.filter((s) => s.startSec < 240); // 後半が丸ごと落ちた状態
        expect(checkMergeInvariants({ segments: head, gaps: [] }, chunks).ok).toBe(false);

        // 許容 120 秒ちょうどの下振れは通り、1 秒超えると落ちる（境界の対）
        const almost: MergedTranscript = {
            gaps: [],
            segments: [
                { text: 'A', startSec: 0, endSec: 1, speaker: 'spk:0', chunkIndex: 0 },
                { text: 'B', startSec: 299, endSec: 300, speaker: 'spk:0', chunkIndex: 2 },
            ],
        };
        expect(checkMergeInvariants(almost, chunks).ok).toBe(true); // 420 − 300 = 120
        const tooShort: MergedTranscript = {
            gaps: [],
            segments: [
                almost.segments[0],
                { ...almost.segments[1], startSec: 298, endSec: 299 },
            ],
        };
        expect(checkMergeInvariants(tooShort, chunks).ok).toBe(false); // 421 − 299 = 121
    });

    it('(b) は「総発話時間」ではない — 無音だらけでも通る', () => {
        const merged = mergeTranscriptChunks(chunks);
        const spokenSec = merged.segments.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
        const result = checkMergeInvariants(merged, chunks);
        expect(spokenSec).toBeLessThan(result.expectedCoverageSec / 5); // 発話時間 ≪ 尺
        expect(result.ok).toBe(true);
    });

    it('(c) 話者の異なり数がチャンク内最大を超えたら落ちる', () => {
        expect(maxSpeakersPerChunk(chunks)).toBe(2);
        const merged = mergeTranscriptChunks(chunks);
        expect(checkMergeInvariants(merged, chunks).speakerCount).toBe(2);

        const extra: MergedTranscript = {
            gaps: merged.gaps,
            segments: [
                ...merged.segments,
                { text: 'はい', startSec: 371, endSec: 372, speaker: 'spk:9', chunkIndex: 2 },
            ],
        };
        const result = checkMergeInvariants(extra, chunks);
        expect(result.ok).toBe(false);
        expect(result.violations.join('\n')).toContain('(c)');
    });
});

describe('時刻の表示形式', () => {
    it('1 時間未満は MM:SS、1 時間以上は H:MM:SS（境界の対）', () => {
        expect(formatTimestamp(0)).toBe('00:00');
        expect(formatTimestamp(12)).toBe('00:12');
        expect(formatTimestamp(3599)).toBe('59:59');
        expect(formatTimestamp(3600)).toBe('1:00:00');
        expect(formatTimestamp(4800)).toBe('1:20:00');
        expect(formatTimestamp(36000)).toBe('10:00:00');
    });

    it('秒は切り捨て、負値は 0 に丸める', () => {
        expect(formatTimestamp(12.9)).toBe('00:12');
        expect(formatTimestamp(-5)).toBe('00:00');
    });

    it('リンクは [表示](#t=秒) の形', () => {
        expect(formatTimestampLink(0)).toBe('[00:00](#t=0)');
        expect(formatTimestampLink(12.4)).toBe('[00:12](#t=12)');
        expect(formatTimestampLink(4800)).toBe('[1:20:00](#t=4800)');
    });
});

describe('Markdown 整形', () => {
    const segment = (text: string, startSec: number, endSec: number, speaker: string | null) => ({
        text,
        startSec,
        endSec,
        speaker,
        chunkIndex: 0,
    });

    it('話者が連続する間は1段落、変わったら段落を分ける', () => {
        const markdown = toTranscriptMarkdown(
            {
                gaps: [],
                segments: [
                    segment('本日はお忙しい中', 0, 3, 'spk:0'),
                    segment('ありがとうございます。', 3, 6, 'spk:0'),
                    segment('いえ、こちらこそ。', 12, 15, 'spk:1'),
                    segment('では始めます。', 20, 23, 'spk:0'),
                ],
            },
            { speakerLabels: { 'spk:0': '営業', 'spk:1': 'お客様' } },
        );
        expect(markdown).toBe(
            [
                '[00:00](#t=0) **営業** 本日はお忙しい中ありがとうございます。',
                '[00:12](#t=12) **お客様** いえ、こちらこそ。',
                '[00:20](#t=20) **営業** では始めます。',
            ].join('\n\n'),
        );
    });

    it('話者が付いていない発話はラベルを出さない / 未登録の話者 ID はそのまま出す', () => {
        const markdown = toTranscriptMarkdown({
            gaps: [],
            segments: [segment('えー、その、', 5, 7, null), segment('こちらです。', 9, 11, 'spk:3')],
        });
        expect(markdown).toBe('[00:05](#t=5) えー、その、\n\n[00:09](#t=9) **spk:3** こちらです。');
    });

    it('英数字どうしの境目にだけ空白を入れる（日本語は詰める）', () => {
        const markdown = toTranscriptMarkdown({
            gaps: [],
            segments: [
                segment('Landy', 0, 1, 'spk:0'),
                segment('Pro', 1, 2, 'spk:0'),
                segment('の話です', 2, 3, 'spk:0'),
            ],
        });
        expect(markdown).toBe('[00:00](#t=0) **spk:0** Landy Proの話です');
    });

    it('paragraphBreakGapSec を渡すと、同じ話者でも長い間があけば段落を分ける（境界の対）', () => {
        const segments = [segment('はい。', 0, 1, 'spk:0'), segment('続けます。', 4, 5, 'spk:0')];
        expect(toTranscriptMarkdown({ gaps: [], segments }, { paragraphBreakGapSec: 3 })).toBe(
            '[00:00](#t=0) **spk:0** はい。続けます。',
        );
        expect(toTranscriptMarkdown({ gaps: [], segments }, { paragraphBreakGapSec: 2.9 })).toBe(
            '[00:00](#t=0) **spk:0** はい。\n\n[00:04](#t=4) **spk:0** 続けます。',
        );
    });

    it('失敗チャンクはその位置に注記を入れる', () => {
        const note = formatGapNote({ chunkIndex: 3, startSec: 4800, endSec: 6300 });
        expect(note).toBe('　　　⚠ 1:20:00 〜 1:45:00 は文字起こしできませんでした。［再試行］');
        // 読みの流れを切らない方針: 赤や感嘆符で埋めない
        expect(note).not.toContain('!');
        expect(note).not.toContain('！');
    });

    it('注記は失敗区間の位置（前後の発話の間）に差し込まれる', () => {
        const markdown = toTranscriptMarkdown({
            gaps: [{ chunkIndex: 1, startSec: 100, endSec: 200 }],
            segments: [segment('前半です。', 10, 12, 'spk:0'), segment('後半です。', 210, 212, 'spk:0')],
        });
        expect(markdown.split('\n\n')).toEqual([
            '[00:10](#t=10) **spk:0** 前半です。',
            '　　　⚠ 01:40 〜 03:20 は文字起こしできませんでした。［再試行］',
            '[03:30](#t=210) **spk:0** 後半です。',
        ]);
    });

    it('末尾が失敗チャンクでも注記が落ちない', () => {
        const chunks = buildStandardChunks();
        const markdown = toTranscriptMarkdown(mergeTranscriptChunks(chunks), {
            speakerLabels: { 'spk:0': '営業', 'spk:1': 'お客様' },
        });
        const lines = markdown.split('\n\n');
        expect(lines[0]).toBe('[00:00](#t=0) **営業** 本日はお忙しい中ありがとうございます');
        expect(lines[lines.length - 1]).toBe(
            '　　　⚠ 06:15 〜 07:00 は文字起こしできませんでした。［再試行］',
        );
    });

    it('空の結合結果は空文字列', () => {
        expect(toTranscriptMarkdown({ segments: [], gaps: [] })).toBe('');
    });
});

describe('逆方向: Markdown から時刻を読む', () => {
    it('本文から #t= を拾う', () => {
        const markdown = toTranscriptMarkdown({
            gaps: [],
            segments: [
                { text: 'A', startSec: 0, endSec: 1, speaker: 'spk:0', chunkIndex: 0 },
                { text: 'B', startSec: 4800, endSec: 4801, speaker: 'spk:1', chunkIndex: 1 },
            ],
        });
        expect(parseTranscriptTimestamps(markdown).map((t) => t.sec)).toEqual([0, 4800]);
        expect(parseTranscriptTimestamps(markdown)[1].display).toBe('1:20:00');
    });

    it('利用者が壊した行は拾えないだけで例外にしない（読める行だけ返す）', () => {
        const edited = [
            '[00:00](#t=0) **営業** ここは無事です。',
            '[00:12](#t=) **お客様** 秒が消えた行。',
            '00:19 **営業** リンクごと消えた行。',
            '[00:25](#t=abc) **営業** 秒が数字でない行。',
            '[00:30(#t=30) **営業** 括弧が壊れた行。',
            '[00:40](#t=40) **営業** ここも無事です。',
        ].join('\n\n');
        expect(() => parseTranscriptTimestamps(edited)).not.toThrow();
        expect(parseTranscriptTimestamps(edited).map((t) => t.sec)).toEqual([0, 40]);
    });

    it('空文字列・非文字列でも例外にしない', () => {
        expect(parseTranscriptTimestamps('')).toEqual([]);
        expect(parseTranscriptTimestamps(undefined as unknown as string)).toEqual([]);
    });

    it('href 単体の解釈（components.a 用）— 読める側と読めない側の対', () => {
        expect(parseTimestampHref('#t=0')).toBe(0);
        expect(parseTimestampHref('#t=4800')).toBe(4800);
        expect(parseTimestampHref(' #t=12.5 ')).toBe(12.5);
        expect(parseTimestampHref('#t=')).toBeNull();
        expect(parseTimestampHref('#t=abc')).toBeNull();
        expect(parseTimestampHref('#t=-5')).toBeNull();
        expect(parseTimestampHref('https://example.com/#t=12')).toBeNull();
        expect(parseTimestampHref(null)).toBeNull();
        expect(parseTimestampHref(undefined)).toBeNull();
    });
});

/**
 * 🔴 フォールバックした区間を**本文に出す**ことの錠（設計 §3.7）。
 * ログにだけ残しても利用者には見えず、用語の表記が揺れている理由が分からない。
 */
describe('🔴 フォールバック区間の注記', () => {
    const merged = {
        segments: [
            { startSec: 0, endSec: 5, speaker: 'spk:0', text: '前半です。' },
            { startSec: 600, endSec: 605, speaker: 'spk:1', text: '後半です。' },
        ],
        gaps: [],
    } as unknown as Parameters<typeof toTranscriptMarkdown>[0];

    it('区間の開始位置に注記が入り、本文は残る', () => {
        const md = toTranscriptMarkdown(merged, {
            fallbackRanges: [{ startSec: 600, endSec: 1200 }],
        });
        expect(md).toContain('前半です。');
        expect(md).toContain('後半です。');
        expect(md).toContain('別の文字起こしサービスで処理しました');
        // 注記は後半の手前に出る
        expect(md.indexOf('別の文字起こし')).toBeLessThan(md.indexOf('後半です。'));
    });

    it('🔴 欠落の注記と文言を分ける — 「失敗した」と読ませない', () => {
        const md = toTranscriptMarkdown(merged, { fallbackRanges: [{ startSec: 600, endSec: 1200 }] });
        expect(md).not.toContain('文字起こしできませんでした');
        expect(md).toContain('用語集の表記が反映されていない場合があります');
    });

    it('🔴 最後のチャンクがフォールバックしても注記が消えない', () => {
        // 差し込みを「次の segment の手前」だけで行うと、末尾の区間で黙って落ちる
        const md = toTranscriptMarkdown(merged, {
            fallbackRanges: [{ startSec: 3000, endSec: 3600 }],
        });
        expect(md).toContain('別の文字起こしサービスで処理しました');
    });

    it('フォールバックが無ければ、注記は1つも出ない（既存の描画と同じ）', () => {
        const withOption = toTranscriptMarkdown(merged, { fallbackRanges: [] });
        const without = toTranscriptMarkdown(merged);
        expect(withOption).toBe(without);
        expect(withOption).not.toContain('別の文字起こしサービス');
    });

    it('複数区間を時刻順に出す', () => {
        const md = toTranscriptMarkdown(merged, {
            fallbackRanges: [{ startSec: 1200, endSec: 1800 }, { startSec: 600, endSec: 1200 }],
        });
        expect(md.indexOf('10:00')).toBeLessThan(md.indexOf('20:00'));
    });
});

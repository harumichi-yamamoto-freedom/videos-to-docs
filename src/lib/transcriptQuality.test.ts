import { describe, expect, it } from 'vitest';
import {
    DEFAULT_OUTPUT_TOKEN_LIMIT,
    MAX_COMPRESSION_RATIO,
    quarantineOutOfRangeAnnotations,
    OUTPUT_TOKEN_LIMIT_RATIO,
    compressionRatio,
    evaluateChunkQuality,
    maxConsecutiveRun,
    splitIntoUnits,
    type ChunkResult,
    type QualityGateId,
} from './transcriptQuality';
import {
    COLLAPSE_ALTERNATING_REPETITION,
    COLLAPSE_KUTEN_REPETITION,
    COLLAPSE_TOUTEN_REPETITION,
    NORMAL_LONG_TRANSCRIPT,
    NORMAL_OPERATIONS_TALK,
    NORMAL_SALES_TALK_VERBATIM,
    NORMAL_WRITTEN_STYLE,
    makeAnnotations,
    makeChunk,
} from './transcriptQuality.fixtures';

/** 実データで観測された正常な日本語文字起こしの圧縮率の域 (較正 2026-09-03) */
const REAL_NORMAL_COMPRESSION_RANGE = { min: 2.7, max: 3.2 };

/** 🔴 実データで正常と判定した走の最長連続ユニット (設計 §1.8: 話者分離＋単語タイムスタンプ / 1,023文字 / 圧縮率 2.48) */
const REAL_NORMAL_MAX_CONSECUTIVE = 6;

/** 🔴 実データで正常と判定した 30 分の走のカバレッジ (設計 §3.3 の長さ実測表) */
const REAL_NORMAL_MIN_COVERAGE = 0.938;

/** 発話 1 秒あたり 4.5 文字 (実データの正常域 4〜5.5 の中央) になる発話秒数を当てて、G6 を無関係にする */
const gateChunk = (text: string, overrides: Partial<ChunkResult> = {}): ChunkResult =>
    makeChunk(text, { audioSec: 600, speechSec: Math.max(1, text.length / 4.5), ...overrides });

const gatesOf = (chunk: ChunkResult, options = {}): QualityGateId[] =>
    evaluateChunkQuality(chunk, options).failedGates;

/** 警告だけのゲート。🔴 合格に丸めない — 「落ちない」と「何も言っていない」は別物 */
const warningsOf = (chunk: ChunkResult, options = {}): QualityGateId[] =>
    evaluateChunkQuality(chunk, options).warnedGates;

/**
 * 境界テスト用のユニット列。
 * distinct 文 と 2 種類の相槌を交互に置くので、同一ユニットは 1 度も連続しない (最長連続 1) =
 * G3 を無関係にしたままユニーク率だけを動かせる。
 * ユニット数 = distinctCount + fillerCount / ユニーク数 = distinctCount + min(fillerCount, 2)
 */
const makeUnitText = (distinctCount: number, fillerCount: number): string => {
    const fillers = ['まあ', 'ええと'];
    const units: string[] = [];
    let filled = 0;
    for (let index = 0; index < Math.max(distinctCount, fillerCount); index += 1) {
        if (index < distinctCount) units.push(`検討中の項目が${index}件あります`);
        if (filled < fillerCount) {
            units.push(fillers[filled % fillers.length]);
            filled += 1;
        }
    }
    return `${units.join('。')}。`;
};

const NORMAL_CHUNKS: Array<{ name: string; chunk: ChunkResult }> = [
    {
        name: '正常1 書き言葉寄り (1,115文字)',
        chunk: makeChunk(NORMAL_WRITTEN_STYLE, { audioSec: 300, speechSec: 240 }),
    },
    {
        name: '正常2 verbatim 相槌あり (2,179文字)',
        chunk: makeChunk(NORMAL_SALES_TALK_VERBATIM, { audioSec: 600, speechSec: 480 }),
    },
    {
        name: '正常3 運用体制の説明 (1,166文字)',
        chunk: makeChunk(NORMAL_OPERATIONS_TALK, { audioSec: 300, speechSec: 260 }),
    },
    {
        name: '正常4 長尺 (3,346文字)',
        chunk: makeChunk(NORMAL_LONG_TRANSCRIPT, { audioSec: 900, speechSec: 740 }),
    },
];

describe('splitIntoUnits (G3/G4 のユニット分割)', () => {
    it('🔴 読点でも割る — 句点だけで割ると読点区切りの反復が 1 ユニットになって全検査をすり抜ける', () => {
        expect(splitIntoUnits('ここ、ここ、ここ、')).toEqual(['ここ', 'ここ', 'ここ']);
    });

    it('改行でも割る (句読点の無い出力が 1 ユニットになるのを防ぐ)', () => {
        expect(splitIntoUnits('おはようございます\nよろしくお願いします')).toEqual([
            'おはようございます',
            'よろしくお願いします',
        ]);
    });

    it('句読点を除去してから比べる — 句点の有無だけが違う反復を同一ユニットとして数える', () => {
        expect(splitIntoUnits('ご視聴ありがとうございました。ご視聴ありがとうございました')).toEqual([
            'ご視聴ありがとうございました',
            'ご視聴ありがとうございました',
        ]);
    });

    it('空になったユニットは落とす', () => {
        expect(splitIntoUnits('。、\n 、。')).toEqual([]);
    });

    it('判定は完全一致のみ — 長い文が短い定型句を含んでいても同一ユニットにはしない', () => {
        // 2 本目は 1 本目を丸ごと含むが、完全一致ではないので連続反復には数えない
        const units = splitIntoUnits('はい\nはい承知しました\nはい承知しましたので進めます');
        expect(units).toEqual(['はい', 'はい承知しました', 'はい承知しましたので進めます']);
        expect(maxConsecutiveRun(units)).toBe(1);
    });
});

describe('正常ケース (陰性統制): 合成の商談テキストは G1〜G8 を全通過する', () => {
    for (const { name, chunk } of NORMAL_CHUNKS) {
        it(`${name} は 1 つも落ちない`, () => {
            const report = evaluateChunkQuality(chunk);
            expect(report.failures.map((finding) => `${finding.gate}: ${finding.reason}`)).toEqual([]);
            expect(report.warnedGates).toEqual([]);
            expect(report.passed).toBe(true);
            // 🔴 outputTokens を渡していないので G1 のトークン条件は「判定不能」として結果に現れる (合格に丸めない)
            expect(report.indeterminateGates).toEqual(['G1']);
        });
    }

    it('正常本文の実測値が、実データの正常域と同じ側に居る (最長連続 ≦ 6・ユニーク率 ≧ 0.6)', () => {
        for (const { name, chunk } of NORMAL_CHUNKS) {
            const { metrics } = evaluateChunkQuality(chunk);
            // 実データの正常最長連続は 6 (設計 §1.8 の構成B の走)。合成 fixture はそれより内側に居る
            expect(metrics.maxConsecutiveUnits, name).toBeLessThanOrEqual(REAL_NORMAL_MAX_CONSECUTIVE);
            expect(metrics.uniqueUnitRatio ?? 0, name).toBeGreaterThan(0.6);
        }
    });

    it('🔴 正常 fixture は 4〜5.5 文字/発話秒 の帯だけ — 判定保留の 0.86 文字/秒 帯を混ぜない', () => {
        // ⚠️ この値は**もう合否には使わない** (旧 G6・設計 §1.11 で分母が壊れていたことが判明)。
        //    fixture が実データの正常域と同じ側に居ることの確認としてだけ残す。
        for (const { name, chunk } of NORMAL_CHUNKS) {
            const { metrics } = evaluateChunkQuality(chunk);
            expect(metrics.charsPerSpeechSec ?? 0, name).toBeGreaterThanOrEqual(4);
            expect(metrics.charsPerSpeechSec ?? 0, name).toBeLessThanOrEqual(5.5);
        }
    });

    it('🔴 合成 fixture の圧縮率: 長尺だけが実データの正常域 2.70〜3.20 に入る。短いものは 2.1〜2.5 に落ちる', () => {
        const long = compressionRatio(NORMAL_LONG_TRANSCRIPT) ?? 0;
        expect(long).toBeGreaterThanOrEqual(REAL_NORMAL_COMPRESSION_RANGE.min);
        expect(long).toBeLessThanOrEqual(REAL_NORMAL_COMPRESSION_RANGE.max);

        // 短い合成本文は実データより圧縮されにくい側に外れる。閾値 8.0 までは遠いので判定は反転しない。
        expect(compressionRatio(NORMAL_WRITTEN_STYLE) ?? 0).toBeLessThan(REAL_NORMAL_COMPRESSION_RANGE.min);
        for (const { name, chunk } of NORMAL_CHUNKS) {
            expect(evaluateChunkQuality(chunk).metrics.compressionRatio ?? 0, name).toBeLessThan(
                MAX_COMPRESSION_RATIO,
            );
        }
    });
});

describe('崩壊ケース: すべて捕捉される', () => {
    it('G2: 空文字列', () => {
        const report = evaluateChunkQuality(makeChunk('', { audioSec: 1200, speechSec: 900 }));
        expect(report.passed).toBe(false);
        expect(report.failedGates).toContain('G2');
        expect(report.metrics.compressionRatio).toBeNull();
    });

    it('G2: 🔴 status は completed でも空なら落ちる (実測: 20分チャンクで 0 文字・エラーなし)', () => {
        const report = evaluateChunkQuality(makeChunk('', { status: 'completed', audioSec: 1200, speechSec: 900 }));
        expect(report.failedGates).toContain('G2');
        expect(report.failedGates).not.toContain('G1');
    });

    it('句点区切りの連続反復 (「はい。」×2,525) は G3 と G5 が捕まえる', () => {
        const report = evaluateChunkQuality(gateChunk(COLLAPSE_KUTEN_REPETITION));
        expect(report.passed).toBe(false);
        expect(report.failedGates).toContain('G3');
        expect(report.failedGates).toContain('G4');
        expect(report.failedGates).toContain('G5');
        expect(report.metrics.maxConsecutiveUnits).toBe(2525);
    });

    it('🔴 読点区切りの連続反復 (「ここ、」×6,488) を G3 が捕まえる', () => {
        const report = evaluateChunkQuality(gateChunk(COLLAPSE_TOUTEN_REPETITION));
        expect(report.failedGates).toContain('G3');
        expect(report.metrics.maxConsecutiveUnits).toBe(6488);
    });

    it('🔴 陰性統制: 同じ本文を「句点のみ」で割ると最長連続 1 になり G3 が見逃す (読点を入れる根拠)', () => {
        const kutenOnlyUnits = COLLAPSE_TOUTEN_REPETITION.split(/[。．\n]+/).filter((unit) => unit.length > 0);
        expect(kutenOnlyUnits).toHaveLength(1);
        expect(maxConsecutiveRun(kutenOnlyUnits)).toBe(1);
        // 読点を入れた実装なら 6,488 と数える
        expect(maxConsecutiveRun(splitIntoUnits(COLLAPSE_TOUTEN_REPETITION))).toBe(6488);
    });

    it('🔴 交互反復は G3 も G5 も素通りし、G4 だけが捕まえる (G3/G4 を片方だけにできない根拠)', () => {
        const report = evaluateChunkQuality(gateChunk(COLLAPSE_ALTERNATING_REPETITION));
        expect(report.passed).toBe(false);
        expect(report.failedGates).toEqual(['G4']);
        expect(report.metrics.maxConsecutiveUnits).toBe(1);
        expect(report.metrics.compressionRatio ?? 0).toBeLessThan(MAX_COMPRESSION_RATIO);
        expect(report.metrics.uniqueUnitRatio ?? 1).toBeLessThan(0.5);
    });

    it('🔴 打ち切り (音声の 67% までしか注釈が無い・status は completed) は G6 が捕まえる', () => {
        const audioSec = 1800;
        const report = evaluateChunkQuality(
            makeChunk(NORMAL_LONG_TRANSCRIPT, {
                status: 'completed',
                audioSec,
                speechSec: 740,
                annotations: makeAnnotations(audioSec, 0.67),
            }),
        );
        expect(report.passed).toBe(false);
        expect(report.failedGates).toEqual(['G6']);
        // 末尾 33% = 594 秒が注釈ゼロ。旧 G8 (端点カバレッジ) と違い、穴の長さそのものを見る
        expect(report.metrics.longestSilentGapSec ?? 0).toBeCloseTo(audioSec * 0.33, 3);
    });

    it('🔴 中抜け: 端点だけ見る旧 G8 が見逃した形を、G6 が捕まえる', () => {
        // 冒頭と末尾は起こしているが、真ん中 600 秒が空。旧 G8 のカバレッジは 0.995 で通ってしまう。
        const audioSec = 1800;
        const report = evaluateChunkQuality(
            makeChunk(NORMAL_LONG_TRANSCRIPT, {
                audioSec,
                speechSec: 1200,
                annotations: [
                    ...makeAnnotations(600, 1.0),
                    { text: '末尾', startOffsetSec: 1200, endOffsetSec: 1791, speaker: 'spk:1' },
                ],
            }),
        );
        expect(report.metrics.coverageRatio ?? 0).toBeGreaterThan(0.99); // 旧 G8 は通す
        expect(report.metrics.longestSilentGapSec ?? 0).toBeCloseTo(600, 3);
        expect(report.failedGates).toEqual(['G6']);
    });

    it('🔴 「文字数が多い＝正常」ではない: 崩壊本文は正常本文より長くても落ちる', () => {
        expect(COLLAPSE_KUTEN_REPETITION.length).toBeGreaterThan(NORMAL_LONG_TRANSCRIPT.length);
        expect(evaluateChunkQuality(gateChunk(COLLAPSE_KUTEN_REPETITION)).passed).toBe(false);
    });
});

describe('G1 (出力上限到達) の境界', () => {
    it('status が completed でなければ落ちる', () => {
        expect(gatesOf(gateChunk(NORMAL_LONG_TRANSCRIPT, { status: 'incomplete' }))).toContain('G1');
    });

    it('上限×0.98 ちょうどで落ち、その 1 トークン下では落ちない', () => {
        const ceiling = DEFAULT_OUTPUT_TOKEN_LIMIT * OUTPUT_TOKEN_LIMIT_RATIO; // 32,112.64
        expect(ceiling).toBeCloseTo(32112.64, 2);
        expect(gatesOf(gateChunk(NORMAL_LONG_TRANSCRIPT, { outputTokens: 32113 }))).toContain('G1');
        expect(gatesOf(gateChunk(NORMAL_LONG_TRANSCRIPT, { outputTokens: 32112 }))).not.toContain('G1');
    });

    it('🔴 outputTokens が取れないときは「判定不能」— 合格に丸めない', () => {
        for (const outputTokens of [undefined, 0]) {
            const report = evaluateChunkQuality(gateChunk(NORMAL_LONG_TRANSCRIPT, { outputTokens }));
            expect(report.indeterminateGates, String(outputTokens)).toContain('G1');
            expect(report.failedGates, String(outputTokens)).not.toContain('G1');
            const finding = report.findings.find((item) => item.gate === 'G1');
            expect(finding?.severity).toBe('indeterminate');
            expect(finding?.reason).toContain('model_invocation_token_counts');
        }
    });

    it('🔴 total_output_tokens は常に 0 を返す — 0 を渡しても検査が「通った」ことにはならない', () => {
        const report = evaluateChunkQuality(gateChunk(NORMAL_LONG_TRANSCRIPT, { outputTokens: 0 }));
        expect(report.metrics.outputTokenRatio).toBe(0);
        expect(report.indeterminateGates).toContain('G1');
    });

    it('outputTokens が undefined でも status だけで正しく落とせる', () => {
        const report = evaluateChunkQuality(
            gateChunk(NORMAL_LONG_TRANSCRIPT, { status: 'incomplete', outputTokens: undefined }),
        );
        expect(report.failedGates).toContain('G1');
        expect(report.passed).toBe(false);
        // 落ちた理由は status であり、トークン側は走っていないことも同時に現れる
        expect(report.findings.filter((item) => item.gate === 'G1').map((item) => item.severity)).toEqual([
            'fail',
            'indeterminate',
        ]);
    });
});

describe('G3 (最長連続ユニット) の境界', () => {
    const base = NORMAL_LONG_TRANSCRIPT;
    const withRun = (count: number) => `${base}\n${'そうですね。'.repeat(count)}`;

    it('20 回連続で落ち、19 回連続では落ちない', () => {
        expect(evaluateChunkQuality(gateChunk(withRun(20))).metrics.maxConsecutiveUnits).toBe(20);
        expect(evaluateChunkQuality(gateChunk(withRun(19))).metrics.maxConsecutiveUnits).toBe(19);
        expect(gatesOf(gateChunk(withRun(20)))).toContain('G3');
        expect(gatesOf(gateChunk(withRun(19)))).not.toContain('G3');
    });

    it('🔴 実データの正常サンプル (最長連続 6) は落ちない — 閾値 3 だとこれが偽陽性になる', () => {
        const chunk = gateChunk(withRun(REAL_NORMAL_MAX_CONSECUTIVE));
        expect(evaluateChunkQuality(chunk).metrics.maxConsecutiveUnits).toBe(6);
        expect(gatesOf(chunk)).not.toContain('G3');
        expect(gatesOf(chunk, { maxConsecutiveUnits: 3 })).toContain('G3');
    });

    it('読点で連続していても数える (「ここ、」×20 で落ちる)', () => {
        expect(gatesOf(gateChunk(`${base}\n${'ここ、'.repeat(20)}`))).toContain('G3');
        expect(gatesOf(gateChunk(`${base}\n${'ここ、'.repeat(19)}`))).not.toContain('G3');
    });
});

describe('G4 (ユニーク率) の境界', () => {
    it('0.49 で落ち、0.51 では落ちない', () => {
        const failing = gateChunk(makeUnitText(47, 53)); // 100 ユニット / ユニーク 49
        const passing = gateChunk(makeUnitText(49, 51)); // 100 ユニット / ユニーク 51
        expect(evaluateChunkQuality(failing).metrics.uniqueUnitRatio).toBeCloseTo(0.49, 6);
        expect(evaluateChunkQuality(passing).metrics.uniqueUnitRatio).toBeCloseTo(0.51, 6);
        expect(gatesOf(failing)).toContain('G4');
        expect(gatesOf(passing)).not.toContain('G4');
    });

    it('ちょうど 0.50 は落ちない (境界は「未満で不合格」)', () => {
        const chunk = gateChunk(makeUnitText(48, 52)); // 100 ユニット / ユニーク 50
        expect(evaluateChunkQuality(chunk).metrics.uniqueUnitRatio).toBeCloseTo(0.5, 6);
        expect(gatesOf(chunk)).not.toContain('G4');
    });

    it('40 ユニット未満では判定しない (39 で通り、40 で落ちる)', () => {
        const thirtyNine = gateChunk(makeUnitText(4, 35)); // 39 ユニット / ユニーク 6
        const forty = gateChunk(makeUnitText(4, 36)); // 40 ユニット / ユニーク 6
        expect(evaluateChunkQuality(thirtyNine).metrics.unitCount).toBe(39);
        expect(evaluateChunkQuality(forty).metrics.unitCount).toBe(40);
        expect(gatesOf(thirtyNine)).not.toContain('G4');
        expect(gatesOf(forty)).toContain('G4');
    });
});

describe('G5 (圧縮率) の境界', () => {
    it('閾値ちょうどでは落ちず、わずかに下げると落ちる (境界は「超えたら不合格」)', () => {
        const chunk = gateChunk(NORMAL_LONG_TRANSCRIPT);
        const ratio = evaluateChunkQuality(chunk).metrics.compressionRatio ?? 0;
        expect(gatesOf(chunk, { maxCompressionRatio: ratio })).not.toContain('G5');
        expect(gatesOf(chunk, { maxCompressionRatio: ratio - 0.0001 })).toContain('G5');
    });

    it('🔴 Whisper 既定の 2.4 を持ち込むと、正常 4 件のうち圧縮率 2.4 超のものが全部偽陽性になる', () => {
        const overTwoFour = NORMAL_CHUNKS.filter(
            ({ chunk }) => (evaluateChunkQuality(chunk).metrics.compressionRatio ?? 0) > 2.4,
        );
        expect(overTwoFour.length).toBeGreaterThan(0);
        for (const { name, chunk } of overTwoFour) {
            expect(gatesOf(chunk, { maxCompressionRatio: 2.4 }), name).toContain('G5');
            expect(gatesOf(chunk), name).not.toContain('G5');
        }
    });
});

describe('G6 (最長穴) の境界', () => {
    const audioSec = 600;
    /** 全域が発話で、注釈が [0, covered] を隙間なく覆うチャンク */
    const withGapAtTail = (covered: number) =>
        makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechSec: audioSec,
            speechIntervals: [[0, audioSec]],
            annotations: covered > 0 ? makeAnnotations(covered, 1.0) : [],
        });

    it('ちょうど 30 秒では落ちず、それを超えると落ちる', () => {
        expect(evaluateChunkQuality(withGapAtTail(570)).metrics.longestSilentGapSec).toBeCloseTo(30, 6);
        expect(gatesOf(withGapAtTail(570))).not.toContain('G6');
        expect(gatesOf(withGapAtTail(569))).toContain('G6');
    });

    it('🔴 実測の正常最悪 (43 秒の穴) は落ち、10 分チャンクの実測最悪 (24 秒) は落ちない', () => {
        // 117 走の実測: 15 分以上で 37〜43 秒の穴が出る / 10 分チャンクは全走 24 秒以内 (設計 §1.11)
        expect(gatesOf(withGapAtTail(audioSec - 43))).toContain('G6');
        expect(gatesOf(withGapAtTail(audioSec - 24))).not.toContain('G6');
    });

    it('🔴 分母に発話秒の総量を使わない — 無音を発話と誤認しても判定が反転しない', () => {
        // VAD が音声全体を「発話」と誤認したケース。実際の発話は [0,200] だけで、注釈もそこを覆っている。
        // 旧 G6 (文字数 ÷ 発話秒数) なら分母 600 で偽陽性になったが、穴が無いので落ちない。
        const chunk = makeChunk(NORMAL_WRITTEN_STYLE, {
            audioSec,
            speechSec: audioSec,
            speechIntervals: [[0, 200]],
            annotations: makeAnnotations(200, 1.0),
        });
        expect(chunk.text.length / chunk.speechSec).toBeLessThan(2); // 旧 G6 の値は警告域
        expect(evaluateChunkQuality(chunk).metrics.longestSilentGapSec).toBeCloseTo(0, 6);
        expect(gatesOf(chunk)).not.toContain('G6');
    });

    it('🔴 発話の合間の無音は穴に数えない — 商談の長い沈黙で偽陽性を出さない', () => {
        // 音声 600 秒のうち発話は [0,100] と [500,600] だけ。その間の 400 秒は無音であって脱落ではない。
        const chunk = makeChunk(NORMAL_WRITTEN_STYLE, {
            audioSec,
            speechSec: 200,
            speechIntervals: [[0, 100], [500, 600]],
            annotations: [
                ...makeAnnotations(100, 1.0),
                { text: '後半', startOffsetSec: 500, endOffsetSec: 600, speaker: 'spk:1' },
            ],
        });
        expect(evaluateChunkQuality(chunk).metrics.longestSilentGapSec).toBeCloseTo(0, 6);
        expect(gatesOf(chunk)).not.toContain('G6');
    });

    it('重なり合う注釈でも穴を過大に数えない (併合してから走査する)', () => {
        const chunk = makeChunk(NORMAL_WRITTEN_STYLE, {
            audioSec: 100,
            speechSec: 100,
            speechIntervals: [[0, 100]],
            annotations: [
                { text: 'a', startOffsetSec: 0, endOffsetSec: 60, speaker: 'spk:0' },
                { text: 'b', startOffsetSec: 10, endOffsetSec: 100, speaker: 'spk:1' },
            ],
        });
        expect(evaluateChunkQuality(chunk).metrics.longestSilentGapSec).toBeCloseTo(0, 6);
    });

    it('🔴 発話区間が渡されなければ「判定不能」— 合格に丸めない', () => {
        const chunk = makeChunk(NORMAL_WRITTEN_STYLE, { audioSec: 300, speechSec: 240 });
        delete (chunk as { speechIntervals?: unknown }).speechIntervals;
        const report = evaluateChunkQuality(chunk);
        expect(report.metrics.longestSilentGapSec).toBeNull();
        expect(report.indeterminateGates).toContain('G6');
        expect(report.failedGates).not.toContain('G6');
        expect(report.warnedGates).not.toContain('G6');
    });
});

describe('G7 (話者の妥当性) — 🔴 warn 止まり', () => {
    const audioSec = 600;
    const withSpeakers = (speakers: Array<string | null>) =>
        makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec, speechSec: 740,
            annotations: makeAnnotations(audioSec, 0.99, speakers),
        });

    it('話者分離 ON で 1 種類しか居なければ警告し、2 種類なら警告しない', () => {
        expect(warningsOf(withSpeakers(['spk:0']))).toContain('G7');
        expect(warningsOf(withSpeakers(['spk:0', 'spk:1']))).not.toContain('G7');
    });

    it('🔴 本文ごと捨てない — 話者ラベルはメタデータであって本文ではない', () => {
        // 実測: Gemini は 10 分窓 9 走中 3 走で話者を 1 名も返さない。fail のままだと
        // MAI から Gemini へフォールバックしたチャンクの約 3 割がゲートで捨てられ、
        // フォールバックが用をなさない（設計 §3.7）
        const report = evaluateChunkQuality(withSpeakers(['spk:0']));
        expect(report.failedGates).not.toContain('G7');
        expect(report.passed).toBe(true);
        expect(report.findings.find(f => f.gate === 'G7')?.severity).toBe('warn');
    });

    it('話者分離 OFF (speaker が null) では判定しない', () => {
        const chunk = withSpeakers([null]);
        expect(evaluateChunkQuality(chunk).metrics.speakerCount).toBe(0);
        expect(warningsOf(chunk)).not.toContain('G7');
        // 有効だと明示したときだけ警告する (話者分離を単独指定すると注釈に speaker が付かない実測がある)
        expect(warningsOf(chunk, { diarizationEnabled: true })).toContain('G7');
    });
});

describe('G8 (範囲外時刻) の境界', () => {
    const audioSec = 1000;

    /** n 本のうち bad 本だけ時刻が範囲外のチャンク */
    const withOutOfRange = (bad: number, total = 200) =>
        makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechSec: audioSec,
            speechIntervals: [[0, audioSec]],
            annotations: [
                ...makeAnnotations(audioSec, 1.0, ['spk:0', 'spk:1'], total - bad),
                ...Array.from({ length: bad }, (_, i) => ({
                    text: `暴走${i}`,
                    startOffsetSec: 70000 + i,
                    endOffsetSec: 70001 + i,
                    speaker: 'spk:0' as string | null,
                })),
            ],
        });

    it('🔴 数本だけの暴走は走を落とさず、その注釈を隔離する (warn で必ず記録に残る)', () => {
        // 実測 (2,365 本中 58 本 = 2.5% が最悪) より内側。本文は良好なので捨てない。
        const report = evaluateChunkQuality(withOutOfRange(1), { timestampsEnabled: true });
        expect(report.metrics.outOfRangeAnnotationCount).toBe(1);
        expect(report.failedGates).not.toContain('G8');
        expect(report.warnedGates).toContain('G8');
        expect(report.passed).toBe(true);
    });

    it('🔴 回帰: 良好な本文が壊れた注釈 1 本で落ちない — 旧 G8 はこれを落としていた', () => {
        // 実測: 取りこぼしゼロ・最長穴 5 秒・11,486 文字の走が、注釈 1 本のせいで
        // coverage = 85,581 になり不合格になっていた (設計 §4.1)。
        const report = evaluateChunkQuality(withOutOfRange(1), { timestampsEnabled: true });
        expect(report.metrics.coverageRatio ?? 0).toBeGreaterThan(70); // 旧 G8 なら即不合格の値
        expect(report.metrics.longestSilentGapSec ?? 99).toBeLessThan(30);
        expect(report.failedGates).toEqual([]);
    });

    it('境界: ちょうど 1% は通り、それを超えると落ちる', () => {
        expect(evaluateChunkQuality(withOutOfRange(2, 200), { timestampsEnabled: true }).failedGates)
            .not.toContain('G8');
        expect(evaluateChunkQuality(withOutOfRange(3, 200), { timestampsEnabled: true }).failedGates)
            .toContain('G8');
    });

    it('🔴 時刻の並びごと壊れていれば落とす (全件が範囲外)', () => {
        const report = evaluateChunkQuality(withOutOfRange(200, 200), { timestampsEnabled: true });
        expect(report.failedGates).toContain('G8');
    });

    it('注釈が 0 本のとき: 既定では判定しないが、時刻有効と明示すれば落ちる', () => {
        const chunk = makeChunk(NORMAL_LONG_TRANSCRIPT, { audioSec, speechSec: 740, annotations: [] });
        expect(gatesOf(chunk)).not.toContain('G8');
        expect(gatesOf(chunk, { timestampsEnabled: true })).toContain('G8');
    });

    it('境界: end_offset が音声長 × 1.05 ちょうどなら範囲外に数えない', () => {
        const at = makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechIntervals: [[0, audioSec]],
            annotations: [{ text: '末', startOffsetSec: 0, endOffsetSec: audioSec * 1.05, speaker: 'spk:0' }],
        });
        expect(evaluateChunkQuality(at, { timestampsEnabled: true }).metrics.outOfRangeAnnotationCount).toBe(0);
    });
});

describe('🔴 隔離 (quarantineOutOfRangeAnnotations) は本文に触らない', () => {
    it('範囲外の注釈だけ落とし、残りはそのまま返す', () => {
        const annotations = [
            { text: '正', startOffsetSec: 0, endOffsetSec: 10, speaker: 'spk:0' },
            { text: '暴走', startOffsetSec: 5, endOffsetSec: 70709.9, speaker: 'spk:1' },
        ];
        const { kept, removed } = quarantineOutOfRangeAnnotations(annotations, 1800);
        expect(kept.map((a) => a.text)).toEqual(['正']);
        expect(removed.map((a) => a.text)).toEqual(['暴走']);
    });

    it('音声長が不明 (0 以下) なら 1 本も落とさない — 判定できないときに黙って捨てない', () => {
        const annotations = [{ text: '正', startOffsetSec: 0, endOffsetSec: 10, speaker: null }];
        expect(quarantineOutOfRangeAnnotations(annotations, 0).removed).toEqual([]);
        expect(quarantineOutOfRangeAnnotations(annotations, 0).kept).toHaveLength(1);
    });
});

describe('レポートの形', () => {
    it('落ちたゲートと、判定に使った実測値の両方を返す (再試行の判断とログに使う)', () => {
        const report = evaluateChunkQuality(gateChunk(COLLAPSE_KUTEN_REPETITION));
        expect(report.failedGates).toEqual(report.failures.map((failure) => failure.gate));
        for (const failure of report.failures) {
            expect(failure.reason.length).toBeGreaterThan(0);
            expect(failure.threshold).toBeDefined();
        }
        expect(report.metrics.charCount).toBe(COLLAPSE_KUTEN_REPETITION.length);
        expect(report.metrics.unitCount).toBe(2525);
        expect(report.metrics.uniqueUnitCount).toBe(1);
    });

    it('最初の失敗で打ち切らず、当てはまるゲートを全部返す', () => {
        const report = evaluateChunkQuality(
            makeChunk(COLLAPSE_KUTEN_REPETITION, {
                status: 'incomplete',
                audioSec: 1200,
                speechSec: 1000,
                speechIntervals: [[0, 1200]],
                annotations: makeAnnotations(1200, 0.5, ['spk:0']),
            }),
        );
        // 注釈は音声の 50% までしか無い = 末尾 600 秒が穴 (G6)。
        expect(report.failedGates).toEqual(['G1', 'G3', 'G4', 'G5', 'G6']);
        // 🔴 話者 1 種類は warn。不合格の一覧に混ぜない（本文ごと捨てる理由にはならない）
        expect(report.warnedGates).toContain('G7');
    });
});

describe('🔴 時刻の暴走は G8 だけが見つける (G1〜G7 は全部通す)', () => {
    // 実測 (2026-09-03): 30分(1,800秒)の音声で最終注釈が 70,710秒 / 102,081秒 になる走があった。
    // 前者は status: completed・反復なし・ユニーク率0.90・話者4名で、G1〜G7 をすべて通過する。
    const runaway = (lastEndSec: number, audioSec = 1800): ChunkResult => ({
        status: 'completed',
        text: 'こんにちは。本日はよろしくお願いします。担当の間宮です。',
        annotations: [
            { text: 'こんにちは', startOffsetSec: 0, endOffsetSec: 1, speaker: 'spk:0' },
            { text: 'お願いします', startOffsetSec: lastEndSec - 1, endOffsetSec: lastEndSec, speaker: 'spk:1' },
        ],
        audioSec,
        speechSec: 1200,
    });

    it('実測された暴走 (39倍) を G8 が落とす', () => {
        const report = evaluateChunkQuality(runaway(70709.9), {
            diarizationEnabled: true, timestampsEnabled: true,
        });
        expect(report.failedGates).toContain('G8');
        expect(report.passed).toBe(false);
    });

    it('実測された暴走 (57倍) を G8 が落とす', () => {
        const report = evaluateChunkQuality(runaway(102080.9), {
            diarizationEnabled: true, timestampsEnabled: true,
        });
        expect(report.failedGates).toContain('G8');
    });

    it('🔴 下側だけを見ていたら通り抜けることの証人 — 他のゲートは1つも落ちない', () => {
        const report = evaluateChunkQuality(runaway(70709.9), {
            diarizationEnabled: true, timestampsEnabled: true,
        });
        // G8 以外は「正常」と言っている。片側検定だとこの走は合格になっていた。
        expect(report.failedGates).toEqual(['G8']);
    });

    it('境界: 1.05 ちょうどは通り、それを超えると落ちる', () => {
        const ok = evaluateChunkQuality(runaway(1890, 1800), { timestampsEnabled: true });
        expect(ok.failedGates).not.toContain('G8');
        const ng = evaluateChunkQuality(runaway(1890.1, 1800), { timestampsEnabled: true });
        expect(ng.failedGates).toContain('G8');
    });

    it('末尾がわずかに音声長を超えるのは許す (境界の丸め)', () => {
        const report = evaluateChunkQuality(runaway(1800.5, 1800), { timestampsEnabled: true });
        expect(report.failedGates).not.toContain('G8');
    });
});

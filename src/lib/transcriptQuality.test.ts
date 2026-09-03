import { describe, expect, it } from 'vitest';
import {
    DEFAULT_OUTPUT_TOKEN_LIMIT,
    MAX_COMPRESSION_RATIO,
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

/** 発話 1 秒あたり 4.5 文字 (実データの正常域 4〜5.5 の中央) になる発話秒数を当てて、G6 を無関係にする */
const gateChunk = (text: string, overrides: Partial<ChunkResult> = {}): ChunkResult =>
    makeChunk(text, { audioSec: 600, speechSec: Math.max(1, text.length / 4.5), ...overrides });

const gatesOf = (chunk: ChunkResult, options = {}): QualityGateId[] =>
    evaluateChunkQuality(chunk, options).failedGates;

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
            expect(report.failures.map((failure) => `${failure.gate}: ${failure.reason}`)).toEqual([]);
            expect(report.passed).toBe(true);
        });
    }

    it('正常本文の実測値が、実データの正常域と同じ側に居る (最長連続 ≦ 2・ユニーク率 ≧ 0.6)', () => {
        for (const { name, chunk } of NORMAL_CHUNKS) {
            const { metrics } = evaluateChunkQuality(chunk);
            expect(metrics.maxConsecutiveUnits, name).toBeLessThanOrEqual(2);
            expect(metrics.uniqueUnitRatio ?? 0, name).toBeGreaterThan(0.6);
            expect(metrics.charsPerSpeechSec ?? 0, name).toBeGreaterThan(4);
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

    it('🔴 カバレッジ不足 (音声の 67% までしか注釈が無い・status は completed) は G8 だけが捕まえる', () => {
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
        expect(report.failedGates).toEqual(['G8']);
        expect(report.metrics.coverageRatio ?? 0).toBeCloseTo(0.67, 6);
    });

    it('過少出力 (文字数はあるが発話秒数に対して 1.5 未満) は G6 だけが捕まえる', () => {
        const report = evaluateChunkQuality(
            makeChunk(NORMAL_WRITTEN_STYLE, { audioSec: 1200, speechSec: 1000 }),
        );
        expect(report.passed).toBe(false);
        expect(report.failedGates).toEqual(['G6']);
        expect(report.metrics.charsPerSpeechSec ?? 0).toBeCloseTo(1.115, 6);
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

    it('outputTokens が取れないチャンクでは G1 のトークン判定をしない (status だけ見る)', () => {
        const report = evaluateChunkQuality(gateChunk(NORMAL_LONG_TRANSCRIPT));
        expect(report.metrics.outputTokenRatio).toBeNull();
        expect(report.failedGates).not.toContain('G1');
    });
});

describe('G3 (最長連続ユニット) の境界', () => {
    const base = NORMAL_LONG_TRANSCRIPT;

    it('3 回連続で落ち、2 回連続では落ちない', () => {
        const twice = `${base}\nそうですね。そうですね。`;
        const thrice = `${base}\nそうですね。そうですね。そうですね。`;
        expect(gatesOf(gateChunk(twice))).not.toContain('G3');
        expect(gatesOf(gateChunk(thrice))).toContain('G3');
        expect(evaluateChunkQuality(gateChunk(thrice)).metrics.maxConsecutiveUnits).toBe(3);
    });

    it('読点で連続していても数える (「ここ、ここ、ここ、」で 3)', () => {
        expect(gatesOf(gateChunk(`${base}\nここ、ここ、ここ、`))).toContain('G3');
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

describe('G6 (過少出力) の境界', () => {
    const text = NORMAL_LONG_TRANSCRIPT.slice(0, 900);

    it('ちょうど 1.5 文字/秒では落ちず、それを下回ると落ちる', () => {
        expect(text).toHaveLength(900);
        expect(gatesOf(makeChunk(text, { audioSec: 1200, speechSec: 600 }))).not.toContain('G6');
        expect(gatesOf(makeChunk(text, { audioSec: 1200, speechSec: 601 }))).toContain('G6');
    });

    it('🔴 分母は音声長ではなく発話秒数 — 無音の多い正常チャンクを誤検出しない', () => {
        // 音声 1,200 秒のうち発話は 240 秒 (移動・雑談・無音が 80%)。音声長を分母にすると 0.93 文字/秒で偽陽性になる。
        const chunk = makeChunk(NORMAL_WRITTEN_STYLE, { audioSec: 1200, speechSec: 240 });
        expect(NORMAL_WRITTEN_STYLE.length / 1200).toBeLessThan(1.5);
        expect(evaluateChunkQuality(chunk).metrics.charsPerSpeechSec ?? 0).toBeGreaterThan(4);
        expect(gatesOf(chunk)).not.toContain('G6');
    });

    it('発話秒数が 0 なら判定しない (測れないものを落とさない)', () => {
        const report = evaluateChunkQuality(makeChunk(NORMAL_WRITTEN_STYLE, { audioSec: 300, speechSec: 0 }));
        expect(report.metrics.charsPerSpeechSec).toBeNull();
        expect(report.failedGates).not.toContain('G6');
    });
});

describe('G7 (話者の妥当性)', () => {
    it('話者分離 ON で 1 種類しか居なければ落ち、2 種類なら落ちない', () => {
        const audioSec = 600;
        const single = makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechSec: 740,
            annotations: makeAnnotations(audioSec, 0.99, ['spk:0']),
        });
        const pair = makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechSec: 740,
            annotations: makeAnnotations(audioSec, 0.99, ['spk:0', 'spk:1']),
        });
        expect(gatesOf(single)).toContain('G7');
        expect(gatesOf(pair)).not.toContain('G7');
    });

    it('話者分離 OFF (speaker が null) では判定しない', () => {
        const audioSec = 600;
        const chunk = makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechSec: 740,
            annotations: makeAnnotations(audioSec, 0.99, [null]),
        });
        expect(evaluateChunkQuality(chunk).metrics.speakerCount).toBe(0);
        expect(gatesOf(chunk)).not.toContain('G7');
        // 有効だと明示したときだけ落ちる (話者分離を単独指定すると注釈に speaker が付かない実測がある)
        expect(gatesOf(chunk, { diarizationEnabled: true })).toContain('G7');
    });
});

describe('G8 (カバレッジ) の境界', () => {
    const audioSec = 1000;

    it('ちょうど 0.95 では落ちず、それを下回ると落ちる', () => {
        const at = makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechSec: 740,
            annotations: [{ text: '末', startOffsetSec: 940, endOffsetSec: 950, speaker: 'spk:0' }],
        });
        const below = makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechSec: 740,
            annotations: [{ text: '末', startOffsetSec: 940, endOffsetSec: 949, speaker: 'spk:0' }],
        });
        expect(evaluateChunkQuality(at).metrics.coverageRatio).toBe(0.95);
        expect(gatesOf(at)).not.toContain('G8');
        expect(gatesOf(below)).toContain('G8');
    });

    it('🔴 G1 では代替できない — カバレッジ不足の実例は status: completed を返す', () => {
        const chunk = makeChunk(NORMAL_LONG_TRANSCRIPT, {
            status: 'completed',
            audioSec,
            speechSec: 740,
            annotations: makeAnnotations(audioSec, 0.67),
        });
        const report = evaluateChunkQuality(chunk);
        expect(report.failedGates).not.toContain('G1');
        expect(report.failedGates).toContain('G8');
    });

    it('注釈が 0 本のとき: 既定では判定しないが、時刻有効と明示すれば落ちる', () => {
        const chunk = makeChunk(NORMAL_LONG_TRANSCRIPT, { audioSec, speechSec: 740, annotations: [] });
        expect(evaluateChunkQuality(chunk).metrics.coverageRatio).toBeNull();
        expect(gatesOf(chunk)).not.toContain('G8');
        expect(gatesOf(chunk, { timestampsEnabled: true })).toContain('G8');
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
                annotations: makeAnnotations(1200, 0.5, ['spk:0']),
            }),
        );
        expect(report.failedGates).toEqual(['G1', 'G3', 'G4', 'G5', 'G7', 'G8']);
    });
});

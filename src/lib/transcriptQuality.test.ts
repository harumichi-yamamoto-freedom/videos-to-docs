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

/** 🔴 実データで正常と判定した走の最長連続ユニット (設計 §1.8: 話者分離＋単語タイムスタンプ / 1,023文字 / 圧縮率 2.48) */
const REAL_NORMAL_MAX_CONSECUTIVE = 6;

/** 🔴 実データで正常と判定した 30 分の走のカバレッジ (設計 §3.3 の長さ実測表) */
const REAL_NORMAL_MIN_COVERAGE = 0.938;

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

    it('🔴 過少出力は warn 止まり — 記録はするがチャンクは不合格にしない', () => {
        const report = evaluateChunkQuality(
            makeChunk(NORMAL_WRITTEN_STYLE, { audioSec: 1200, speechSec: 1000 }),
        );
        expect(report.metrics.charsPerSpeechSec ?? 0).toBeCloseTo(1.115, 6);
        expect(report.warnedGates).toEqual(['G6']);
        expect(report.failedGates).toEqual([]);
        expect(report.passed).toBe(true);
        expect(report.findings.find((item) => item.gate === 'G6')?.severity).toBe('warn');
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

describe('G6 (過少出力・警告のみ) の境界', () => {
    const text = NORMAL_LONG_TRANSCRIPT.slice(0, 900);
    const warnsOf = (chunk: ChunkResult) => evaluateChunkQuality(chunk).warnedGates;

    it('ちょうど 1.5 文字/秒では警告せず、それを下回ると警告する (どちらも不合格にはしない)', () => {
        expect(text).toHaveLength(900);
        const at = makeChunk(text, { audioSec: 1200, speechSec: 600 });
        const below = makeChunk(text, { audioSec: 1200, speechSec: 601 });
        expect(warnsOf(at)).not.toContain('G6');
        expect(warnsOf(below)).toContain('G6');
        expect(evaluateChunkQuality(below).failedGates).not.toContain('G6');
        expect(evaluateChunkQuality(below).passed).toBe(true);
    });

    it('🔴 どんなに低くても fail にはしない — 真陽性が未確認のゲートで出荷を止めない', () => {
        // 疎な 10 分区間の実測: 発話 143.5 秒 / 123 文字 = 0.86 文字/秒。正常とも異常とも判定できていない帯。
        const chunk = makeChunk('あ。'.repeat(62), { audioSec: 600, speechSec: 143.5 });
        const report = evaluateChunkQuality(chunk);
        expect(report.metrics.charsPerSpeechSec ?? 0).toBeCloseTo(0.86, 2);
        expect(report.warnedGates).toContain('G6');
        expect(report.failedGates).not.toContain('G6');
    });

    it('🔴 分母は音声長ではなく発話秒数 — 無音の多い正常チャンクを誤検出しない', () => {
        // 音声 1,200 秒のうち発話は 240 秒 (移動・雑談・無音が 80%)。音声長を分母にすると 0.93 文字/秒で偽陽性になる。
        const chunk = makeChunk(NORMAL_WRITTEN_STYLE, { audioSec: 1200, speechSec: 240 });
        expect(NORMAL_WRITTEN_STYLE.length / 1200).toBeLessThan(1.5);
        expect(evaluateChunkQuality(chunk).metrics.charsPerSpeechSec ?? 0).toBeGreaterThan(4);
        expect(warnsOf(chunk)).not.toContain('G6');
    });

    it('発話秒数が 0 なら「判定不能」— 警告にも合格にもしない', () => {
        const report = evaluateChunkQuality(makeChunk(NORMAL_WRITTEN_STYLE, { audioSec: 300, speechSec: 0 }));
        expect(report.metrics.charsPerSpeechSec).toBeNull();
        expect(report.indeterminateGates).toContain('G6');
        expect(report.warnedGates).not.toContain('G6');
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

    const withCoverage = (endOffsetSec: number) =>
        makeChunk(NORMAL_LONG_TRANSCRIPT, {
            audioSec,
            speechSec: 740,
            annotations: [
                { text: '頭', startOffsetSec: 0, endOffsetSec: 1, speaker: 'spk:0' },
                { text: '末', startOffsetSec: endOffsetSec - 1, endOffsetSec, speaker: 'spk:1' },
            ],
        });

    it('ちょうど 0.90 では落ちず、それを下回ると落ちる', () => {
        expect(evaluateChunkQuality(withCoverage(900)).metrics.coverageRatio).toBe(0.9);
        expect(gatesOf(withCoverage(900))).not.toContain('G8');
        expect(gatesOf(withCoverage(899))).toContain('G8');
    });

    it('🔴 実データの正常サンプル (カバレッジ 93.8%) は落ちない — 閾値 0.95 だとこれが偽陽性になる', () => {
        const chunk = withCoverage(audioSec * REAL_NORMAL_MIN_COVERAGE);
        expect(evaluateChunkQuality(chunk).metrics.coverageRatio).toBeCloseTo(0.938, 6);
        expect(gatesOf(chunk)).not.toContain('G8');
        expect(gatesOf(chunk, { minCoverageRatio: 0.95 })).toContain('G8');
    });

    it('不合格の実例 (74% / 67%) は落ちる', () => {
        expect(gatesOf(withCoverage(audioSec * 0.74))).toContain('G8');
        expect(gatesOf(withCoverage(audioSec * 0.67))).toContain('G8');
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

import { describe, expect, it, vi } from 'vitest';
import { TRANSCRIBE_CHUNK_MAX_AUDIO_SEC, type TranscribeChunkResponseBody } from '@/lib/transcribeChunkContract';
import {
    createFfmpegSilenceScanner,
    DEFAULT_CHUNK_SEC,
    DEFAULT_OVERLAP_SEC,
    FALLBACK_SILENCE_THRESHOLD_DB,
    MIN_TAIL_CHUNK_SEC,
    parseNoiseFloorDb,
    parseSilenceIntervals,
    planChunks,
    runTranscriptionJob,
    shiftChunkRange,
    silenceThresholdDb,
    snapCutToSilence,
    speechIntervalsBetween,
    speechSecBetween,
    type ChunkConverterLike,
    type FfmpegLike,
    type SilenceInterval,
    type SilenceScanner,
    type TranscriptionJobDeps,
} from '@/hooks/useTranscriptionJob';

// firebase を実際に初期化させない (既定の依存の import 経路を切る)
vi.mock('@/lib/firebase', () => ({ storage: {} }));
vi.mock('firebase/storage', () => ({ deleteObject: vi.fn(), ref: vi.fn() }));
vi.mock('@/lib/storage', () => ({ uploadAudioToStorage: vi.fn() }));

/**
 * 🔴 分割の論理を測るテストは **既定値ではなく固定値** を使う。
 * 既定のチャンク長は実測で動く値 (25 分 → 10 分・設計 §3.3) で、
 * ここに既定値を入れると「既定が変わった」だけで論理のテストが全部落ち、
 * 何が壊れたのか分からなくなる。既定値そのものは下の錠で別に測る。
 */
const TEST_CHUNK_SEC = 1500;
const PLAN_OPTIONS = { chunkSec: TEST_CHUNK_SEC, overlapSec: DEFAULT_OVERLAP_SEC };

describe('既定のチャンク長', () => {
    it('🔴 既定は 10 分 — 時刻の暴走が長さに単調に依存する (設計 §1.11 / 117 走)', () => {
        // 範囲外時刻を含む走: 5分以下 0% → 8〜12分 12% → 15分 20% → 20分 38%。
        // 変えるときは設計 §3.3 を測り直してから。テストだけ直すのは禁止。
        expect(DEFAULT_CHUNK_SEC).toBe(10 * 60);
    });

    it('既定のチャンク長 + オーバーラップは API の上限を超えない', () => {
        expect(DEFAULT_CHUNK_SEC + DEFAULT_OVERLAP_SEC).toBeLessThanOrEqual(TRANSCRIBE_CHUNK_MAX_AUDIO_SEC);
    });
});

// ---------------------------------------------------------------------------
// 分割の境界計算
// ---------------------------------------------------------------------------

describe('planChunks', () => {
    it('8,700 秒を 25 分チャンク・オーバーラップ 30 秒で 6 本に割る (固定値・既定値ではない)', () => {
        const plan = planChunks(8700, PLAN_OPTIONS);

        expect(plan.map((entry) => [entry.startSec, entry.endSec])).toEqual([
            [0, 1500],
            [1470, 3000],
            [2970, 4500],
            [4470, 6000],
            [5970, 7500],
            [7470, 8700],
        ]);
        // 末尾は端数チャンク (1,230 秒)。本体 25 分に満たないが独立して残る
        expect(plan[plan.length - 1].endSec - plan[plan.length - 1].startSec).toBe(1230);
        // どのチャンクも API の上限 (29 分) の内側
        for (const entry of plan) {
            expect(entry.endSec - entry.startSec).toBeLessThanOrEqual(29 * 60);
        }
    });

    it('端数が最小長ちょうどなら独立したチャンクとして残す (通る側)', () => {
        const plan = planChunks(1500 + MIN_TAIL_CHUNK_SEC, PLAN_OPTIONS);

        expect(plan).toHaveLength(2);
        expect(plan[1]).toMatchObject({ startSec: 1470, endSec: 1560 });
    });

    it('端数が最小長を 1 秒でも下回れば前のチャンクへ吸収する (落ちる側)', () => {
        const plan = planChunks(1500 + MIN_TAIL_CHUNK_SEC - 1, PLAN_OPTIONS);

        expect(plan).toHaveLength(1);
        expect(plan[0]).toMatchObject({ startSec: 0, endSec: 1559 });
    });

    it('吸収すると API の上限を超える場合は端数を吸収しない', () => {
        // 25 分 + 3 秒。吸収すると 1,503 秒だが上限を 1,501 秒に絞れば吸収できない
        const plan = planChunks(1503, { ...PLAN_OPTIONS, maxAudioSec: 1501 });

        expect(plan).toHaveLength(2);
        expect(plan[1]).toMatchObject({ startSec: 1470, endSec: 1503 });
    });

    it('音声長が 0 以下なら空', () => {
        expect(planChunks(0, PLAN_OPTIONS)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 無音スナップ
// ---------------------------------------------------------------------------

describe('snapCutToSilence', () => {
    const silences: SilenceInterval[] = [
        { startSec: 1470, endSec: 1472 }, // 2 秒
        { startSec: 1490, endSec: 1496 }, // 6 秒 = 窓内で最長
    ];

    it('窓内で最も長い無音の中点へ寄せる', () => {
        expect(snapCutToSilence(1500, silences, 30)).toBe(1493);
    });

    it('窓内に候補が無ければ null (呼び出し側は公称位置で切る)', () => {
        expect(snapCutToSilence(1500, [{ startSec: 1400, endSec: 1410 }], 30)).toBeNull();
    });

    it('窓の外まで伸びた無音は窓で切り取ってから中点を取る (中点が窓の外に出ない)', () => {
        const snapped = snapCutToSilence(1500, [{ startSec: 1000, endSec: 1520 }], 30);

        expect(snapped).toBe(1495);
        expect(snapped).toBeGreaterThanOrEqual(1470);
        expect(snapped).toBeLessThanOrEqual(1530);
    });

    it('無音が 1 件も無ければ null', () => {
        expect(snapCutToSilence(1500, [], 30)).toBeNull();
    });
});

describe('planChunks の無音スナップ', () => {
    it('切断点が無音へ寄り、オーバーラップも寄った位置から取られる', () => {
        const plan = planChunks(3000, {
            ...PLAN_OPTIONS,
            silences: [{ startSec: 1490, endSec: 1496 }],
        });

        expect(plan[0]).toMatchObject({ endSec: 1493, nominalCutSec: 1500, snapped: true });
        expect(plan[1].startSec).toBe(1493 - DEFAULT_OVERLAP_SEC);
    });

    it('窓内に候補が無ければ公称位置でそのまま切る (フォールバック)', () => {
        const plan = planChunks(3000, {
            ...PLAN_OPTIONS,
            silences: [{ startSec: 100, endSec: 200 }],
        });

        expect(plan[0]).toMatchObject({ endSec: 1500, nominalCutSec: 1500, snapped: false });
        expect(plan[1].startSec).toBe(1470);
    });
});

// ---------------------------------------------------------------------------
// 発話秒数
// ---------------------------------------------------------------------------

describe('speechSecBetween', () => {
    it('無音区間を引いた秒数を返す (音声長ではない)', () => {
        const silences: SilenceInterval[] = [
            { startSec: 100, endSec: 200 },
            { startSec: 400, endSec: 430 },
        ];

        expect(speechSecBetween(silences, 0, 1500)).toBe(1370);
    });

    it('区間に掛かる部分だけを引く', () => {
        expect(speechSecBetween([{ startSec: 90, endSec: 120 }], 100, 200)).toBe(80);
    });

describe('speechIntervalsBetween (G6 の入力)', () => {
    const silences = [
        { startSec: 100, endSec: 200 },
        { startSec: 500, endSec: 530 },
    ];

    it('無音の補集合を、チャンク先頭を 0 とした相対秒で返す', () => {
        expect(speechIntervalsBetween(silences, 0, 600)).toEqual([[0, 100], [200, 500], [530, 600]]);
    });

    it('🔴 相対秒である — チャンクの開始点を引いてある (絶対秒を渡すと穴の位置がずれる)', () => {
        expect(speechIntervalsBetween(silences, 100, 600)).toEqual([[100, 400], [430, 500]]);
    });

    it('無音が 1 件も無ければ全域が 1 区間', () => {
        expect(speechIntervalsBetween([], 0, 600)).toEqual([[0, 600]]);
    });

    it('全域が無音なら空配列 (0 区間)', () => {
        expect(speechIntervalsBetween([{ startSec: 0, endSec: 600 }], 0, 600)).toEqual([]);
    });

    it('🔴 区間の合計は speechSecBetween と一致する (別の走査で測っていないことの錠)', () => {
        const intervals = speechIntervalsBetween(silences, 0, 600);
        const total = intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
        expect(total).toBeCloseTo(speechSecBetween(silences, 0, 600), 6);
    });

    it('無音が順不同で来ても昇順・非重複で返す (サーバ側の検査に落ちない形)', () => {
        const shuffled = [{ startSec: 500, endSec: 530 }, { startSec: 100, endSec: 200 }];
        expect(speechIntervalsBetween(shuffled, 0, 600)).toEqual([[0, 100], [200, 500], [530, 600]]);
    });
});

    it('全区間が無音なら 0 (負にしない)', () => {
        expect(speechSecBetween([{ startSec: 0, endSec: 999 }], 100, 200)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// ffmpeg ログの解釈と閾値
// ---------------------------------------------------------------------------

describe('無音走査', () => {
    it('mean_volume をノイズフロアとして読む', () => {
        expect(parseNoiseFloorDb([
            '[Parsed_volumedetect_0 @ 0x1] n_samples: 123',
            '[Parsed_volumedetect_0 @ 0x1] mean_volume: -27.4 dB',
            '[Parsed_volumedetect_0 @ 0x1] max_volume: -1.2 dB',
        ])).toBe(-27.4);
    });

    it('mean_volume が無ければ null', () => {
        expect(parseNoiseFloorDb(['[info] nothing here'])).toBeNull();
    });

    it('閾値はノイズフロア − 5dB。絶対値で固定しない', () => {
        expect(silenceThresholdDb(-27.4)).toBe(-32.4);
        expect(silenceThresholdDb(-61)).toBe(-66);
        // 測れなかったときだけ固定値に落ちる
        expect(silenceThresholdDb(null)).toBe(FALLBACK_SILENCE_THRESHOLD_DB);
    });

    it('silence_start / silence_end を区間に組む。閉じない末尾は音声の終端で閉じる', () => {
        const intervals = parseSilenceIntervals([
            '[silencedetect @ 0x1] silence_start: 12.5',
            '[silencedetect @ 0x1] silence_end: 20.75 | silence_duration: 8.25',
            '[silencedetect @ 0x1] silence_start: 90',
        ], 100);

        expect(intervals).toEqual([
            { startSec: 12.5, endSec: 20.75 },
            { startSec: 90, endSec: 100 },
        ]);
    });

    it('createFfmpegSilenceScanner は測ったフロア − 5dB を silencedetect に渡す (−50dB 固定にしない)', async () => {
        const execArgs: string[][] = [];
        let logHandler: ((payload: { message: string }) => void) | null = null;
        const ffmpeg: FfmpegLike = {
            writeFile: vi.fn(async () => undefined),
            deleteFile: vi.fn(async () => undefined),
            on: (_event, handler) => { logHandler = handler; },
            off: () => { logHandler = null; },
            exec: vi.fn(async (args: string[]) => {
                execArgs.push(args);
                if (args.includes('volumedetect')) {
                    logHandler?.({ message: '[Parsed_volumedetect_0 @ 0x1] mean_volume: -27.4 dB' });
                } else {
                    logHandler?.({ message: '[silencedetect @ 0x1] silence_start: 10' });
                    logHandler?.({ message: '[silencedetect @ 0x1] silence_end: 15 | silence_duration: 5' });
                }
                return 0;
            }),
        };

        const scanner = createFfmpegSilenceScanner(ffmpeg, async () => new Uint8Array([1, 2, 3]));
        const scan = await scanner({ name: 'a.mp4' } as unknown as File, { durationSec: 100 });

        expect(scan.noiseFloorDb).toBe(-27.4);
        expect(scan.thresholdDb).toBe(-32.4);
        expect(scan.intervals).toEqual([{ startSec: 10, endSec: 15 }]);
        const silenceArgs = execArgs[1].join(' ');
        expect(silenceArgs).toContain('silencedetect=noise=-32.4dB:d=0.5');
        expect(silenceArgs).not.toContain('-50dB');
        expect(ffmpeg.deleteFile).toHaveBeenCalledTimes(1);
    });

    it('volumedetect が読めなければ保険の固定閾値に落ちる', async () => {
        const execArgs: string[][] = [];
        const ffmpeg: FfmpegLike = {
            writeFile: vi.fn(async () => undefined),
            deleteFile: vi.fn(async () => undefined),
            on: () => undefined,
            off: () => undefined,
            exec: vi.fn(async (args: string[]) => { execArgs.push(args); return 0; }),
        };

        const scan = await createFfmpegSilenceScanner(ffmpeg, async () => new Uint8Array())(
            { name: 'a.mp4' } as unknown as File,
            { durationSec: 100 },
        );

        expect(scan.noiseFloorDb).toBeNull();
        expect(scan.thresholdDb).toBe(FALLBACK_SILENCE_THRESHOLD_DB);
        expect(execArgs[1].join(' ')).toContain(`silencedetect=noise=${FALLBACK_SILENCE_THRESHOLD_DB}dB`);
    });
});

describe('shiftChunkRange', () => {
    const entry = { index: 1, startSec: 1470, endSec: 3000, nominalCutSec: 3000, snapped: false };

    it('範囲を丸ごとずらす', () => {
        expect(shiftChunkRange(entry, 30, 8700)).toMatchObject({ startSec: 1500, endSec: 3030 });
    });

    it('音声の終端にぶつかる向きへはずらさず逆向きへずらす', () => {
        expect(shiftChunkRange(entry, 30, 3000)).toMatchObject({ startSec: 1440, endSec: 2970 });
    });

    it('先頭にぶつかる向きも同様', () => {
        const head = { index: 0, startSec: 0, endSec: 1500, nominalCutSec: 1500, snapped: false };
        expect(shiftChunkRange(head, -30, 8700)).toMatchObject({ startSec: 30, endSec: 1530 });
    });

    it('チャンクが音声全体を覆っていればずらさない (縮めない)', () => {
        const whole = { index: 0, startSec: 0, endSec: 1500, nominalCutSec: 1500, snapped: false };
        expect(shiftChunkRange(whole, 30, 1500)).toBe(whole);
    });
});

// ---------------------------------------------------------------------------
// ジョブ本体
// ---------------------------------------------------------------------------

const FILE = { name: 'shoudan.mp4' } as unknown as File;
const BLOB = { size: 1024 } as unknown as Blob;

const tick = async (times = 3) => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
};

/** マイクロタスクを全部流し切る。並行度の観測はこの境界で行う (タイマ依存の揺れを避ける) */
const nextMacrotask = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

const passing = (over: Partial<TranscribeChunkResponseBody> = {}): TranscribeChunkResponseBody => ({
    status: 'completed',
    text: '本文',
    annotations: [],
    quality: { passed: true, failedGates: [], warnedGates: [], indeterminateGates: [] },
    elapsedMs: 1234,
    ...over,
});

const failing = (over: Partial<TranscribeChunkResponseBody> = {}): TranscribeChunkResponseBody => ({
    ...passing(),
    quality: { passed: false, failedGates: ['G3'], warnedGates: [], indeterminateGates: [] },
    ...over,
});

interface Harness {
    deps: TranscriptionJobDeps;
    posted: Array<{
        fileName: string; audioSec: number; speechSec: number; storagePath: string;
        speechIntervals: Array<[number, number]>;
    }>;
    deleted: string[];
    uploaded: string[];
    cutRanges: Array<{ index: number; startSec: number; endSec: number }>;
}

const makeHarness = (options: {
    durationSec?: number;
    silences?: SilenceInterval[];
    respond?: (call: number, fileName: string) => TranscribeChunkResponseBody;
    onPost?: (fileName: string) => void | Promise<void>;
    cutFails?: (index: number, attempt: number) => boolean;
} = {}): Harness => {
    const {
        durationSec = 3000,
        silences = [
            { startSec: 300, endSec: 400 },
            { startSec: 1600, endSec: 1700 },
        ],
        respond = () => passing(),
        onPost,
    } = options;

    const posted: Harness['posted'] = [];
    const deleted: string[] = [];
    const uploaded: string[] = [];
    const cutRanges: Harness['cutRanges'] = [];
    let calls = 0;

    const converter: ChunkConverterLike = {
        getVideoDuration: async () => {
            await tick(1);
            return durationSec;
        },
        convertSegmentToMp3: async (_file, startSec, endSec, index) => {
            await tick();
            cutRanges.push({ index, startSec, endSec });
            return { success: true, outputBlob: BLOB };
        },
    };

    const scanSilence: SilenceScanner = async () => {
        await tick(1);
        return { noiseFloorDb: -27.4, thresholdDb: -32.4, intervals: silences };
    };

    const deps: TranscriptionJobDeps = {
        converter,
        scanSilence,
        uploadChunk: async (_blob, fileName) => {
            await tick();
            const path = `audio/u1/${fileName}.mp3`;
            uploaded.push(path);
            return path;
        },
        deleteChunk: async (path) => {
            deleted.push(path);
        },
        postChunk: async (body) => {
            await onPost?.(body.fileName);
            await tick();
            posted.push({
                fileName: body.fileName,
                audioSec: body.audioSec,
                speechSec: body.speechSec,
                storagePath: body.storagePath,
                speechIntervals: body.speechIntervals,
            });
            calls += 1;
            return respond(calls, body.fileName);
        },
    };

    return { deps, posted, deleted, uploaded, cutRanges };
};

describe('runTranscriptionJob', () => {
    it('🔴 speechSec は silencedetect 由来。音声長を渡していない', async () => {
        const harness = makeHarness();

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.ok).toBe(true);
        // チャンク0 = [0,1500] のうち [300,400] が無音 → 1400 秒 / チャンク1 = [1470,3000] のうち [1600,1700] → 1430 秒
        expect(harness.posted.map((p) => p.speechSec)).toEqual([1400, 1430]);
        expect(harness.posted.map((p) => p.audioSec)).toEqual([1500, 1530]);
        for (const post of harness.posted) {
            // 錠: 音声長で代用していたらこれが等しくなる (サーバ側 G6 の分母が壊れる)
            expect(post.speechSec).not.toBe(post.audioSec);
        }
    });

    it('無音が 1 件も無ければ speechSec は音声長と一致する (代用ではなく、引くものが無いだけ)', async () => {
        const harness = makeHarness({ silences: [] });

        await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(harness.posted.map((p) => p.speechSec)).toEqual([1500, 1530]);
    });

    it('🔴 発話区間も一緒に送る — 無いとサーバ側 G6 が走らず脱落を検査しない', async () => {
        const harness = makeHarness({
            durationSec: 3000,
            silences: [{ startSec: 300, endSec: 400 }, { startSec: 1600, endSec: 1700 }],
        });
        await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);
        // チャンク0 = [0,1500] の無音 [300,400] → 相対で [[0,300],[400,1500]]
        expect(harness.posted[0]?.speechIntervals).toEqual([[0, 300], [400, 1500]]);
        // チャンク1 = [1470,3000] の無音 [1600,1700] → 開始点 1470 を引いた相対秒
        expect(harness.posted[1]?.speechIntervals).toEqual([[0, 130], [230, 1530]]);
        // 総量と区間の合計が一致する (別の走査で測っていない)
        for (const posted of harness.posted) {
            const total = posted.speechIntervals.reduce((sum, [x, y]) => sum + (y - x), 0);
            expect(total).toBeCloseTo(posted.speechSec, 6);
        }
    });

    it('ゲート不合格 → 境界ずらし → 同一再投入 の順に 3 回試す', async () => {
        const harness = makeHarness({
            durationSec: 3000,
            silences: [],
            // チャンク0 は試行 3 でだけ合格する
            respond: (_call, fileName) =>
                fileName.includes('chunk0') && !fileName.includes('try3') ? failing() : passing(),
        });

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.ok).toBe(true);
        expect(result.chunks[0].status).toBe('completed');
        const attempts = result.chunks[0].attempts;
        expect(attempts).toHaveLength(3);
        // 試行 1: 公称どおり
        expect(attempts[0]).toMatchObject({ attempt: 1, startSec: 0, endSec: 1500, shifted: false });
        // 試行 2: 境界を 30 秒ずらして切り直す
        expect(attempts[1]).toMatchObject({ attempt: 2, startSec: 30, endSec: 1530, shifted: true });
        // 試行 3: 試行 1 と同じ範囲の再投入
        expect(attempts[2]).toMatchObject({ attempt: 3, startSec: 0, endSec: 1500, shifted: false });
        // 実際に切り直されている (ffmpeg へ渡った範囲)
        expect(harness.cutRanges.filter((cut) => cut.index === 0)).toEqual([
            { index: 0, startSec: 0, endSec: 1500 },
            { index: 0, startSec: 30, endSec: 1530 },
            { index: 0, startSec: 0, endSec: 1500 },
        ]);
        // 境界ずらしは speechSec も測り直す (無音が無いのでここでは音声長と一致)
        expect(attempts[1].audioSec).toBe(1500);
    });

    it('3 回とも不合格ならそのチャンクは failed。ジョブ全体も成功にしない', async () => {
        const harness = makeHarness({ respond: (_call, fileName) => (fileName.includes('chunk1') ? failing() : passing()) });

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.ok).toBe(false);
        expect(result.failedChunkIndexes).toEqual([1]);
        expect(result.chunks[1].status).toBe('failed');
        expect(result.chunks[1].attempts).toHaveLength(3);
        // 失敗区間は本文ではなく注記として残る
        expect(result.merged.gaps.map((gap) => gap.chunkIndex)).toEqual([1]);
        expect(result.markdown).toContain('文字起こしできませんでした');
    });

    it('切り出しに失敗した試行も記録し、次の試行へ進む', async () => {
        const harness = makeHarness({ durationSec: 1500 });
        let cutCalls = 0;
        harness.deps.converter.convertSegmentToMp3 = async () => {
            cutCalls += 1;
            await tick();
            return cutCalls === 1
                ? { success: false, error: '音声トラックがありません' }
                : { success: true, outputBlob: BLOB };
        };

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.chunks[0].attempts[0].error).toBe('音声トラックがありません');
        expect(result.chunks[0].status).toBe('completed');
        expect(harness.posted).toHaveLength(1);
    });

    it('🔴 cachedTokens が 0 でない走を結果に残す (再試行したが測り直していない証拠)', async () => {
        const harness = makeHarness({
            durationSec: 1500,
            respond: (call) => (call === 1 ? failing() : passing({ cachedTokens: 4096 })),
        });

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.cachedRuns).toEqual([{ chunkIndex: 0, attempt: 2, cachedTokens: 4096 }]);
        expect(result.chunks[0].servedFromCache).toBe(true);
        expect(result.chunks[0].attempts[1].cachedTokens).toBe(4096);
    });

    it('cachedTokens が 0 / 未返却の走は cachedRuns に入らない', async () => {
        const harness = makeHarness({ durationSec: 1500, respond: () => passing({ cachedTokens: 0 }) });

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.cachedRuns).toEqual([]);
        expect(result.chunks[0].servedFromCache).toBe(false);
    });

    it('🔴 チャンク1 は単独で走り、2 本目以降が最大 3 並列で走る', async () => {
        let inflight = 0;
        const observed: Array<{ chunk: string; inflight: number }> = [];
        const harness = makeHarness({
            durationSec: 8700, // 6 チャンク
            onPost: async (fileName) => {
                inflight += 1;
                observed.push({ chunk: fileName.split('_')[1], inflight });
                await nextMacrotask();
                inflight -= 1;
            },
        });

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.chunks).toHaveLength(6);
        // チャンク1 (index 0) が飛んでいる間、他は 1 本も飛んでいない
        const first = observed.find((entry) => entry.chunk === 'chunk0');
        expect(first).toEqual({ chunk: 'chunk0', inflight: 1 });
        expect(observed[0].chunk).toBe('chunk0');
        // 残り 5 本は 3 並列で頭打ち
        expect(Math.max(...observed.map((entry) => entry.inflight))).toBe(3);
    });

    it('maxParallel を 1 にすれば直列になる', async () => {
        let inflight = 0;
        let max = 0;
        const harness = makeHarness({
            durationSec: 8700,
            onPost: async () => {
                inflight += 1;
                max = Math.max(max, inflight);
                await nextMacrotask();
                inflight -= 1;
            },
        });

        await runTranscriptionJob(FILE, harness.deps, { ...PLAN_OPTIONS, maxParallel: 1 });

        expect(max).toBe(1);
    });

    it('🔴 部分結果を逐次返す (全部終わるまで黙らない)', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const harness = makeHarness({
            durationSec: 8700,
            // チャンク2 本目以降は解放するまで返さない
            onPost: async (fileName) => { if (!fileName.includes('chunk0')) await gate; },
        });
        const settledDuringRun: number[] = [];
        let finished = false;

        const promise = runTranscriptionJob(FILE, harness.deps, {
            ...PLAN_OPTIONS,
            onChunkSettled: (chunk) => settledDuringRun.push(chunk.index),
        }).then((value) => { finished = true; return value; });

        await nextMacrotask();
        // ジョブはまだ決着していないのに、1 本目はもう通知されている
        expect(finished).toBe(false);
        expect(settledDuringRun).toEqual([0]);

        release();
        const result = await promise;
        expect(settledDuringRun).toHaveLength(result.chunks.length);
        expect([...settledDuringRun].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('🔴 中断すると以降のチャンクは投げられない', async () => {
        const controller = new AbortController();
        const harness = makeHarness({ durationSec: 8700 });

        const result = await runTranscriptionJob(FILE, harness.deps, {
            ...PLAN_OPTIONS,
            signal: controller.signal,
            onChunkSettled: (chunk) => {
                if (chunk.index === 0) controller.abort();
            },
        });

        expect(result.aborted).toBe(true);
        expect(result.ok).toBe(false);
        expect(harness.posted).toHaveLength(1);
        expect(harness.posted[0].fileName).toContain('chunk0');
    });

    it('開始前に中断済みなら 1 本も投げない', async () => {
        const controller = new AbortController();
        controller.abort();
        const harness = makeHarness();

        await expect(
            runTranscriptionJob(FILE, harness.deps, { ...PLAN_OPTIONS, signal: controller.signal }),
        ).rejects.toThrow(/中断/);
        expect(harness.posted).toHaveLength(0);
    });

    it('🔴 完了後にチャンク音声を全部消す', async () => {
        const harness = makeHarness();

        await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(harness.uploaded).toHaveLength(2);
        expect([...harness.deleted].sort()).toEqual([...harness.uploaded].sort());
    });

    it('🔴 全滅したチャンクの音声も消す (3 試行ぶん)', async () => {
        const harness = makeHarness({ durationSec: 1500, respond: () => failing() });

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.chunks[0].status).toBe('failed');
        expect(harness.uploaded).toHaveLength(3);
        expect([...harness.deleted].sort()).toEqual([...harness.uploaded].sort());
    });

    it('🔴 中断したときも、上げ終わっていたチャンク音声を消す', async () => {
        const controller = new AbortController();
        const harness = makeHarness({ durationSec: 8700 });

        await runTranscriptionJob(FILE, harness.deps, {
            ...PLAN_OPTIONS,
            signal: controller.signal,
            onChunkSettled: (chunk) => {
                if (chunk.index === 0) controller.abort();
            },
        });

        expect(harness.uploaded).toHaveLength(1);
        expect(harness.deleted).toEqual(harness.uploaded);
    });

    it('削除に失敗してもジョブの結果は返る', async () => {
        const harness = makeHarness({ durationSec: 1500 });
        harness.deps.deleteChunk = async () => {
            throw new Error('削除できません');
        };

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.ok).toBe(true);
    });

    it('注釈を結合して Markdown にする (絶対時刻はチャンク開始点にアンカーされる)', async () => {
        const harness = makeHarness({
            durationSec: 3000,
            silences: [],
            respond: (_call, fileName) =>
                passing({
                    annotations: fileName.includes('chunk0')
                        ? [{ text: 'こんにちは', startOffsetSec: 10, endOffsetSec: 12, speaker: 'spk:0' }]
                        : [{ text: 'よろしく', startOffsetSec: 100, endOffsetSec: 102, speaker: 'spk:1' }],
                }),
        });

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.merged.segments).toEqual([
            { text: 'こんにちは', startSec: 10, endSec: 12, speaker: 'spk:0', chunkIndex: 0 },
            // チャンク1 の開始は 1470 秒。10+1470 ではなく 100+1470
            { text: 'よろしく', startSec: 1570, endSec: 1572, speaker: 'spk:1', chunkIndex: 1 },
        ]);
        expect(result.markdown).toContain('[00:10](#t=10)');
        expect(result.markdown).toContain('[26:10](#t=1570)');
    });

    it('走査したノイズフロアと閾値を結果に残す', async () => {
        const harness = makeHarness({ durationSec: 1500 });

        const result = await runTranscriptionJob(FILE, harness.deps, PLAN_OPTIONS);

        expect(result.noiseFloorDb).toBe(-27.4);
        expect(result.silenceThresholdDb).toBe(-32.4);
        expect(result.durationSec).toBe(1500);
    });
});

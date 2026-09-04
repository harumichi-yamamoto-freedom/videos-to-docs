/**
 * P1: 長い音声をクライアント側で分割し、`/api/transcribe/chunk` へ順に投げて 1 本の Markdown に結合する。
 *
 * サーバはチャンクを跨いだ状態を持たない (設計 §3)。分割・再試行・結合はここの責務。
 *
 * 🔴 このモジュールの実測由来の要点:
 *   1. 切断点は**無音にスナップする**。しかも silencedetect の閾値を絶対値で固定してはいけない。
 *      録音ごとにノイズフロアが違い、−50dB 固定だと候補が 1 件も出ない録音が実在する (実測)。
 *      毎回 volumedetect でフロアを測り、`フロア − 5dB` を閾値にする。
 *   2. `speechSec` は**同じ silencedetect の走査**から出す。音声長で代用してはいけない — サーバ側 G6 の
 *      分母がこれで、音声長を渡すと移動・雑談・無音を「発話」と数えて正常な静かな区間が落ちる (設計 §4.1)。
 *   3. 再試行 3 (同じ入力の再投入) は Gemini の暗黙キャッシュに当たり得る。当たった走は
 *      `cachedTokens > 0` で返るので、**測り直していないこと**が後から分かるよう結果に残す (設計 §3.3)。
 *   4. チャンク音声は本数が元音声より増える。ジョブ完了後 (失敗時も) に必ず消す。
 *
 * React に依存するのは末尾のフックだけ。中核は `runTranscriptionJob` (依存注入つきの純粋な非同期関数) に
 * 置いてあり、テストは React を描画せずにここへ直接当てる。
 */
import { useCallback, useRef, useState } from 'react';
import { uploadAudioToStorage, deleteAudioFromStorage } from '@/lib/storage';
import { createLogger } from '@/lib/logger';
import {
    TRANSCRIBE_CHUNK_API_PATH,
    TRANSCRIBE_CHUNK_MAX_AUDIO_SEC,
    type TranscribeChunkQuality,
    type TranscribeChunkRequestBody,
    type TranscribeChunkResponseBody,
} from '@/lib/transcribeChunkContract';
import {
    checkMergeInvariants,
    mergeTranscriptChunks,
    toTranscriptMarkdown,
    type MergeChunk,
    type MergeInvariantResult,
    type MergedTranscript,
    type TranscriptMarkdownOptions,
} from '@/lib/transcriptMerge';

const jobLogger = createLogger('transcriptionJob');

// ---------------------------------------------------------------------------
// 定数 (すべて呼び出し側から上書きできる)
// ---------------------------------------------------------------------------

/**
 * 既定のチャンク長 (秒)。10 分 + オーバーラップ 30 秒 = 10.5 分。
 *
 * 🔴 **2026-09-04 に 25 分から改訂した (設計 §3.3 / §1.11)。** 25 分を採った根拠は
 * 「長いほど継ぎ目が減って有利」だったが、**長さの代償を測る計器を持っていなかった。**
 * 正しい計器 (最長穴・範囲外時刻) で 117 走を測り直した結果:
 *
 * - **本文の脱落は長さにほとんど依存しない** — 最悪でも 43 秒の穴で、全長で同程度
 * - **時刻の暴走だけが長さに単調に依存する** — 範囲外時刻を含む走が
 *   5 分以下 0% → 8〜12 分 12% → 15 分 20% → **20 分 38%**
 *
 * 時刻シーク再生と結合の絶対時刻はどちらも時刻の正しさに乗るので、ここで決まる。
 * 8〜12 分は最長穴が全走 24 秒以内で差が無く、その帯の中から
 * 継ぎ目の本数 (60 分の商談で 6 本) と 1 リクエストの待ち時間の兼ね合いで 10 分を採る。
 * 5 分以下は範囲外時刻 0% だが、60 分で 12 本以上の継ぎ目になり話者ラベルの通し番号付けが破綻する。
 */
export const DEFAULT_CHUNK_SEC = 10 * 60;

/** 既定のオーバーラップ (秒)。切断線を跨ぐ発話を両側から拾えるだけの幅 */
export const DEFAULT_OVERLAP_SEC = 30;

/** 切断点を無音へ寄せるときに探す窓 (公称位置の ±この秒数) */
export const DEFAULT_SNAP_WINDOW_SEC = 30;

/** 再試行 2 で切断点をずらす量 (秒) */
export const DEFAULT_RETRY_SHIFT_SEC = 30;

/**
 * 末尾の端数がこの秒数に満たなければ、独立したチャンクを作らず前のチャンクへ吸収する。
 * 数秒のチャンクは文脈が無く、品質ゲートの母数も足りない。
 */
export const MIN_TAIL_CHUNK_SEC = 60;

/**
 * 🔴 silencedetect の閾値 = ノイズフロア − このマージン (dB)。
 * 絶対値で固定しないこと。−50dB 固定は候補 0 件になる録音がある (実測)。
 */
export const SILENCE_THRESHOLD_MARGIN_DB = 5;

/** ノイズフロアが測れなかったときだけ使う保険の閾値 (dB) */
export const FALLBACK_SILENCE_THRESHOLD_DB = -50;

/** silencedetect が無音と認める最短長 (秒) */
export const DEFAULT_MIN_SILENCE_SEC = 0.5;

/** 同時に投げるチャンク数の上限 */
export const MAX_PARALLEL_CHUNKS = 3;

/** 1 チャンクあたりの最大試行回数 (通常 → 境界ずらし → 同一再投入) */
export const MAX_CHUNK_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// 無音の走査 (volumedetect → silencedetect)
// ---------------------------------------------------------------------------

/** 無音区間 1 本 (元音声の絶対秒) */
export interface SilenceInterval {
    startSec: number;
    endSec: number;
}

export interface SilenceScan {
    /** volumedetect の mean_volume をノイズフロアの代理として使う。測れなければ null */
    noiseFloorDb: number | null;
    /** 実際に silencedetect へ渡した閾値 */
    thresholdDb: number;
    intervals: SilenceInterval[];
}

export interface SilenceScanOptions {
    /** 音声全体の長さ。終端が閉じていない無音区間をここで閉じる */
    durationSec: number;
    minSilenceSec?: number;
}

export type SilenceScanner = (file: File, options: SilenceScanOptions) => Promise<SilenceScan>;

/** ノイズフロアから silencedetect の閾値を出す。フロアが測れなければ保険の固定値 */
export const silenceThresholdDb = (noiseFloorDb: number | null): number =>
    noiseFloorDb === null ? FALLBACK_SILENCE_THRESHOLD_DB : noiseFloorDb - SILENCE_THRESHOLD_MARGIN_DB;

const MEAN_VOLUME = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;
const SILENCE_START = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
const SILENCE_END = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

/**
 * volumedetect のログからノイズフロア (mean_volume) を読む。
 * ⚠️ mean_volume は「フロア」そのものではなく代理値。だからこそ絶対値の閾値ではなく
 * 「録音ごとの相対値」として使い、マージンを別定数に切り出してある。
 */
export const parseNoiseFloorDb = (logLines: readonly string[]): number | null => {
    for (const line of logLines) {
        const matched = MEAN_VOLUME.exec(line);
        if (matched) {
            const value = Number(matched[1]);
            if (Number.isFinite(value)) return value;
        }
    }
    return null;
};

/**
 * silencedetect のログから無音区間を組む。
 * 最後の `silence_start` に対応する `silence_end` が来ないまま終わることがある (末尾が無音)。
 * その場合は音声の終端で閉じる。
 */
export const parseSilenceIntervals = (
    logLines: readonly string[],
    durationSec: number,
): SilenceInterval[] => {
    const intervals: SilenceInterval[] = [];
    let openStart: number | null = null;

    for (const line of logLines) {
        const start = SILENCE_START.exec(line);
        if (start) {
            const value = Number(start[1]);
            if (Number.isFinite(value)) openStart = Math.max(0, value);
            continue;
        }
        const end = SILENCE_END.exec(line);
        if (end && openStart !== null) {
            const value = Number(end[1]);
            if (Number.isFinite(value) && value > openStart) {
                intervals.push({ startSec: openStart, endSec: Math.min(value, durationSec) });
            }
            openStart = null;
        }
    }

    if (openStart !== null && durationSec > openStart) {
        intervals.push({ startSec: openStart, endSec: durationSec });
    }

    return intervals.sort((a, b) => a.startSec - b.startSec);
};

/**
 * `@ffmpeg/ffmpeg` の FFmpeg のうち、無音走査に要る口だけ。
 * VideoConverter は内部の FFmpeg を公開していないので、走査器には呼び出し側から渡してもらう。
 */
export interface FfmpegLike {
    writeFile(fileName: string, data: Uint8Array): Promise<unknown>;
    exec(args: string[]): Promise<unknown>;
    deleteFile(fileName: string): Promise<unknown>;
    on(event: 'log', handler: (payload: { message: string }) => void): void;
    off(event: 'log', handler: (payload: { message: string }) => void): void;
}

/**
 * FFmpeg を 2 回走らせて無音を測る走査器を作る。
 * 1 走目 volumedetect でノイズフロア、2 走目 silencedetect で区間。
 * 🔴 閾値は 1 走目の結果から決める。定数で決め打ちにしない。
 */
export const createFfmpegSilenceScanner = (
    ffmpeg: FfmpegLike,
    readFile: (file: File) => Promise<Uint8Array>,
): SilenceScanner => async (file, options) => {
    const { durationSec, minSilenceSec = DEFAULT_MIN_SILENCE_SEC } = options;
    const inputFileName = `silence_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const logLines: string[] = [];
    const logHandler = ({ message }: { message: string }) => {
        logLines.push(message);
    };

    await ffmpeg.writeFile(inputFileName, await readFile(file));
    ffmpeg.on('log', logHandler);
    try {
        // 1 走目: ノイズフロアの測定
        await ffmpeg
            .exec(['-i', inputFileName, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
            .catch(() => undefined);
        const noiseFloorDb = parseNoiseFloorDb(logLines);
        const thresholdDb = silenceThresholdDb(noiseFloorDb);

        // 2 走目: 測った閾値で無音区間を取る
        logLines.length = 0;
        await ffmpeg
            .exec([
                '-i', inputFileName,
                '-vn',
                '-af', `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`,
                '-f', 'null', '-',
            ])
            .catch(() => undefined);

        return { noiseFloorDb, thresholdDb, intervals: parseSilenceIntervals(logLines, durationSec) };
    } finally {
        ffmpeg.off('log', logHandler);
        await Promise.resolve(ffmpeg.deleteFile(inputFileName)).catch(() => undefined);
    }
};

// ---------------------------------------------------------------------------
// 分割計画 (純関数)
// ---------------------------------------------------------------------------

export interface ChunkPlanOptions {
    chunkSec?: number;
    overlapSec?: number;
    snapWindowSec?: number;
    minTailSec?: number;
    maxAudioSec?: number;
    /** 無音区間。空なら公称位置でそのまま切る */
    silences?: readonly SilenceInterval[];
}

/** 1 チャンクの切り出し範囲 (元音声の絶対秒)。`startSec` はオーバーラップ込みの実際の開始 */
export interface ChunkPlanEntry {
    index: number;
    startSec: number;
    endSec: number;
    /** 公称の切断点 (末尾チャンクは音声の終端)。無音スナップの前の値 */
    nominalCutSec: number;
    /** 切断点が無音へ寄ったか。false は「窓内に候補が無く公称位置で切った」 */
    snapped: boolean;
}

/**
 * 公称の切断点を、±window の窓で最も長い無音区間の中点へ寄せる。
 * 窓内に候補が無ければ null (呼び出し側は公称位置のまま切る)。
 *
 * 候補は**窓で切り取ってから**長さを比べる。窓の外まで伸びた長大な無音の中点は窓の外に出得るため。
 */
export const snapCutToSilence = (
    nominalSec: number,
    silences: readonly SilenceInterval[],
    windowSec: number,
): number | null => {
    const windowStart = nominalSec - windowSec;
    const windowEnd = nominalSec + windowSec;
    let bestSec: number | null = null;
    let bestLength = 0;

    for (const silence of silences) {
        const start = Math.max(silence.startSec, windowStart);
        const end = Math.min(silence.endSec, windowEnd);
        const length = end - start;
        if (length <= 0) continue;
        if (length > bestLength) {
            bestLength = length;
            bestSec = (start + end) / 2;
        }
    }

    return bestSec;
};

/**
 * 全長からチャンクの範囲を決める。
 *
 * 切断点は chunkSec の倍数を公称位置とし、無音へスナップする。
 * チャンク k は [切断点(k−1) − overlap, 切断点(k)]。末尾の端数が短すぎれば前のチャンクへ吸収する。
 */
export const planChunks = (durationSec: number, options: ChunkPlanOptions = {}): ChunkPlanEntry[] => {
    const {
        chunkSec = DEFAULT_CHUNK_SEC,
        overlapSec = DEFAULT_OVERLAP_SEC,
        snapWindowSec = DEFAULT_SNAP_WINDOW_SEC,
        minTailSec = MIN_TAIL_CHUNK_SEC,
        maxAudioSec = TRANSCRIBE_CHUNK_MAX_AUDIO_SEC,
        silences = [],
    } = options;

    if (!(durationSec > 0)) return [];

    // 公称の切断点
    const nominalCuts: number[] = [];
    for (let cut = chunkSec; cut < durationSec; cut += chunkSec) {
        nominalCuts.push(cut);
    }

    // 末尾の端数が短すぎるなら最後の切断点を捨てて前のチャンクへ吸収する
    // (吸収した結果が API の上限を超えるなら捨てない)
    if (nominalCuts.length > 0) {
        const lastCut = nominalCuts[nominalCuts.length - 1];
        const tailSec = durationSec - lastCut;
        const previousCut = nominalCuts.length > 1 ? nominalCuts[nominalCuts.length - 2] : 0;
        const mergedStart = Math.max(0, previousCut - overlapSec);
        if (tailSec < minTailSec && durationSec - mergedStart <= maxAudioSec) {
            nominalCuts.pop();
        }
    }

    const snappedCuts = nominalCuts.map((cut) => {
        const snapped = snapCutToSilence(cut, silences, snapWindowSec);
        return { nominalCutSec: cut, cutSec: snapped ?? cut, snapped: snapped !== null };
    });

    const entries: ChunkPlanEntry[] = [];
    let startSec = 0;
    for (let i = 0; i < snappedCuts.length; i += 1) {
        const { cutSec, nominalCutSec, snapped } = snappedCuts[i];
        entries.push({ index: i, startSec, endSec: cutSec, nominalCutSec, snapped });
        startSec = Math.max(0, cutSec - overlapSec);
    }
    entries.push({
        index: snappedCuts.length,
        startSec,
        endSec: durationSec,
        nominalCutSec: durationSec,
        snapped: false,
    });

    return entries;
};

/**
 * 🔴 発話秒数。silencedetect の区間を引いて出す。**音声長で代用しない** (サーバ側 G6 の分母)。
 */
export const speechSecBetween = (
    silences: readonly SilenceInterval[],
    startSec: number,
    endSec: number,
): number => {
    const span = Math.max(0, endSec - startSec);
    let silent = 0;
    for (const silence of silences) {
        const start = Math.max(silence.startSec, startSec);
        const end = Math.min(silence.endSec, endSec);
        if (end > start) silent += end - start;
    }
    return Math.max(0, span - Math.min(silent, span));
};

/**
 * 🔴 発話**区間**。silencedetect の無音を抜いた補集合を、**チャンク先頭を 0 とした**相対秒で返す。
 * サーバ側 G6 (最長穴) の入力。`speechSecBetween` と同じ走査から出すこと (別の閾値で測ると穴の位置がずれる)。
 */
export const speechIntervalsBetween = (
    silences: readonly SilenceInterval[],
    startSec: number,
    endSec: number,
): Array<[number, number]> => {
    const intervals: Array<[number, number]> = [];
    let cursor = startSec;
    for (const silence of [...silences].sort((a, b) => a.startSec - b.startSec)) {
        if (silence.endSec <= cursor || silence.startSec >= endSec) continue;
        const silenceStart = Math.max(silence.startSec, startSec);
        if (silenceStart > cursor) intervals.push([cursor - startSec, silenceStart - startSec]);
        cursor = Math.max(cursor, Math.min(silence.endSec, endSec));
        if (cursor >= endSec) break;
    }
    if (cursor < endSec) intervals.push([cursor - startSec, endSec - startSec]);
    return intervals;
};

/**
 * 再試行 2 用に、チャンクの範囲を丸ごとずらす (長さは変えない)。
 * 前へずらせなければ後ろへ。どちらも音声の外へ出るなら**ずらさずに元の範囲を返す**
 * (チャンクが音声全体を覆っている場合。ここで縮めると別の失敗様式を混ぜてしまう)。
 */
export const shiftChunkRange = (
    entry: ChunkPlanEntry,
    shiftSec: number,
    durationSec: number,
): ChunkPlanEntry => {
    for (const shift of [shiftSec, -shiftSec]) {
        const startSec = entry.startSec + shift;
        const endSec = entry.endSec + shift;
        if (startSec >= 0 && endSec <= durationSec && endSec > startSec) {
            return { ...entry, startSec, endSec, snapped: false };
        }
    }
    return entry;
};

// ---------------------------------------------------------------------------
// ジョブ本体
// ---------------------------------------------------------------------------

export interface SegmentCutResult {
    success: boolean;
    outputBlob?: Blob;
    error?: string;
}

/** VideoConverter のうちこのジョブが使う口だけ */
export interface ChunkConverterLike {
    getVideoDuration(file: File): Promise<number>;
    convertSegmentToMp3(
        file: File,
        startTimeSec: number,
        endTimeSec: number,
        segmentIndex: number,
        options?: { bitrate?: string; sampleRate?: number },
    ): Promise<SegmentCutResult>;
}

export interface TranscriptionJobDeps {
    converter: ChunkConverterLike;
    scanSilence: SilenceScanner;
    /** チャンク音声を Storage に上げてパスを返す */
    uploadChunk: (blob: Blob, fileName: string) => Promise<string>;
    /** チャンク音声を消す。完了・失敗のいずれでも呼ばれる */
    deleteChunk: (storagePath: string) => Promise<void>;
    postChunk: (
        body: TranscribeChunkRequestBody,
        signal: AbortSignal | undefined,
    ) => Promise<TranscribeChunkResponseBody>;
}

/** 1 回の試行の記録。ここに残った `cachedTokens` が「測り直したか」の証拠になる */
export interface ChunkAttemptRecord {
    attempt: number;
    startSec: number;
    endSec: number;
    audioSec: number;
    speechSec: number;
    /** 境界をずらして切り直した試行か (再試行 2) */
    shifted: boolean;
    storagePath?: string;
    quality?: TranscribeChunkQuality;
    /** 🔴 0 でない = 暗黙キャッシュに当たった = 実際には測り直していない (設計 §3.3) */
    cachedTokens?: number;
    elapsedMs?: number;
    error?: string;
}

export interface TranscriptionChunkResult {
    index: number;
    status: 'completed' | 'failed';
    startSec: number;
    endSec: number;
    text: string;
    annotations: TranscribeChunkResponseBody['annotations'];
    attempts: ChunkAttemptRecord[];
    /** この結果を得た試行が暗黙キャッシュに当たっていたか */
    servedFromCache: boolean;
}

export interface TranscriptionJobOptions extends ChunkPlanOptions {
    signal?: AbortSignal;
    retryShiftSec?: number;
    maxAttempts?: number;
    maxParallel?: number;
    minSilenceSec?: number;
    markdown?: TranscriptMarkdownOptions;
    /** 🔴 部分結果の逐次通知。全部終わるまで黙る設計にしない (設計 §6.3) */
    onChunkSettled?: (chunk: TranscriptionChunkResult) => void;
    onPlan?: (plan: ChunkPlanEntry[], scan: SilenceScan) => void;
}

export interface TranscriptionJobResult {
    /** 全チャンクが合格したときだけ true。1 本でも failed ならジョブは成功にしない */
    ok: boolean;
    aborted: boolean;
    durationSec: number;
    noiseFloorDb: number | null;
    silenceThresholdDb: number;
    chunks: TranscriptionChunkResult[];
    failedChunkIndexes: number[];
    /** 🔴 暗黙キャッシュに当たった走。「再試行したが測り直していない」の証拠 */
    cachedRuns: { chunkIndex: number; attempt: number; cachedTokens: number }[];
    merged: MergedTranscript;
    invariants: MergeInvariantResult;
    markdown: string;
}

const CHUNK_MIME_TYPE = 'audio/mpeg';

class JobAbortedError extends Error {
    constructor() {
        super('文字起こしジョブは中断されました');
        this.name = 'JobAbortedError';
    }
}

const throwIfAborted = (signal: AbortSignal | undefined) => {
    if (signal?.aborted) throw new JobAbortedError();
};

/**
 * 上限つきの並行実行。
 * 🔴 呼び出し側はチャンク 1 を**この外で単独に**走らせること。
 * 話者プレフィックス方式 (将来) はチャンク 1 の結果に直列依存する。
 */
const runWithConcurrency = async <T>(
    tasks: readonly (() => Promise<T>)[],
    limit: number,
): Promise<T[]> => {
    const results = new Array<T>(tasks.length);
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= tasks.length) return;
            results[index] = await tasks[index]();
        }
    };
    const workerCount = Math.max(1, Math.min(limit, tasks.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
};

/**
 * 1 チャンクを、再試行ラダー (通常 → 境界ずらし → 同一再投入) つきで確定させる。
 * 使ったチャンク音声のパスは `uploadedPaths` に積み、後片付けは呼び出し側が行う。
 */
const runChunk = async (
    file: File,
    entry: ChunkPlanEntry,
    context: {
        deps: TranscriptionJobDeps;
        durationSec: number;
        silences: readonly SilenceInterval[];
        signal: AbortSignal | undefined;
        retryShiftSec: number;
        maxAttempts: number;
        uploadedPaths: string[];
        baseFileName: string;
    },
): Promise<TranscriptionChunkResult> => {
    const { deps, durationSec, silences, signal, retryShiftSec, maxAttempts, uploadedPaths, baseFileName } = context;
    const attempts: ChunkAttemptRecord[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(signal);

        // 試行 2 だけ境界をずらして切り直す。試行 3 は試行 1 と同じ範囲の再投入
        const range = attempt === 2 ? shiftChunkRange(entry, retryShiftSec, durationSec) : entry;
        // 音声全体を覆うチャンクはずらせない。その場合 shifted は false のまま (嘘をつかない)
        const shifted = range.startSec !== entry.startSec || range.endSec !== entry.endSec;
        const audioSec = range.endSec - range.startSec;
        // 🔴 音声長ではなく silencedetect 由来の発話秒数。サーバ側 G6 の分母
        const speechSec = speechSecBetween(silences, range.startSec, range.endSec);
        // 🔴 総量とは別に区間も渡す。総量だけだとサーバ側 G6 が走らず indeterminate になる
        const speechIntervals = speechIntervalsBetween(silences, range.startSec, range.endSec);
        const record: ChunkAttemptRecord = {
            attempt,
            startSec: range.startSec,
            endSec: range.endSec,
            audioSec,
            speechSec,
            shifted,
        };
        attempts.push(record);

        try {
            const cut = await deps.converter.convertSegmentToMp3(
                file,
                range.startSec,
                range.endSec,
                entry.index,
            );
            if (!cut.success || !cut.outputBlob) {
                record.error = cut.error ?? 'チャンクの切り出しに失敗しました';
                continue;
            }

            throwIfAborted(signal);
            const fileName = `${baseFileName}_chunk${entry.index}_try${attempt}`;
            const storagePath = await deps.uploadChunk(cut.outputBlob, fileName);
            record.storagePath = storagePath;
            uploadedPaths.push(storagePath);

            throwIfAborted(signal);
            const response = await deps.postChunk(
                {
                    storagePath,
                    fileName: `${fileName}.mp3`,
                    mimeType: CHUNK_MIME_TYPE,
                    audioSec,
                    speechSec,
                    speechIntervals,
                },
                signal,
            );
            record.quality = response.quality;
            record.cachedTokens = response.cachedTokens;
            record.elapsedMs = response.elapsedMs;

            if (response.quality.passed) {
                return {
                    index: entry.index,
                    status: 'completed',
                    startSec: range.startSec,
                    endSec: range.endSec,
                    text: response.text,
                    annotations: response.annotations,
                    attempts,
                    servedFromCache: (response.cachedTokens ?? 0) > 0,
                };
            }
        } catch (error) {
            if (error instanceof JobAbortedError) throw error;
            record.error = error instanceof Error ? error.message : String(error);
            jobLogger.warn('チャンクの試行に失敗', { index: entry.index, attempt, error: record.error });
        }
    }

    // 全滅。🔴 ここを completed にしない — 欠落したまま「成功」を返すのが一番まずい
    return {
        index: entry.index,
        status: 'failed',
        startSec: entry.startSec,
        endSec: entry.endSec,
        text: '',
        annotations: [],
        attempts,
        servedFromCache: false,
    };
};

const toMergeChunk = (chunk: TranscriptionChunkResult): MergeChunk => ({
    index: chunk.index,
    startSec: chunk.startSec,
    // 話者プレフィックス方式は未導入。導入時はここに連結した秒数が入る
    prefixSec: 0,
    endSec: chunk.endSec,
    annotations: chunk.annotations.map((annotation) => ({
        text: annotation.text,
        startOffsetSec: annotation.startOffsetSec,
        endOffsetSec: annotation.endOffsetSec,
        speaker: annotation.speaker,
    })),
    failed: chunk.status === 'failed',
});

/**
 * 分割 → 文字起こし → 結合を通しで走らせる。React には依存しない。
 */
export const runTranscriptionJob = async (
    file: File,
    deps: TranscriptionJobDeps,
    options: TranscriptionJobOptions = {},
): Promise<TranscriptionJobResult> => {
    const {
        signal,
        retryShiftSec = DEFAULT_RETRY_SHIFT_SEC,
        maxAttempts = MAX_CHUNK_ATTEMPTS,
        maxParallel = MAX_PARALLEL_CHUNKS,
        minSilenceSec = DEFAULT_MIN_SILENCE_SEC,
        markdown: markdownOptions,
        onChunkSettled,
        onPlan,
        ...planOptions
    } = options;

    const uploadedPaths: string[] = [];
    const settled: TranscriptionChunkResult[] = [];
    let aborted = false;

    try {
        throwIfAborted(signal);
        const durationSec = await deps.converter.getVideoDuration(file);

        throwIfAborted(signal);
        const scan = await deps.scanSilence(file, { durationSec, minSilenceSec });
        const plan = planChunks(durationSec, { ...planOptions, silences: scan.intervals });
        onPlan?.(plan, scan);

        const baseFileName = file.name.replace(/\.[^.]+$/, '') || 'audio';
        const context = {
            deps,
            durationSec,
            silences: scan.intervals,
            signal,
            retryShiftSec,
            maxAttempts,
            uploadedPaths,
            baseFileName,
        };

        const settle = (chunk: TranscriptionChunkResult) => {
            settled.push(chunk);
            // 🔴 逐次通知。全部終わってからまとめて返さない
            onChunkSettled?.(chunk);
            return chunk;
        };

        try {
            if (plan.length > 0) {
                // 🔴 チャンク 1 は単独で先に。話者プレフィックス方式は前のチャンクへ直列依存する
                settle(await runChunk(file, plan[0], context));
                await runWithConcurrency(
                    plan.slice(1).map((entry) => async () => settle(await runChunk(file, entry, context))),
                    maxParallel,
                );
            }
        } catch (error) {
            if (!(error instanceof JobAbortedError)) throw error;
            aborted = true;
        }

        const chunks = [...settled].sort((a, b) => a.index - b.index);
        const mergeChunks = chunks.map(toMergeChunk);
        const merged = mergeTranscriptChunks(mergeChunks);
        const invariants = checkMergeInvariants(merged, mergeChunks);
        const failedChunkIndexes = chunks.filter((c) => c.status === 'failed').map((c) => c.index);
        const cachedRuns = chunks.flatMap((chunk) =>
            chunk.attempts
                .filter((attempt) => (attempt.cachedTokens ?? 0) > 0)
                .map((attempt) => ({
                    chunkIndex: chunk.index,
                    attempt: attempt.attempt,
                    cachedTokens: attempt.cachedTokens as number,
                })),
        );

        return {
            ok: !aborted && failedChunkIndexes.length === 0 && chunks.length === plan.length && plan.length > 0,
            aborted,
            durationSec,
            noiseFloorDb: scan.noiseFloorDb,
            silenceThresholdDb: scan.thresholdDb,
            chunks,
            failedChunkIndexes,
            cachedRuns,
            merged,
            invariants,
            markdown: toTranscriptMarkdown(merged, markdownOptions),
        };
    } finally {
        // 🔴 チャンク音声は元音声より本数が増える。成功・失敗・中断のいずれでも消す
        await Promise.all(
            uploadedPaths.map((path) =>
                Promise.resolve()
                    .then(() => deps.deleteChunk(path))
                    .catch((error) => {
                        jobLogger.warn('チャンク音声の削除に失敗', { path, error });
                    }),
            ),
        );
    }
};

// ---------------------------------------------------------------------------
// 既定の依存 (実配線用)
// ---------------------------------------------------------------------------

/** チャンク音声を Storage へ上げる */
export const defaultUploadChunk = (blob: Blob, fileName: string): Promise<string> =>
    uploadAudioToStorage(blob, fileName, {
        originalFileName: fileName,
        originalFileType: 'audio',
    });

/** チャンク音声を消す */
export const defaultDeleteChunk = async (storagePath: string): Promise<void> => {
    await deleteAudioFromStorage(storagePath);
};

/** `/api/transcribe/chunk` を叩く */
export const defaultPostChunk = async (
    body: TranscribeChunkRequestBody,
    signal: AbortSignal | undefined,
): Promise<TranscribeChunkResponseBody> => {
    const response = await fetch(TRANSCRIBE_CHUNK_API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message =
            payload && typeof payload === 'object' && 'message' in payload
                ? String((payload as { message: unknown }).message)
                : `HTTP ${response.status}`;
        throw new Error(message);
    }
    return payload as TranscribeChunkResponseBody;
};

// ---------------------------------------------------------------------------
// React フック (中核の薄い包み)
// ---------------------------------------------------------------------------

export interface TranscriptionJobState {
    status: 'idle' | 'running' | 'completed' | 'failed' | 'aborted';
    /** 逐次追記される部分結果 (UI はこれを出す) */
    chunks: TranscriptionChunkResult[];
    plan: ChunkPlanEntry[];
    result: TranscriptionJobResult | null;
    error: string | null;
}

const INITIAL_STATE: TranscriptionJobState = {
    status: 'idle',
    chunks: [],
    plan: [],
    result: null,
    error: null,
};

export const useTranscriptionJob = (deps: TranscriptionJobDeps) => {
    const [state, setState] = useState<TranscriptionJobState>(INITIAL_STATE);
    const abortRef = useRef<AbortController | null>(null);

    const cancel = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    const start = useCallback(
        async (file: File, options: TranscriptionJobOptions = {}) => {
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            setState({ ...INITIAL_STATE, status: 'running' });

            try {
                const result = await runTranscriptionJob(file, deps, {
                    ...options,
                    signal: options.signal ?? controller.signal,
                    onPlan: (plan, scan) => {
                        setState((current) => ({ ...current, plan }));
                        options.onPlan?.(plan, scan);
                    },
                    onChunkSettled: (chunk) => {
                        setState((current) => ({
                            ...current,
                            chunks: [...current.chunks, chunk].sort((a, b) => a.index - b.index),
                        }));
                        options.onChunkSettled?.(chunk);
                    },
                });
                setState((current) => ({
                    ...current,
                    status: result.aborted ? 'aborted' : result.ok ? 'completed' : 'failed',
                    result,
                }));
                return result;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setState((current) => ({ ...current, status: 'failed', error: message }));
                throw error;
            }
        },
        [deps],
    );

    return { ...state, start, cancel };
};

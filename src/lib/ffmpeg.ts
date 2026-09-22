import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { FFFSType } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { createLogger } from './logger';

export interface ConversionProgress {
    ratio: number;
}

export interface ConversionResult {
    success: boolean;
    outputBlob?: Blob;
    error?: string;
}

export interface SegmentConversionResult {
    success: boolean;
    segmentIndex: number;
    startTime: number;
    endTime: number;
    outputBlob?: Blob;
    error?: string;
}

/** WORKERFS でマウントした入力。`path` を ffmpeg の `-i` に渡し、使い終わったら `unmount()` する */
export interface MountedInput {
    path: string;
    unmount: () => Promise<void>;
}

export interface MediaProbe {
    /** 秒。ログの `Duration: hh:mm:ss.cc` を整数秒に丸めた値 */
    durationSec: number;
    hasAudioStream: boolean;
}

const ffmpegLogger = createLogger('ffmpeg');

/** 使う core の版。`scripts/copy-ffmpeg-core.mjs` が同じ版を `public/ffmpeg/` に置く */
export const FFMPEG_CORE_VERSION = '0.12.6';

/**
 * 🔴 **同一 FFmpeg インスタンスで `exec` を重ねられる回数の予算。**
 *
 * @ffmpeg/core 0.12.x は、同じ worker で `exec` を約 65 回呼ぶと wasm が
 * `memory access out of bounds` / `table index is out of bounds` /
 * `null function or function signature mismatch` で死ぬ（入力サイズに無関係。
 * 67MB の入力を 5 秒区間で回しても 65 回目で落ちる。実測 2026-09-22、
 * upstream ffmpegwasm/ffmpeg.wasm#820）。公式の回避も「worker を作り直す」のみ。
 *
 * 以前の区間変換（1 本 = probe 1 + 区間 60 + 結合 1 = 62 回）は偶然この崖の手前に
 * 居たので単一ファイルは通り、2 本目で必ず崖を越えていた（「複数ファイルを入れると
 * 2 本目がエラー」の正体）。今は 1 本 = probe 1 + 変換 1 の 2 回で、予算に達したら
 * `prepareForInput()` が worker を作り直す。
 */
export const FFMPEG_EXEC_BUDGET = 40;

/** worker が死んだときに exec が投げる文言。これを見たら以後そのインスタンスは使わない */
const WASM_FATAL_PATTERN = /memory access out of bounds|table index is out of bounds|null function or function signature mismatch|unreachable|Aborted\(|RuntimeError/i;

export const isWasmFatalError = (error: unknown): boolean => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return WASM_FATAL_PATTERN.test(text);
};

/** `exec` が wasm ごと死んだことを表す。呼び出し側は `recycle()` してから 1 回だけやり直してよい */
export class FfmpegWorkerDeadError extends Error {
    readonly cause: unknown;
    constructor(message: string, cause: unknown) {
        super(message);
        this.name = 'FfmpegWorkerDeadError';
        this.cause = cause;
    }
}

export const isFfmpegWorkerDeadError = (error: unknown): error is FfmpegWorkerDeadError =>
    error instanceof Error && error.name === 'FfmpegWorkerDeadError';

interface CoreAssets {
    coreURL: string;
    wasmURL: string;
}

/**
 * core の置き場。まず同一オリジン（`public/ffmpeg/`、ビルド時に npm の @ffmpeg/core から複製）を試し、
 * 無ければ unpkg に落ちる。同一オリジンを先にするのは、unpkg の障害で変換が丸ごと止まらないため。
 */
const SELF_HOSTED_CORE_BASE = '/ffmpeg';
const FALLBACK_CORE_BASE = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;

let coreAssetsPromise: Promise<CoreAssets> | null = null;

const selfHostedCoreAvailable = async (): Promise<boolean> => {
    try {
        const response = await fetch(`${SELF_HOSTED_CORE_BASE}/ffmpeg-core.wasm`, { method: 'HEAD' });
        return response.ok;
    } catch {
        return false;
    }
};

const fetchCoreAssets = async (base: string): Promise<CoreAssets> => ({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
});

/**
 * core の Blob URL を 1 度だけ作って共有する。worker を作り直すたびに 32MB の wasm を
 * 取り直さないため（`recycle()` の費用をほぼ load の時間だけにする）。
 */
export const loadCoreAssets = (): Promise<CoreAssets> => {
    if (!coreAssetsPromise) {
        coreAssetsPromise = (async () => {
            if (await selfHostedCoreAvailable()) {
                return fetchCoreAssets(SELF_HOSTED_CORE_BASE);
            }
            ffmpegLogger.warn('同一オリジンの ffmpeg core が無いため unpkg から取得', { fallback: FALLBACK_CORE_BASE });
            return fetchCoreAssets(FALLBACK_CORE_BASE);
        })().catch((error) => {
            // 失敗を握ったままにすると二度と再試行できないので捨てる
            coreAssetsPromise = null;
            throw error;
        });
    }
    return coreAssetsPromise;
};

/** テスト用。共有している core の Blob URL を忘れる */
export const resetCoreAssetsForTests = (): void => {
    coreAssetsPromise = null;
};

const NO_STREAM_PATTERN = /does not contain any stream/;

const parseProbeLog = (message: string, probe: MediaProbe): void => {
    // "Duration: 00:01:23.45" のような形式を探す
    const durationMatch = message.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (durationMatch) {
        probe.durationSec = parseInt(durationMatch[1]) * 3600
            + parseInt(durationMatch[2]) * 60
            + parseInt(durationMatch[3]);
    }
    // "Stream #0:1(und): Audio: aac ..." のようなパターンを探す
    if (message.includes('Stream') && message.includes('Audio:')) {
        probe.hasAudioStream = true;
    }
};

export class VideoConverter {
    private ffmpeg: FFmpeg;
    private isLoaded = false;
    /** このインスタンス（worker）で呼んだ exec の回数。`recycle()` で 0 に戻る */
    private execCount = 0;
    /** exec が wasm ごと死んだ。以後は `recycle()` するまで使わない */
    private dead = false;
    /** 何度 worker を作り直したか。観測用 */
    private generation = 0;
    private mountSequence = 0;

    constructor() {
        this.ffmpeg = new FFmpeg();
    }

    /**
     * 内部の FFmpeg インスタンスを返す。
     *
     * 🔴 `recycle()` で中身が入れ替わるので、参照を保持せず毎回取り直すこと。
     * 呼び出し側は `load()` 済みであることを保証すること。
     */
    getFfmpeg(): FFmpeg {
        return this.ffmpeg;
    }

    /** このインスタンスで呼んだ exec の回数（観測・テスト用） */
    getExecCount(): number {
        return this.execCount;
    }

    getGeneration(): number {
        return this.generation;
    }

    isDead(): boolean {
        return this.dead;
    }

    async load(): Promise<void> {
        if (this.isLoaded) return;

        try {
            await this.ffmpeg.load(await loadCoreAssets());
            this.isLoaded = true;
        } catch (error) {
            ffmpegLogger.error('FFmpegの読み込みに失敗しました:', error);
            throw new Error('FFmpegの初期化に失敗しました');
        }
    }

    /**
     * worker を捨てて作り直す。exec の予算を使い切ったとき・wasm が死んだときに呼ぶ。
     * core の Blob URL は共有しているので、費用は wasm のインスタンス化だけ。
     */
    async recycle(): Promise<void> {
        try {
            this.ffmpeg.terminate();
        } catch {
            // 未ロード・既に死んでいる場合の terminate 失敗は無視
        }
        this.ffmpeg = new FFmpeg();
        this.isLoaded = false;
        this.execCount = 0;
        this.dead = false;
        this.generation += 1;
        await this.load();
        ffmpegLogger.info('FFmpeg worker を作り直した', { generation: this.generation });
    }

    /**
     * 新しい入力を扱う前に呼ぶ。予算切れ・死亡なら作り直し、未ロードなら読み込む。
     * `reserve` は次の入力で使う exec 回数（既定 2 = probe + 変換）。
     */
    async prepareForInput(reserve = 2): Promise<void> {
        if (this.dead || this.execCount + reserve > FFMPEG_EXEC_BUDGET) {
            ffmpegLogger.info('exec 予算に達したため FFmpeg worker を作り直す', {
                execCount: this.execCount, reserve, budget: FFMPEG_EXEC_BUDGET, dead: this.dead,
            });
            await this.recycle();
            return;
        }
        if (!this.isLoaded) {
            await this.load();
        }
    }

    /**
     * exec は必ずここを通す。回数を数え、wasm が死んだ失敗を `FfmpegWorkerDeadError` に包む。
     */
    private async runExec(args: string[]): Promise<number> {
        if (this.dead) {
            throw new FfmpegWorkerDeadError('FFmpeg worker は既に停止しています。', undefined);
        }
        this.execCount += 1;
        try {
            return await this.ffmpeg.exec(args);
        } catch (error) {
            if (isWasmFatalError(error)) {
                this.dead = true;
                ffmpegLogger.error('FFmpeg worker が exec 中に停止', error, {
                    execCount: this.execCount, generation: this.generation,
                });
                throw new FfmpegWorkerDeadError(
                    `FFmpeg の実行環境が停止しました（${error instanceof Error ? error.message : String(error)}）`,
                    error,
                );
            }
            throw error;
        }
    }

    /**
     * 入力ファイルを WORKERFS でマウントする。
     *
     * 🔴 `writeFile(fetchFile(file))` は使わない。ファイル全体を ArrayBuffer に読んでから wasm の
     *    ファイルシステムへ複製するため、2GB 超は `File could not be read` で最初から読めず、
     *    2GB 以下でもレンダラのメモリ峰がファイルサイズの 2 倍になる（1.3GB の動画で 2.4GB）。
     *    WORKERFS は File を読み取り時にだけスライスするので峰は 0.4GB 程度で、2.9GB も通る。
     *    ファイル名は `input.<ext>` に固定する（元の名前に含まれる `:` などを ffmpeg に解釈させない）。
     */
    async mountInput(file: File): Promise<MountedInput> {
        if (!this.isLoaded) {
            await this.load();
        }
        this.mountSequence += 1;
        const mountPoint = `/input_${this.generation}_${this.mountSequence}`;
        const extension = file.name.includes('.') ? file.name.split('.').pop() : 'bin';
        const name = `input.${extension}`;
        await this.ffmpeg.createDir(mountPoint);
        // 🔴 enum は値で import しない。SSR ビルドでは @ffmpeg/ffmpeg が空スタブ (empty.mjs) に解決され、
        //    FFFSType の値が無くて Turbopack が落ちる。文字列は enum の実体と同じ
        await this.ffmpeg.mount('WORKERFS' as FFFSType, { blobs: [{ name, data: file }] }, mountPoint);
        const ffmpeg = this.ffmpeg;
        return {
            path: `${mountPoint}/${name}`,
            unmount: async () => {
                try {
                    await ffmpeg.unmount(mountPoint);
                    await ffmpeg.deleteDir(mountPoint);
                } catch {
                    // 死んだ worker や作り直し後の unmount 失敗は無視
                }
            },
        };
    }

    /**
     * マウント済み入力の長さと音声トラックの有無を取得（exec 1 回）
     */
    async probeInput(inputPath: string): Promise<MediaProbe> {
        const probe: MediaProbe = { durationSec: 0, hasAudioStream: false };
        const logHandler = ({ message }: { message: string }) => parseProbeLog(message, probe);
        this.ffmpeg.on('log', logHandler);
        try {
            // 出力を指定しないので rc≠0 が正常。ログに情報が出る
            await this.runExec(['-i', inputPath]);
        } catch (error) {
            if (isFfmpegWorkerDeadError(error)) throw error;
            // rc≠0 は worker が例外にしないので、ここに来るのは想定外の失敗だけ
            ffmpegLogger.warn('probe の exec が例外で終了', { reason: error instanceof Error ? error.message : String(error) });
        } finally {
            this.ffmpeg.off('log', logHandler);
        }

        if (probe.durationSec === 0) {
            throw new Error('動画の長さを取得できませんでした');
        }
        if (!probe.hasAudioStream) {
            throw new Error('この動画には音声トラックが含まれていません。音声付きの動画をアップロードしてください。');
        }
        return probe;
    }

    /**
     * マウント済み入力を 1 回の exec で mono MP3 にする。
     * 区間には切らない（切ると exec 回数がそのまま増え、FFMPEG_EXEC_BUDGET の崖に近づく）。
     */
    async convertInputToMp3(
        inputPath: string,
        options: {
            bitrate?: string;
            sampleRate?: number;
            onProgress?: (progress: ConversionProgress) => void;
        } = {}
    ): Promise<Blob> {
        const { bitrate = '192k', sampleRate = 44100, onProgress } = options;
        const outputFileName = `output_${this.generation}_${Date.now()}.mp3`;
        const ffmpegLogs: string[] = [];
        const logHandler = ({ message }: { message: string }) => {
            ffmpegLogs.push(message);
            if (ffmpegLogs.length > 40) ffmpegLogs.shift();
        };
        const progressHandler = ({ progress }: { progress: number }) => {
            onProgress?.({ ratio: Math.max(0, Math.min(1, progress)) });
        };

        this.ffmpeg.on('log', logHandler);
        this.ffmpeg.on('progress', progressHandler);
        try {
            const rc = await this.runExec([
                '-i', inputPath,
                '-vn', // 映像は捨てる
                '-sn', // 字幕トラック（mov_text 等）も捨てる
                '-acodec', 'libmp3lame',
                // Azure batch の diarization は mono 音声でのみ有効。stereo だと話者ラベルが付かない
                '-ac', '1',
                '-ab', bitrate,
                '-ar', sampleRate.toString(),
                '-y',
                outputFileName,
            ]);
            if (rc !== 0) {
                if (ffmpegLogs.some(log => NO_STREAM_PATTERN.test(log))) {
                    throw new Error('この動画には音声トラックが含まれていません。音声付きの動画をアップロードしてください。');
                }
                throw new Error(`FFmpeg実行失敗 (rc=${rc}): ${ffmpegLogs.slice(-3).join(' | ')}`);
            }
            const data = await this.ffmpeg.readFile(outputFileName);
            return new Blob([new Uint8Array(data as Uint8Array)], { type: 'audio/mpeg' });
        } catch (error) {
            ffmpegLogger.error('音声変換エラー:', error, { recentLogs: ffmpegLogs.slice(-10) });
            throw error;
        } finally {
            this.ffmpeg.off('progress', progressHandler);
            this.ffmpeg.off('log', logHandler);
            if (!this.dead) {
                try {
                    await this.ffmpeg.deleteFile(outputFileName);
                } catch {
                    // 出力が無い（失敗時）・削除失敗は無視
                }
            }
        }
    }

    /**
     * 動画の指定区間を音声に変換（入力ファイル名を指定）
     *
     * 🔴 区間ごとに exec を 1 回使う。区間の数だけ FFMPEG_EXEC_BUDGET を消費するので、
     *    本体の変換は `convertInputToMp3`（1 exec）を使う。ここは e2e の崖再現と旧経路の互換用。
     */
    async convertSegmentToMp3(
        videoFile: File,
        startTime: number,
        endTime: number,
        segmentIndex: number,
        options: {
            bitrate?: string;
            sampleRate?: number;
            onProgress?: (progress: ConversionProgress) => void;
            inputFileName?: string; // 既に書き込み済み（またはマウント済み）のファイル名
        } = {}
    ): Promise<SegmentConversionResult> {
        if (!this.isLoaded) {
            await this.load();
        }

        const { bitrate = '192k', sampleRate = 44100, onProgress, inputFileName: providedInputFileName } = options;

        // 入力ファイル名が提供されていない場合は新しく作成
        const inputFileName = providedInputFileName || `input_seg${segmentIndex}_${Date.now()}.${videoFile.name.split('.').pop()}`;
        const outputFileName = `output_seg${segmentIndex}_${Date.now()}.mp3`;
        const shouldWriteFile = !providedInputFileName; // 入力ファイル名が提供されていない場合のみ書き込み
        const shouldDeleteInputFile = shouldWriteFile; // 自分で書き込んだ場合のみ削除

        // FFmpegログの収集
        const ffmpegLogs: string[] = [];
        const logHandler = ({ message }: { message: string }) => {
            ffmpegLogs.push(message);
        };

        try {
            ffmpegLogger.info(`[区間${segmentIndex}] 変換開始:`, {
                fileName: videoFile.name,
                fileSize: videoFile.size,
                startTime,
                endTime,
                inputFileName,
                outputFileName,
                shouldWriteFile
            });

            // ログハンドラーを設定
            this.ffmpeg.on('log', logHandler);

            // ファイルをFFmpegに書き込み（必要な場合のみ）
            if (shouldWriteFile) {
                ffmpegLogger.info(`[区間${segmentIndex}] ファイル書き込み開始 (${videoFile.size} bytes)`);
                try {
                    const fileData = await fetchFile(videoFile);
                    ffmpegLogger.info(`[区間${segmentIndex}] fetchFile完了 (${fileData.byteLength} bytes)`);
                    await this.ffmpeg.writeFile(inputFileName, fileData);
                    ffmpegLogger.info(`[区間${segmentIndex}] writeFile完了`);
                } catch (writeError) {
                    ffmpegLogger.error(`[区間${segmentIndex}] ファイル書き込みエラー:`, writeError);
                    throw new Error(`ファイル書き込み失敗: ${writeError instanceof Error ? writeError.message : '不明なエラー'}`);
                }
            } else {
                ffmpegLogger.info(`[区間${segmentIndex}] ファイル書き込みスキップ（既存ファイル使用: ${inputFileName}）`);
            }

            // 進捗監視のハンドラーを定義
            const progressHandler = ({ progress }: { progress: number }) => {
                if (onProgress) {
                    onProgress({ ratio: progress });
                }
            };

            // 進捗監視の設定
            this.ffmpeg.on('progress', progressHandler);

            try {
                ffmpegLogger.info(`[区間${segmentIndex}] FFmpeg exec開始`);
                // 区間を指定してMP3に変換
                await this.runExec([
                    '-ss', startTime.toString(),
                    '-to', endTime.toString(),
                    '-i', inputFileName,
                    '-vn', // ビデオストリームを無効化
                    '-acodec', 'libmp3lame',
                    // Azure batch の diarization は mono 音声でのみ有効。stereo だと話者ラベルが付かない
                    '-ac', '1',
                    '-ab', bitrate,
                    '-ar', sampleRate.toString(),
                    '-y', // 出力ファイルを上書き
                    outputFileName
                ]);
                ffmpegLogger.info(`[区間${segmentIndex}] FFmpeg exec完了`);
            } catch (execError) {
                ffmpegLogger.error(`[区間${segmentIndex}] FFmpeg実行エラー:`, execError);
                ffmpegLogger.error(
                    `[区間${segmentIndex}] FFmpegログ`,
                    undefined,
                    { recentLogs: ffmpegLogs.slice(-10) },
                ); // 最後の10行のみ

                // 音声トラックがない場合の特別なエラーメッセージ
                const hasNoStreamError = ffmpegLogs.some(log =>
                    log.includes('Output file #0 does not contain any stream') ||
                    log.includes('does not contain any stream')
                );

                if (hasNoStreamError) {
                    throw new Error('この動画には音声トラックが含まれていません。音声付きの動画をアップロードしてください。');
                }

                throw new Error(`FFmpeg実行失敗: ${execError instanceof Error ? execError.message : '不明なエラー'}`);
            } finally {
                // 進捗監視を解除
                this.ffmpeg.off('progress', progressHandler);
            }

            // 出力ファイルを読み取り
            ffmpegLogger.info(`[区間${segmentIndex}] 出力ファイル読み取り開始`);
            const data = await this.ffmpeg.readFile(outputFileName);
            const uint8Array = new Uint8Array(data as Uint8Array);
            const outputBlob = new Blob([uint8Array], { type: 'audio/mpeg' });
            ffmpegLogger.info(`[区間${segmentIndex}] 出力Blob作成完了 (${outputBlob.size} bytes)`);

            // 一時ファイルを削除
            if (shouldDeleteInputFile) {
                try {
                    await this.ffmpeg.deleteFile(inputFileName);
                } catch {
                    // 削除エラーは無視
                }
            }
            try {
                await this.ffmpeg.deleteFile(outputFileName);
            } catch {
                // 削除エラーは無視
            }

            return {
                success: true,
                segmentIndex,
                startTime,
                endTime,
                outputBlob
            };
        } catch (error) {
            ffmpegLogger.error(`区間${segmentIndex}の変換エラー:`, error);
            ffmpegLogger.error(
                `[区間${segmentIndex}] FFmpegログ (全体)`,
                undefined,
                { recentLogs: ffmpegLogs.slice(-20) },
            ); // 最後の20行

            // エラー時もクリーンアップを試みる（死んだ worker には送らない）
            if (!this.dead) {
                if (shouldDeleteInputFile) {
                    try {
                        await this.ffmpeg.deleteFile(inputFileName);
                    } catch {
                        // 削除エラーは無視
                    }
                }
                try {
                    await this.ffmpeg.deleteFile(outputFileName);
                } catch {
                    // 削除エラーは無視
                }
            }

            return {
                success: false,
                segmentIndex,
                startTime,
                endTime,
                error: error instanceof Error ? error.message : '不明なエラーが発生しました'
            };
        } finally {
            // ログハンドラーを解除
            this.ffmpeg.off('log', logHandler);
        }
    }

    /**
     * 複数の音声セグメントを1つのファイルに結合
     */
    async concatenateAudioSegments(segments: Blob[]): Promise<ConversionResult> {
        if (!this.isLoaded) {
            await this.load();
        }

        if (segments.length === 0) {
            return {
                success: false,
                error: '結合する音声セグメントがありません'
            };
        }

        // セグメントが1つだけの場合は結合不要
        if (segments.length === 1) {
            return {
                success: true,
                outputBlob: segments[0]
            };
        }

        const timestamp = Date.now();
        const concatListFileName = `concat_list_${timestamp}.txt`;
        const outputFileName = `output_concat_${timestamp}.mp3`;

        try {
            // セグメントをFFmpegに書き込み、concatリストを作成
            const fileList: string[] = [];
            for (let i = 0; i < segments.length; i++) {
                const segmentFileName = `segment_${i}_${timestamp}.mp3`;
                const segmentData = new Uint8Array(await segments[i].arrayBuffer());
                await this.ffmpeg.writeFile(segmentFileName, segmentData);
                fileList.push(`file '${segmentFileName}'`);
            }

            // concat用のテキストファイルを作成
            const concatListContent = fileList.join('\n');
            await this.ffmpeg.writeFile(
                concatListFileName,
                new TextEncoder().encode(concatListContent)
            );

            // FFmpegのconcatプロトコルで結合
            await this.runExec([
                '-f', 'concat',
                '-safe', '0',
                '-i', concatListFileName,
                '-c', 'copy',
                '-y',
                outputFileName
            ]);

            // 出力ファイルを読み取り
            const data = await this.ffmpeg.readFile(outputFileName);
            const uint8Array = new Uint8Array(data as Uint8Array);
            const outputBlob = new Blob([uint8Array], { type: 'audio/mpeg' });

            // 一時ファイルを削除
            try {
                await this.ffmpeg.deleteFile(concatListFileName);
                await this.ffmpeg.deleteFile(outputFileName);
                for (let i = 0; i < segments.length; i++) {
                    await this.ffmpeg.deleteFile(`segment_${i}_${timestamp}.mp3`);
                }
            } catch {
                // 削除エラーは無視
            }

            return {
                success: true,
                outputBlob
            };
        } catch (error) {
            ffmpegLogger.error('音声結合エラー:', error);

            // エラー時もクリーンアップを試みる
            if (!this.dead) {
                try {
                    await this.ffmpeg.deleteFile(concatListFileName);
                    await this.ffmpeg.deleteFile(outputFileName);
                    for (let i = 0; i < segments.length; i++) {
                        await this.ffmpeg.deleteFile(`segment_${i}_${timestamp}.mp3`);
                    }
                } catch {
                    // 削除エラーは無視
                }
            }

            return {
                success: false,
                error: error instanceof Error ? error.message : '音声結合に失敗しました'
            };
        }
    }

    /**
     * 🔴 旧経路。ファイル全体を `writeFile` で複製するため 2GB 超は読めない。
     *    新しい呼び出し側は `mountInput` + `convertInputToMp3` を使う。
     */
    async convertToMp3(
        videoFile: File,
        options: {
            bitrate?: string;
            sampleRate?: number;
            onProgress?: (progress: ConversionProgress) => void;
        } = {}
    ): Promise<ConversionResult> {
        if (!this.isLoaded) {
            await this.load();
        }

        const { bitrate = '192k', sampleRate = 44100, onProgress } = options;

        const inputFileName = `input_${Date.now()}.${videoFile.name.split('.').pop()}`;
        const outputFileName = `output_${Date.now()}.mp3`;

        try {
            // ファイルをFFmpegに書き込み
            await this.ffmpeg.writeFile(inputFileName, await fetchFile(videoFile));

            // 進捗監視のハンドラーを定義
            const progressHandler = ({ progress }: { progress: number }) => {
                if (onProgress) {
                    onProgress({ ratio: progress });
                }
            };

            // 進捗監視の設定
            this.ffmpeg.on('progress', progressHandler);

            try {
                // MP3に変換
                await this.runExec([
                    '-i', inputFileName,
                    '-vn', // ビデオストリームを無効化
                    '-acodec', 'libmp3lame',
                    // Azure batch の diarization は mono 音声でのみ有効。stereo だと話者ラベルが付かない
                    '-ac', '1',
                    '-ab', bitrate,
                    '-ar', sampleRate.toString(),
                    '-y', // 出力ファイルを上書き
                    outputFileName
                ]);
            } finally {
                // 進捗監視を解除
                this.ffmpeg.off('progress', progressHandler);
            }

            // 出力ファイルを読み取り
            const data = await this.ffmpeg.readFile(outputFileName);
            // Uint8Arrayに変換してからBlobを作成
            const uint8Array = new Uint8Array(data as Uint8Array);
            const outputBlob = new Blob([uint8Array], { type: 'audio/mpeg' });

            // 一時ファイルを削除（エラーを無視）
            try {
                await this.ffmpeg.deleteFile(inputFileName);
            } catch {
                // 削除エラーは無視
            }
            try {
                await this.ffmpeg.deleteFile(outputFileName);
            } catch {
                // 削除エラーは無視
            }

            return {
                success: true,
                outputBlob
            };
        } catch (error) {
            ffmpegLogger.error('変換エラー:', error);

            // エラー時もクリーンアップを試みる
            if (!this.dead) {
                try {
                    await this.ffmpeg.deleteFile(inputFileName);
                } catch {
                    // 削除エラーは無視
                }
                try {
                    await this.ffmpeg.deleteFile(outputFileName);
                } catch {
                    // 削除エラーは無視
                }
            }

            return {
                success: false,
                error: error instanceof Error ? error.message : '不明なエラーが発生しました'
            };
        }
    }

    async convertMultipleToMp3(
        videoFiles: File[],
        options: {
            bitrate?: string;
            sampleRate?: number;
            onProgress?: (fileIndex: number, progress: ConversionProgress) => void;
        } = {}
    ): Promise<ConversionResult[]> {
        const results: ConversionResult[] = [];

        for (let i = 0; i < videoFiles.length; i++) {
            const file = videoFiles[i];
            const result = await this.convertToMp3(file, {
                ...options,
                onProgress: (progress) => {
                    if (options.onProgress) {
                        options.onProgress(i, progress);
                    }
                }
            });
            results.push(result);
        }

        return results;
    }

    // サポートされている動画形式をチェック
    static isSupportedFormat(file: File): boolean {
        const supportedFormats = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
        const extension = file.name.split('.').pop()?.toLowerCase();
        return extension ? supportedFormats.includes(extension) : false;
    }
}

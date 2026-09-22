import { isFfmpegWorkerDeadError, VideoConverter } from '@/lib/ffmpeg';
import { FileWithPrompts, FileProcessingStatus, SegmentStatus, DebugErrorMode } from '@/types/processing';
import { reportHandledError } from '@/lib/clientErrorReporter';
import { createLogger } from './logger';

/**
 * 動画 → 音声変換（ブラウザ内 FFmpeg.wasm）
 *
 * 🔴 2026-09-22 に区間分割（30 秒 × 最大 60 区間 → 結合）をやめ、1 ファイル = probe 1 回 + 変換 1 回にした。
 *
 * 経緯: 区間分割は「区間ごとに wasm メモリが累積する」対策として入っていたが、実測すると累積の正体は
 * メモリではなく **同一 worker の exec 回数**（約 65 回で wasm が死ぬ。`FFMPEG_EXEC_BUDGET` の説明を参照）。
 * 区間 60 + probe + 結合 = 62 回は偶然その手前で、2 本目のファイルで必ず越えていた。
 * 区間を無くせば 1 本 2 回で済み、入力を WORKERFS でマウントすれば（`VideoConverter.mountInput`）
 * 3.6 時間 / 1.3GB の変換が 2 分・レンダラのメモリ峰 0.4GB で終わる（区間方式と同じ速さ、峰は 1/6）。
 *
 * 画面（ProcessingStatusList）と再開計画（useProcessingWorkflow.resolveResumePlan）は `segments` を
 * 見るので、**1 本を「区間 1 つ」として表す**。再開は常に丸ごとやり直し（2 分の仕事なので区間単位の
 * 再開に価値が無い）。
 */

const videoConversionLogger = createLogger('videoConversion');

/** wasm が死んで作り直したあと、同じ入力をやり直す回数（1 回で足りなければ諦める） */
export const WASM_DEATH_RETRY_LIMIT = 1;

type SetStatuses = React.Dispatch<React.SetStateAction<FileProcessingStatus[]>>;

const updateAt = (
    setProcessingStatuses: SetStatuses,
    fileIndex: number,
    updater: (status: FileProcessingStatus) => FileProcessingStatus,
) => {
    setProcessingStatuses(prev =>
        prev.map((status, idx) => (idx === fileIndex ? updater(status) : status))
    );
};

const failAt = (
    setProcessingStatuses: SetStatuses,
    fileIndex: number,
    error: string,
    segmentError?: string,
) => {
    updateAt(setProcessingStatuses, fileIndex, status => ({
        ...status,
        segments: status.segments.map(segment => ({ ...segment, status: 'error', error: segmentError ?? error })),
        status: 'error',
        error,
        failedPhase: 'audio_conversion',
        isResuming: false,
    }));
};

const wholeSegment = (durationSec: number): SegmentStatus => ({
    segmentIndex: 0,
    startTime: 0,
    endTime: durationSec,
    status: 'converting',
    progress: 0,
});

const describe = (error: unknown): string => (error instanceof Error ? error.message : '不明なエラー');

interface ConversionInput {
    file: FileWithPrompts;
    fileIndex: number;
    converter: VideoConverter;
    bitrate: string;
    sampleRate: number;
    debugErrorMode: DebugErrorMode;
    setProcessingStatuses: SetStatuses;
}

/**
 * 1 回分の試行: マウント → probe → 変換 → アンマウント。
 * wasm が死んだときは `FfmpegWorkerDeadError` をそのまま投げる（呼び出し側が作り直してやり直す）。
 * それ以外の失敗は Error として投げる。
 */
const attemptConversion = async ({
    file, fileIndex, converter, bitrate, sampleRate, debugErrorMode, setProcessingStatuses,
}: ConversionInput): Promise<Blob> => {
    updateAt(setProcessingStatuses, fileIndex, status => ({ ...status, phase: 'video_analysis' }));

    const input = await converter.mountInput(file.file);
    try {
        const probe = await converter.probeInput(input.path);
        videoConversionLogger.info(`[ファイル${fileIndex}] 動画情報取得完了: ${probe.durationSec}秒`, {
            fileName: file.file.name, sizeBytes: file.file.size, execCount: converter.getExecCount(),
        });

        updateAt(setProcessingStatuses, fileIndex, status => ({
            ...status,
            totalDuration: probe.durationSec,
            segmentDuration: probe.durationSec,
            segments: [wholeSegment(probe.durationSec)],
            completedSegmentIndices: [],
            audioConversionProgress: 0,
            phase: 'audio_conversion',
        }));

        // デバッグ用: 意図的にFFmpegエラーを発生させる（区間は 1 つなので区間番号は見ない）
        if (debugErrorMode.ffmpegError && fileIndex === debugErrorMode.errorAtFileIndex) {
            throw new Error('[デバッグ] 意図的に発生させたFFmpegエラー');
        }

        const audioBlob = await converter.convertInputToMp3(input.path, {
            bitrate,
            sampleRate,
            onProgress: (progress) => {
                const percent = Math.round(progress.ratio * 100);
                updateAt(setProcessingStatuses, fileIndex, status => ({
                    ...status,
                    segments: status.segments.map(segment => ({ ...segment, progress: percent })),
                    audioConversionProgress: percent,
                }));
            },
        });

        updateAt(setProcessingStatuses, fileIndex, status => ({
            ...status,
            segments: status.segments.map(segment => ({
                ...segment, status: 'completed', progress: 100, audioBlob,
            })),
            completedSegmentIndices: [0],
            audioConversionProgress: 100,
        }));
        return audioBlob;
    } finally {
        await input.unmount();
    }
};

/**
 * 動画（または変換が必要な音声）をブラウザ内で mono MP3 にする。
 * 失敗はステータスに書いて null を返す（呼び出し側は null だけ見る）。
 *
 * 名前は旧実装（区間分割）のまま。呼び出し側とテストの契約を変えないため。
 */
export const convertVideoToAudioSegments = async (
    file: FileWithPrompts,
    fileIndex: number,
    converter: VideoConverter,
    bitrate: string,
    sampleRate: number,
    debugErrorMode: DebugErrorMode,
    setProcessingStatuses: SetStatuses,
): Promise<Blob | null> => {
    const input: ConversionInput = { file, fileIndex, converter, bitrate, sampleRate, debugErrorMode, setProcessingStatuses };

    for (let attempt = 0; ; attempt++) {
        try {
            // 予算切れ・前回の死亡なら、ここで worker が作り直される
            await converter.prepareForInput();
            return await attemptConversion(input);
        } catch (error) {
            const dead = isFfmpegWorkerDeadError(error);
            videoConversionLogger.error(`[ファイル${fileIndex}] 音声変換に失敗`, error, {
                fileName: file.file.name,
                sizeBytes: file.file.size,
                attempt,
                dead,
                execCount: converter.getExecCount(),
                generation: converter.getGeneration(),
            });

            if (dead && attempt < WASM_DEATH_RETRY_LIMIT) {
                // 作り直しは次の prepareForInput() が行う。同じ入力をもう一度だけ
                videoConversionLogger.warn(`[ファイル${fileIndex}] FFmpeg worker を作り直してやり直す`, { attempt });
                continue;
            }

            const message = dead
                ? '音声変換の実行環境が停止しました。ページを再読み込みしてから、もう一度お試しください。'
                : describe(error);
            failAt(setProcessingStatuses, fileIndex, message, describe(error));

            // 🔴 変換の失敗はブラウザ内で完結し、サーバにも Firestore にも痕跡が残らなかった
            //    （2026-09-22 の複数ファイル不具合は利用者の報告文しか手掛かりが無かった）。
            //    次に同じ報告が来たときに機構を特定できるだけの数字を残す。
            reportHandledError({
                source: 'audio_conversion',
                message: `音声変換に失敗: ${describe(error)}`,
                context: {
                    fileName: file.file.name,
                    sizeBytes: file.file.size,
                    bitrate,
                    sampleRate,
                    attempt,
                    workerDead: dead,
                    execCount: converter.getExecCount(),
                    generation: converter.getGeneration(),
                },
            });
            return null;
        }
    }
};

/**
 * 再開用。区間は 1 つしか無いので、常に丸ごと変換し直す。
 * 名前と引数は旧実装のまま（useProcessingWorkflow とそのテストの契約）。
 */
export const resumeVideoConversion = async (
    file: FileWithPrompts,
    fileIndex: number,
    status: FileProcessingStatus,
    converter: VideoConverter,
    bitrate: string,
    sampleRate: number,
    debugErrorMode: DebugErrorMode,
    setProcessingStatuses: SetStatuses,
): Promise<Blob | null> => {
    videoConversionLogger.info(`[再開] ファイル${fileIndex} を丸ごと変換し直す`, {
        previousSegments: status.segments.length,
        previouslyCompleted: status.completedSegmentIndices.length,
    });
    updateAt(setProcessingStatuses, fileIndex, current => ({
        ...current,
        segments: [],
        completedSegmentIndices: [],
        audioConversionProgress: 0,
    }));
    return convertVideoToAudioSegments(file, fileIndex, converter, bitrate, sampleRate, debugErrorMode, setProcessingStatuses);
};

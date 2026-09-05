import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileProcessingStatus, FileWithPrompts } from '@/types/processing';
import type { JobClaim } from '@/hooks/useVideoProcessing';

const reactHarness = vi.hoisted(() => ({
    stateCursor: 0,
    stateValues: [] as unknown[],
}));

const serviceMocks = vi.hoisted(() => ({
    convertVideoToAudioSegments: vi.fn(),
    resumeVideoConversion: vi.fn(),
    getSupportedMediaKind: vi.fn(),
    ffmpegLoad: vi.fn(),
}));

const ffmpegMocks = vi.hoisted(() => ({
    exec: vi.fn().mockResolvedValue(0),
}));

vi.mock('@ffmpeg/ffmpeg', () => ({
    FFmpeg: class FFmpeg {
        load = vi.fn().mockResolvedValue(undefined);
        exec = ffmpegMocks.exec;
        writeFile = vi.fn().mockResolvedValue(undefined);
        readFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
        deleteFile = vi.fn().mockResolvedValue(undefined);
        on = vi.fn();
        off = vi.fn();
    },
}));
vi.mock('@ffmpeg/util', () => ({
    fetchFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    toBlobURL: vi.fn().mockResolvedValue('blob:synthetic-ffmpeg'),
}));

vi.mock('react', () => ({
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useState: <T>(initialValue: T) => {
        const stateIndex = reactHarness.stateCursor;
        reactHarness.stateCursor += 1;
        reactHarness.stateValues[stateIndex] = initialValue;

        const setState = (nextValue: T | ((current: T) => T)) => {
            const currentValue = reactHarness.stateValues[stateIndex] as T;
            reactHarness.stateValues[stateIndex] = typeof nextValue === 'function'
                ? (nextValue as (current: T) => T)(currentValue)
                : nextValue;
        };

        return [reactHarness.stateValues[stateIndex] as T, setState] as const;
    },
}));

vi.mock('@/lib/videoConversionService', () => ({
    convertVideoToAudioSegments: serviceMocks.convertVideoToAudioSegments,
    resumeVideoConversion: serviceMocks.resumeVideoConversion,
}));
// 🔴 差し替えるのは kind の判定だけ。SUPPORTED_MEDIA_FORMATS は mediaInput が
//    「非圧縮かどうか」を引くのに使うので、実物を残す（丸ごと差し替えると undefined になる）
vi.mock('@/components/FileDropZone', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/FileDropZone')>()),
    getSupportedMediaKind: serviceMocks.getSupportedMediaKind,
}));
vi.mock('@/lib/ffmpeg', () => ({
    VideoConverter: class VideoConverter {
        load() {
            return serviceMocks.ffmpegLoad();
        }
    },
}));
vi.mock('@/lib/gemini', () => ({ GeminiClient: class GeminiClient {} }));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { CONVERSION_QUEUE_WAIT_LIMIT_MS, useProcessingWorkflow } from './useProcessingWorkflow';
import {
    canSendAudioAsIs,
    COMPRESSED_AUDIO_EXTENSIONS,
    UNCOMPRESSED_AUDIO_EXTENSIONS,
} from '@/lib/mediaInput';
import { TRANSCRIPT_PROMPT_ID } from '@/lib/transcriptPrompt';
import { GENERATE_MAX_MEDIA_BYTES } from '@/lib/generateApiContract';

const BITRATE = '192k';
const SAMPLE_RATE = 44100;

/** 既定のサイズは上限内。上限超えを測るテストだけ明示的に大きくする */
const createFile = (name: string, type: string, size = 1024): FileWithPrompts => ({
    file: { name, type, size } as File,
    selectedPromptIds: ['prompt-a'],
});

const createStatus = (
    fileId: string,
    overrides: Partial<FileProcessingStatus> = {}
): FileProcessingStatus => ({
    fileId,
    fileName: `${fileId}.mp4`,
    status: 'error',
    phase: 'waiting',
    audioConversionProgress: 0,
    transcriptionCount: 0,
    totalTranscriptions: 1,
    completedPromptIds: [],
    promptStates: {},
    savePendingPromptIds: [],
    segmentDuration: 30,
    segments: [],
    completedSegmentIndices: [],
    ...overrides,
});

interface Harness {
    statuses: FileProcessingStatus[];
    audioConversionQueueRef: { current: boolean };
    claims: Map<string, { claim: JobClaim; controller: AbortController }>;
    markJobCanceled: ReturnType<typeof vi.fn>;
    processTranscription: ReturnType<typeof vi.fn>;
    processTranscriptionResume: ReturnType<typeof vi.fn>;
    countPendingSaves: ReturnType<typeof vi.fn>;
    workflow: ReturnType<typeof useProcessingWorkflow>;
}

const useWorkflowHarness = (options: {
    sendVideoDirectly?: boolean;
    pendingSave?: boolean;
    /** 残りプロンプトのうち下書きが出来ている件数（混在集合の再現用） */
    pendingSaveCount?: number;
    blockClaimFor?: string[];
    initialStatuses?: FileProcessingStatus[];
} = {}): Harness => {
    reactHarness.stateCursor = 0;
    reactHarness.stateValues = [];

    const state = { statuses: (options.initialStatuses ?? []) as FileProcessingStatus[] };
    const audioConversionQueueRef = { current: false };
    const claims = new Map<string, { claim: JobClaim; controller: AbortController }>();
    const markJobCanceled = vi.fn();
    const processTranscription = vi.fn().mockResolvedValue(undefined);
    const processTranscriptionResume = vi.fn().mockResolvedValue(undefined);
    const countPendingSaves = vi.fn().mockImplementation(
        (_fileId: string, promptIds: readonly string[]) => options.pendingSaveCount
            ?? (options.pendingSave ? promptIds.length : 0)
    );

    const workflow = useProcessingWorkflow({
        converterRef: { current: null },
        geminiClientRef: { current: null },
        audioConversionQueueRef,
        ffmpegLoaded: false,
        setFfmpegLoaded: vi.fn(),
        setProcessingStatuses: (updater) => {
            state.statuses = typeof updater === 'function' ? updater(state.statuses) : updater;
        },
        processTranscription,
        processTranscriptionResume,
        claimJob: (fileId: string) => {
            if (options.blockClaimFor?.includes(fileId)) return null;
            if (claims.has(fileId)) return null;

            const controller = new AbortController();
            const claim: JobClaim = {
                signal: controller.signal,
                release: () => claims.delete(fileId),
            };
            claims.set(fileId, { claim, controller });
            return claim;
        },
        markJobCanceled,
        countPendingSaves,
        debugErrorMode: {
            ffmpegError: false,
            geminiError: false,
            errorAtFileIndex: -1,
            errorAtSegmentIndex: -1,
        },
        sendVideoDirectly: options.sendVideoDirectly,
    });

    return {
        get statuses() {
            return state.statuses;
        },
        audioConversionQueueRef,
        claims,
        markJobCanceled,
        processTranscription,
        processTranscriptionResume,
        countPendingSaves,
        workflow,
    };
};

beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.getSupportedMediaKind.mockImplementation((file: File) =>
        file.type.startsWith('audio/') ? 'audio' : 'video'
    );
    serviceMocks.convertVideoToAudioSegments.mockResolvedValue(
        new Blob(['audio'], { type: 'audio/mpeg' })
    );
    serviceMocks.resumeVideoConversion.mockResolvedValue(
        new Blob(['audio'], { type: 'audio/mpeg' })
    );
    serviceMocks.ffmpegLoad.mockResolvedValue(undefined);
});

describe('Azure batch 用の MP3 変換', () => {
    it.each(['whole', 'segment'] as const)('%s 変換は指定した bitrate / sampleRate を保ち mono を出力する', async (mode) => {
        const { VideoConverter } = await vi.importActual<typeof import('@/lib/ffmpeg')>('@/lib/ffmpeg');
        const converter = new VideoConverter();
        const file = createFile('synthetic.mp4', 'video/mp4').file;
        const options = { bitrate: '96k', sampleRate: 16000 };

        const result = mode === 'segment'
            ? await converter.convertSegmentToMp3(file, 5, 20, 0, options)
            : await converter.convertToMp3(file, options);

        expect(result.success).toBe(true);
        expect(result.outputBlob?.type).toBe('audio/mpeg');
        expect(ffmpegMocks.exec).toHaveBeenCalledOnce();
        expect(ffmpegMocks.exec).toHaveBeenCalledWith([
            ...(mode === 'segment' ? ['-ss', '5', '-to', '20'] : []),
            '-i', expect.stringMatching(/^input_.*\.mp4$/),
            '-vn',
            '-acodec', 'libmp3lame',
            '-ac', '1',
            '-ab', '96k',
            '-ar', '16000',
            '-y', expect.stringMatching(/^output_.*\.mp3$/),
        ]);
    });
});

describe('handleStartProcessing cancellation', () => {
    it('writes a terminal status for files still waiting when the run is canceled', async () => {
        const harness = useWorkflowHarness();
        const files = [createFile('first.mp4', 'video/mp4'), createFile('second.mp4', 'video/mp4')];

        // 1本目の変換中に利用者が中止した状況を再現する
        serviceMocks.convertVideoToAudioSegments.mockImplementationOnce(async () => {
            harness.claims.forEach(({ controller }) => controller.abort(new Error('中止しました。')));
            return null;
        });

        await harness.workflow.handleStartProcessing(files, ['f1', 'f2'], BITRATE, SAMPLE_RATE);

        expect(harness.markJobCanceled).toHaveBeenCalledWith('f2', '中止しました。');
        // V4: 中止済みのファイルは変換そのものを始めない（1本目の1回だけ）
        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
        expect(harness.processTranscription).not.toHaveBeenCalled();
        const secondStatus = harness.statuses.find(status => status.fileId === 'f2');
        expect(secondStatus?.status).not.toBe('completed');
    });

    it('does not start generation when the job is canceled during its own conversion', async () => {
        const harness = useWorkflowHarness();
        const files = [createFile('only.mp4', 'video/mp4')];

        serviceMocks.convertVideoToAudioSegments.mockImplementationOnce(async () => {
            harness.claims.get('f1')?.controller.abort(new Error('変換中に中止しました。'));
            return new Blob(['audio'], { type: 'audio/mpeg' });
        });

        await harness.workflow.handleStartProcessing(files, ['f1'], BITRATE, SAMPLE_RATE);

        expect(harness.processTranscription).not.toHaveBeenCalled();
        expect(harness.markJobCanceled).toHaveBeenCalledWith('f1', '変換中に中止しました。');
    });
});

describe('handleStartProcessing failure reporting', () => {
    it('rolls back the waiting statuses and reports why the run could not start', async () => {
        const harness = useWorkflowHarness({ blockClaimFor: ['f1'] });
        const files = [createFile('only.mp4', 'video/mp4')];

        const result = await harness.workflow.handleStartProcessing(
            files, ['f1'], BITRATE, SAMPLE_RATE
        );

        expect(result.ok).toBe(false);
        expect(result.message).toBeTruthy();
        expect(harness.statuses).toEqual([]);
        expect(reactHarness.stateValues[0]).toBe(result.message);
    });

    it('reports a mismatch between files and their ids without starting anything', async () => {
        const harness = useWorkflowHarness();
        const files = [createFile('only.mp4', 'video/mp4')];

        const result = await harness.workflow.handleStartProcessing(files, [], BITRATE, SAMPLE_RATE);

        expect(result.ok).toBe(false);
        expect(reactHarness.stateValues[0]).toBe(result.message);
        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
    });

    it('marks every file as an engine failure when FFmpeg cannot load', async () => {
        const harness = useWorkflowHarness();
        serviceMocks.ffmpegLoad.mockRejectedValue(new Error('wasm load failed'));

        const result = await harness.workflow.handleStartProcessing(
            [createFile('only.mp4', 'video/mp4')], ['f1'], BITRATE, SAMPLE_RATE
        );

        expect(result.ok).toBe(false);
        expect(harness.statuses[0]).toMatchObject({ status: 'error', failedPhase: 'engine_init' });
        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
    });

    it('全文文字起こしでも、そのまま送れる音声には FFmpeg を読み込まない', async () => {
        // バッチ経路では分割・無音走査をせず、元の音声をそのままアップロードする。
        const harness = useWorkflowHarness();
        const file = createFile('talk.mp3', 'audio/mpeg');
        file.selectedPromptIds = [TRANSCRIPT_PROMPT_ID];
        serviceMocks.ffmpegLoad.mockRejectedValue(new Error('wasm unavailable'));

        const result = await harness.workflow.handleStartProcessing([file], ['f1'], BITRATE, SAMPLE_RATE);

        expect(result.ok).toBe(true);
        expect(serviceMocks.ffmpegLoad).not.toHaveBeenCalled();
        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
        expect(harness.processTranscription).toHaveBeenCalledWith(
            expect.objectContaining({ file }), file.file, BITRATE, SAMPLE_RATE
        );
    });

    it('does not load FFmpeg when every input is audio', async () => {
        const harness = useWorkflowHarness();

        await harness.workflow.handleStartProcessing(
            [createFile('only.mp3', 'audio/mpeg')], ['f1'], BITRATE, SAMPLE_RATE
        );

        expect(serviceMocks.ffmpegLoad).not.toHaveBeenCalled();
        expect(harness.processTranscription).toHaveBeenCalledTimes(1);
    });
});

/**
 * 🔴 実害 (2026-09-04): 1時間22分の WAV は 301MB あり、Storage ルールの 100MB 上限に当たって
 * `storage/unauthorized`（権限がありません）になっていた。音声入力は変換を丸ごと飛ばしていたため、
 * **ビットレートを下げても同じ 301MB が上がり続けた**。
 */
describe('🔴 上限を超える音声は、変換を飛ばさない', () => {
    const OVER_LIMIT = GENERATE_MAX_MEDIA_BYTES + 1;

    it('上限を超える WAV は変換に回す（元ファイルをそのまま送らない）', async () => {
        const harness = useWorkflowHarness();

        await harness.workflow.handleStartProcessing(
            [createFile('long.wav', 'audio/wav', OVER_LIMIT)], ['f1'], BITRATE, SAMPLE_RATE
        );

        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
        // 変換に回すなら FFmpeg が要る。ここを飛ばすと「変換が必要なのにエンジンが無い」で落ちる
        expect(serviceMocks.ffmpegLoad).toHaveBeenCalled();
    });

    it('上限ちょうどはそのまま送る / 1 バイト超えたら変換する（境界）', async () => {
        const at = useWorkflowHarness();
        await at.workflow.handleStartProcessing(
            [createFile('at.mp3', 'audio/mpeg', GENERATE_MAX_MEDIA_BYTES)], ['f1'], BITRATE, SAMPLE_RATE
        );
        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();

        vi.clearAllMocks();
        const over = useWorkflowHarness();
        await over.workflow.handleStartProcessing(
            [createFile('over.mp3', 'audio/mpeg', OVER_LIMIT)], ['f1'], BITRATE, SAMPLE_RATE
        );
        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
    });

    it('size が読めないファイルは変換に回す（安全側。合格に丸めない）', async () => {
        const harness = useWorkflowHarness();
        const noSize = { file: { name: 'x.wav', type: 'audio/wav' } as File, selectedPromptIds: ['prompt-a'] };

        await harness.workflow.handleStartProcessing([noSize], ['f1'], BITRATE, SAMPLE_RATE);

        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
    });
});

describe('handleResumeFile checkpoint planning', () => {
    const resume = async (
        harness: Harness,
        status: FileProcessingStatus,
        file = createFile('only.mp4', 'video/mp4')
    ) => harness.workflow.handleResumeFile(
        status.fileId, [file], [status.fileId], [status], BITRATE, SAMPLE_RATE
    );

    it('re-runs the whole conversion when the checkpoint has no segments', async () => {
        const harness = useWorkflowHarness();
        await resume(harness, createStatus('f1', { segments: [], failedPhase: 'audio_conversion' }));

        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
        expect(serviceMocks.resumeVideoConversion).not.toHaveBeenCalled();
    });

    it('resumes from the existing segments when the checkpoint is consistent', async () => {
        const harness = useWorkflowHarness();
        await resume(harness, createStatus('f1', {
            totalDuration: 60,
            segments: [
                {
                    segmentIndex: 0, startTime: 0, endTime: 30, status: 'completed',
                    progress: 100, audioBlob: new Blob(['a']),
                },
                { segmentIndex: 1, startTime: 30, endTime: 60, status: 'pending', progress: 0 },
            ],
            completedSegmentIndices: [0],
        }));

        expect(serviceMocks.resumeVideoConversion).toHaveBeenCalledTimes(1);
        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
    });

    it('re-runs the whole conversion when a segment claims completion without its audio', async () => {
        const harness = useWorkflowHarness();
        await resume(harness, createStatus('f1', {
            totalDuration: 60,
            segments: [
                { segmentIndex: 0, startTime: 0, endTime: 30, status: 'completed', progress: 100 },
            ],
            completedSegmentIndices: [0],
        }));

        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
        expect(serviceMocks.resumeVideoConversion).not.toHaveBeenCalled();
    });

    it('skips conversion entirely when the audio is already converted', async () => {
        const harness = useWorkflowHarness();
        await resume(harness, createStatus('f1', {
            convertedAudioBlob: new Blob(['audio'], { type: 'audio/mpeg' }),
        }));

        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
        expect(serviceMocks.resumeVideoConversion).not.toHaveBeenCalled();
        expect(harness.processTranscriptionResume).toHaveBeenCalledTimes(1);
    });

    it('retries the save only when a generated draft is waiting, without re-converting', async () => {
        const harness = useWorkflowHarness({ pendingSave: true });
        await resume(harness, createStatus('f1', { segments: [] }));

        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
        expect(serviceMocks.resumeVideoConversion).not.toHaveBeenCalled();
        expect(harness.processTranscriptionResume).toHaveBeenCalledTimes(1);
        expect(serviceMocks.ffmpegLoad).not.toHaveBeenCalled();
    });

    it('resumes a canceled file so its generated draft is not stranded', async () => {
        const harness = useWorkflowHarness({ pendingSave: true });
        const result = await resume(harness, createStatus('f1', {
            status: 'canceled',
            phase: 'canceled',
            savePendingPromptIds: ['prompt-a'],
        }));

        expect(result.ok).toBe(true);
        expect(harness.processTranscriptionResume).toHaveBeenCalledTimes(1);
    });

    it('refuses to resume when the status and file lists disagree', async () => {
        const harness = useWorkflowHarness();
        const status = createStatus('f1');

        const result = await harness.workflow.handleResumeFile(
            'f1',
            [createFile('a.mp4', 'video/mp4'), createFile('b.mp4', 'video/mp4')],
            ['f0', 'f1'],
            [status],
            BITRATE,
            SAMPLE_RATE
        );

        expect(result.ok).toBe(false);
        expect(harness.processTranscriptionResume).not.toHaveBeenCalled();
        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
    });
});

/**
 * 🔴 本機能の肝 (2026-09-04 の実害)。圧縮済みで上限内の音声は変換を通らずそのまま送られ、
 *    利用者がビットレートを下げても一切効かない。強制再変換は `convertedAudioBlob` と
 *    `canSendAudioAsIs` の**両方の近道**を無効化して、元ファイルから変換をやり直さなければならない。
 */
describe('🔴 強制再変換（サイズ超過からの「変換し直して再試行」）', () => {
    const forceResume = (
        harness: Harness,
        status: FileProcessingStatus,
        file: FileWithPrompts,
        forceReconvertAtBitrate = '64k'
    ) => harness.workflow.handleResumeFile(
        status.fileId, [file], [status.fileId], [status], BITRATE, SAMPLE_RATE,
        { forceReconvertAtBitrate }
    );

    it('🔴 そのまま送れる音声 (canSendAudioAsIs===true) でも変換を呼ぶ', async () => {
        const harness = useWorkflowHarness();
        // 圧縮済み・上限内＝通常の再開なら変換を丸ごと飛ばす入力
        const file = createFile('会議音声.m4a', 'audio/mp4', 1024);
        expect(canSendAudioAsIs(file.file)).toBe(true);

        await forceResume(harness, createStatus('f1'), file);

        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
        // 指定したビットレートで変換する（画面の設定値 BITRATE ではない）
        expect(serviceMocks.convertVideoToAudioSegments.mock.calls[0][3]).toBe('64k');
        expect(serviceMocks.ffmpegLoad).toHaveBeenCalled();
    });

    it('🔴 変換済み Blob が残っていても捨てて変換し直す', async () => {
        const harness = useWorkflowHarness();
        const status = createStatus('f1', {
            convertedAudioBlob: new Blob(['old-audio'], { type: 'audio/mpeg' }),
        });

        await forceResume(harness, status, createFile('long.wav', 'audio/wav', 1024));

        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
        // 生成には新しく変換した Blob を渡す（古いものを送り直さない）
        const passedBlob = harness.processTranscriptionResume.mock.calls[0][1];
        expect(passedBlob).not.toBe(status.convertedAudioBlob);
    });

    it('🔴 区間チェックポイントが揃っていても区間再開ではなく全体を変換し直す', async () => {
        const harness = useWorkflowHarness();
        const status = createStatus('f1', {
            totalDuration: 60,
            segments: [
                {
                    segmentIndex: 0, startTime: 0, endTime: 30, status: 'completed',
                    progress: 100, audioBlob: new Blob(['a']),
                },
                { segmentIndex: 1, startTime: 30, endTime: 60, status: 'pending', progress: 0 },
            ],
            completedSegmentIndices: [0],
        });

        await forceResume(harness, status, createFile('only.mp4', 'video/mp4'));

        expect(serviceMocks.resumeVideoConversion).not.toHaveBeenCalled();
        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
    });

    it('🔴 保存だけ残っていても（save_only の近道でも）変換をやり直す', async () => {
        const harness = useWorkflowHarness({ pendingSave: true });

        await forceResume(harness, createStatus('f1'), createFile('会議音声.m4a', 'audio/mp4', 1024));

        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
    });

    it('🔴 動画直送モードでも近道を通さず変換する', async () => {
        const harness = useWorkflowHarness({ sendVideoDirectly: true });

        await forceResume(harness, createStatus('f1'), createFile('only.mp4', 'video/mp4'));

        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
    });

    it('保存済みプロンプトは再実行しない（完了済みIDをそのまま引き継ぐ）', async () => {
        const harness = useWorkflowHarness();
        const status = createStatus('f1', {
            completedPromptIds: ['prompt-done'],
            convertedAudioBlob: new Blob(['old-audio'], { type: 'audio/mpeg' }),
        });

        await forceResume(harness, status, createFile('会議音声.m4a', 'audio/mp4', 1024));

        expect(harness.processTranscriptionResume).toHaveBeenCalledTimes(1);
        expect(harness.processTranscriptionResume.mock.calls[0][2]).toEqual(['prompt-done']);
        // 生成にも指定したビットレートを渡す（記録される値と実際の変換を揃える）
        expect(harness.processTranscriptionResume.mock.calls[0][3]).toBe('64k');
    });

    it('チェックポイントと失敗の種別を消してから走る', async () => {
        const status = createStatus('f1', {
            failureKind: 'too_large',
            sizeFailure: { bytes: 999, bitrate: '96k', wasConverted: false, limitBytes: 999 },
            convertedAudioBlob: new Blob(['old-audio'], { type: 'audio/mpeg' }),
            totalDuration: 60,
            completedSegmentIndices: [0],
            audioConversionProgress: 80,
        });
        const harness = useWorkflowHarness({ initialStatuses: [status] });
        // 変換に入る前の状態を覗く
        let observed: FileProcessingStatus | undefined;
        serviceMocks.convertVideoToAudioSegments.mockImplementationOnce(async () => {
            observed = harness.statuses.find(current => current.fileId === 'f1');
            return new Blob(['audio'], { type: 'audio/mpeg' });
        });

        await forceResume(harness, status, createFile('会議音声.m4a', 'audio/mp4', 1024));

        expect(observed).toMatchObject({
            failureKind: undefined,
            sizeFailure: undefined,
            convertedAudioBlob: undefined,
            segments: [],
            completedSegmentIndices: [],
            totalDuration: undefined,
            audioConversionProgress: 0,
        });
    });

    it('オプション無しの再開は従来どおり（近道はそのまま効く）', async () => {
        const harness = useWorkflowHarness();
        const file = createFile('会議音声.m4a', 'audio/mp4', 1024);

        await harness.workflow.handleResumeFile(
            'f1', [file], ['f1'], [createStatus('f1')], BITRATE, SAMPLE_RATE
        );

        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
        expect(harness.processTranscriptionResume).toHaveBeenCalledTimes(1);
        expect(harness.processTranscriptionResume.mock.calls[0][3]).toBe(BITRATE);
    });
});

describe('handleResumeFile mixed draft sets (V7)', () => {
    it('does not take the save-only path when only some prompts have a draft', async () => {
        // 2件中1件だけ下書きあり。保存のみで済ませると Base64 とアップロードが欠ける
        const harness = useWorkflowHarness({ pendingSaveCount: 1 });
        const file: FileWithPrompts = {
            file: { name: 'only.mp4', type: 'video/mp4' } as File,
            selectedPromptIds: ['prompt-a', 'prompt-b'],
        };
        const status = createStatus('f1', { segments: [], totalTranscriptions: 2 });

        await harness.workflow.handleResumeFile(
            'f1', [file], ['f1'], [status], BITRATE, SAMPLE_RATE
        );

        // 通常経路へ落ちるので音声変換をやり直す
        expect(serviceMocks.convertVideoToAudioSegments).toHaveBeenCalledTimes(1);
        expect(harness.processTranscriptionResume).toHaveBeenCalledTimes(1);
        expect(harness.processTranscriptionResume.mock.calls[0][1]).not.toBeNull();
    });

    it('takes the save-only path when every remaining prompt has a draft', async () => {
        const harness = useWorkflowHarness({ pendingSaveCount: 2 });
        const file: FileWithPrompts = {
            file: { name: 'only.mp4', type: 'video/mp4' } as File,
            selectedPromptIds: ['prompt-a', 'prompt-b'],
        };
        const status = createStatus('f1', { segments: [], totalTranscriptions: 2 });

        await harness.workflow.handleResumeFile(
            'f1', [file], ['f1'], [status], BITRATE, SAMPLE_RATE
        );

        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
        expect(harness.processTranscriptionResume).toHaveBeenCalledTimes(1);
    });
});

describe('conversion queue wait limit (V8)', () => {
    it('gives up waiting for the queue instead of polling forever', async () => {
        vi.useFakeTimers();
        try {
            const status = createStatus('f1', { segments: [] });
            const harness = useWorkflowHarness({ initialStatuses: [status] });
            // 他ファイルの変換が終わらないままキューが握られ続ける状況
            harness.audioConversionQueueRef.current = true;
            const file: FileWithPrompts = {
                file: { name: 'only.mp4', type: 'video/mp4' } as File,
                selectedPromptIds: ['prompt-a'],
            };

            const pending = harness.workflow.handleResumeFile(
                'f1', [file], ['f1'], [status], BITRATE, SAMPLE_RATE
            );

            await vi.advanceTimersByTimeAsync(CONVERSION_QUEUE_WAIT_LIMIT_MS + 1_000);
            const result = await pending;

            expect(result.ok).toBe(false);
            expect(result.message).toContain('順番待ちを打ち切りました');
            expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
            expect(harness.statuses[0]).toMatchObject({
                status: 'error',
                failedPhase: 'audio_conversion',
            });
        } finally {
            vi.useRealTimers();
        }
    // 🔴 フェイクタイマー間の実マイクロタスクが全体実行時の並列負荷で遅延する。
    //    既定 5000ms は超えることがある（単体では約 1s）。余裕を持たせる。
    }, 20_000);
});


describe('canSendAudioAsIs', () => {
    const f = (name: string, type: string, size: number) => ({ name, type, size }) as File;

    it('圧縮済みで上限内の音声だけ、そのまま送る', () => {
        expect(canSendAudioAsIs(f('a.mp3', 'audio/mpeg', 1024))).toBe(true);
        expect(canSendAudioAsIs(f('a.m4a', 'audio/mp4', 1024))).toBe(true);
        expect(canSendAudioAsIs(f('a.aac', 'audio/aac', 1024))).toBe(true);
        expect(canSendAudioAsIs(f('a.ogg', 'audio/ogg', 1024))).toBe(true);
    });

    /**
     * 🔴 上限が 500MB に上がってから「上限内の WAV」が生まれた。サイズだけで判定すると
     *    その WAV は変換を素通りし、ビットレートを下げても同じサイズが上がる
     *    （2026-09-04 の実害そのもの）。非圧縮は大きさに関係なく変換に回す。
     */
    it('🔴 上限内でも非圧縮 (wav/flac) はそのまま送らない。同サイズの圧縮済みは送る', () => {
        expect(canSendAudioAsIs(f('a.wav', 'audio/wav', 1024))).toBe(false);
        expect(canSendAudioAsIs(f('a.flac', 'audio/flac', 1024))).toBe(false);
        // 同じサイズでも圧縮済みなら通る＝判定しているのはサイズではなく形式
        expect(canSendAudioAsIs(f('a.mp3', 'audio/mpeg', 1024))).toBe(true);
    });

    it('🔴 上限を超える音声は、拡張子が何であれ変換に回す', () => {
        expect(canSendAudioAsIs(f('a.wav', 'audio/wav', GENERATE_MAX_MEDIA_BYTES + 1))).toBe(false);
        expect(canSendAudioAsIs(f('a.mp3', 'audio/mpeg', GENERATE_MAX_MEDIA_BYTES + 1))).toBe(false);
    });

    it('size が読めない音声はそのまま送らない（判定できないものを合格に丸めない）', () => {
        expect(canSendAudioAsIs({ name: 'a.mp3', type: 'audio/mpeg' } as File)).toBe(false);
        // 🔴 数値でない size は比較で暗黙変換されて通ってしまう（'100' <= 上限 は true）。
        //    undefined だけを試すと typeof の門が効いているかを判別できない
        expect(canSendAudioAsIs(
            { name: 'a.mp3', type: 'audio/mpeg', size: '100' } as unknown as File
        )).toBe(false);
    });

    it('動画はそのまま送らない', () => {
        expect(canSendAudioAsIs(f('a.mp4', 'video/mp4', 1024))).toBe(false);
    });

    /**
     * 🔴 「圧縮済み」は SUPPORTED_MEDIA_FORMATS の音声から非圧縮を引いた差集合＝
     *    表に音声形式が増えると既定で「圧縮済み」に入る。新形式が非圧縮だった場合に
     *    黙って素通りさせないよう、現在の分類をここで固定して見直しを強制する。
     */
    /**
     * 🔴 判定は明示の許可リスト（未知の形式は変換に回る fail-closed）。そのぶん、表に
     *    音声形式が増えたのにどちらのリストにも入れ忘れると、その形式は永久に変換行きのまま
     *    誰も気づかない。表の音声形式が 2 つのリストで**過不足なく**分割されていることを検査する。
     */
    it('表の音声形式は「圧縮済み ∪ 非圧縮」で過不足なく分割されている', async () => {
        const { SUPPORTED_MEDIA_FORMATS } =
            await vi.importActual<typeof import('@/components/FileDropZone')>('@/components/FileDropZone');
        const audioExtensions = SUPPORTED_MEDIA_FORMATS
            .filter(format => format.kind === 'audio')
            .map(format => format.extension);
        const classified = [...COMPRESSED_AUDIO_EXTENSIONS, ...UNCOMPRESSED_AUDIO_EXTENSIONS];

        expect([...audioExtensions].sort()).toEqual([...classified].sort());
        // 同じ拡張子が両方に入っていない（分割であって重複ではない）
        expect(new Set(classified).size).toBe(classified.length);
    });

    it('🔴 どちらのリストにも無い音声形式は、そのまま送らない (fail-closed)', () => {
        // 表に新形式（例: 非圧縮の .aiff）が入り、分類を足し忘れた状況
        expect(canSendAudioAsIs(f('a.aiff', 'audio/aiff', 1024))).toBe(false);
    });
});

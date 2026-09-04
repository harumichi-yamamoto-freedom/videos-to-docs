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
vi.mock('@/components/FileDropZone', () => ({
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
import { canSendAudioAsIs } from '@/lib/mediaInput';
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

    it('🔴 全文文字起こしを選んだら、入力が音声でも FFmpeg を読み込む', async () => {
        // 実害 (2026-09-04): 本番で mp3 を上げると converter が null のまま分割パイプラインが
        // 呼ばれ、「音声変換の準備ができていません」で必ず失敗していた。
        // 分割パイプラインは入力が音声でもチャンクの切り出しと無音走査に FFmpeg を使う。
        const harness = useWorkflowHarness();
        const file = createFile('talk.mp3', 'audio/mpeg');
        file.selectedPromptIds = [TRANSCRIPT_PROMPT_ID];

        await harness.workflow.handleStartProcessing([file], ['f1'], BITRATE, SAMPLE_RATE);

        expect(serviceMocks.ffmpegLoad).toHaveBeenCalled();
        // 変換自体は要らない（そのまま送れる音声なので）
        expect(serviceMocks.convertVideoToAudioSegments).not.toHaveBeenCalled();
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
    });
});


describe('canSendAudioAsIs', () => {
    const f = (name: string, type: string, size: number) => ({ name, type, size }) as File;

    it('圧縮済みで上限内の音声だけ、そのまま送る', () => {
        expect(canSendAudioAsIs(f('a.mp3', 'audio/mpeg', 1024))).toBe(true);
        expect(canSendAudioAsIs(f('a.m4a', 'audio/mp4', 1024))).toBe(true);
    });

    it('🔴 上限を超える音声は、拡張子が何であれ変換に回す', () => {
        expect(canSendAudioAsIs(f('a.wav', 'audio/wav', GENERATE_MAX_MEDIA_BYTES + 1))).toBe(false);
        expect(canSendAudioAsIs(f('a.mp3', 'audio/mpeg', GENERATE_MAX_MEDIA_BYTES + 1))).toBe(false);
    });

    it('動画はそのまま送らない', () => {
        expect(canSendAudioAsIs(f('a.mp4', 'video/mp4', 1024))).toBe(false);
    });
});

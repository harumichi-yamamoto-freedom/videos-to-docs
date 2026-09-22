/**
 * 音声変換サービスの錠（区間分割廃止・worker 作り直し・失敗の観測）。
 *
 *  - 1 本 = マウント → probe → 1 exec 変換 → アンマウント。区間は 1 つとして表す
 *  - wasm が死んだら prepareForInput() で作り直して 1 回だけやり直す
 *  - 2 度目も死ぬ／通常の失敗は null を返し、ステータスに書き、clientErrors へ痕跡を送る
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugErrorMode, FileProcessingStatus, FileWithPrompts } from '@/types/processing';

const mocks = vi.hoisted(() => ({
    reportHandledError: vi.fn(),
}));

vi.mock('@ffmpeg/ffmpeg', () => ({ FFFSType: { WORKERFS: 'WORKERFS' }, FFmpeg: class FFmpeg {} }));
vi.mock('@ffmpeg/util', () => ({ fetchFile: vi.fn(), toBlobURL: vi.fn() }));
vi.mock('@/lib/clientErrorReporter', () => ({ reportHandledError: mocks.reportHandledError }));
vi.mock('./logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { FfmpegWorkerDeadError, type VideoConverter } from '@/lib/ffmpeg';
import { convertVideoToAudioSegments, resumeVideoConversion } from './videoConversionService';

const NO_DEBUG: DebugErrorMode = { ffmpegError: false, geminiError: false, errorAtFileIndex: -1, errorAtSegmentIndex: -1 };
const AUDIO = new Blob(['audio'], { type: 'audio/mpeg' });

const createFile = (name = 'booth.mp4', size = 1_300_000_000): FileWithPrompts => ({
    file: { name, size, type: 'video/mp4' } as File,
    selectedPromptIds: ['prompt-a'],
});

const createStatus = (fileId: string): FileProcessingStatus => ({
    fileId,
    fileName: `${fileId}.mp4`,
    status: 'converting',
    phase: 'waiting',
    audioConversionProgress: 0,
    transcriptionCount: 0,
    totalTranscriptions: 1,
    completedPromptIds: [],
    promptStates: {},
    segmentDuration: 30,
    segments: [],
    completedSegmentIndices: [],
});

interface FakeConverter {
    prepareForInput: ReturnType<typeof vi.fn>;
    mountInput: ReturnType<typeof vi.fn>;
    probeInput: ReturnType<typeof vi.fn>;
    convertInputToMp3: ReturnType<typeof vi.fn>;
    getExecCount: ReturnType<typeof vi.fn>;
    getGeneration: ReturnType<typeof vi.fn>;
    unmount: ReturnType<typeof vi.fn>;
}

const createConverter = (): FakeConverter => {
    const unmount = vi.fn().mockResolvedValue(undefined);
    return {
        prepareForInput: vi.fn().mockResolvedValue(undefined),
        mountInput: vi.fn().mockResolvedValue({ path: '/input_0_1/input.mp4', unmount }),
        probeInput: vi.fn().mockResolvedValue({ durationSec: 12942, hasAudioStream: true }),
        convertInputToMp3: vi.fn().mockResolvedValue(AUDIO),
        getExecCount: vi.fn().mockReturnValue(2),
        getGeneration: vi.fn().mockReturnValue(0),
        unmount,
    };
};

const asConverter = (fake: FakeConverter) => fake as unknown as VideoConverter;

const createStatusStore = () => {
    const store = { statuses: [createStatus('f1')] as FileProcessingStatus[], phases: [] as string[] };
    const setStatuses = (update: FileProcessingStatus[] | ((prev: FileProcessingStatus[]) => FileProcessingStatus[])) => {
        store.statuses = typeof update === 'function' ? update(store.statuses) : update;
        store.phases.push(store.statuses[0].phase);
    };
    return { store, setStatuses: setStatuses as React.Dispatch<React.SetStateAction<FileProcessingStatus[]>> };
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('convertVideoToAudioSegments（1 exec 方式）', () => {
    it('マウント → probe → 変換 → アンマウントの順で、区間 1 つとして進捗と完了を書く', async () => {
        const converter = createConverter();
        const { store, setStatuses } = createStatusStore();
        converter.convertInputToMp3.mockImplementation(async (_path: string, options: { onProgress: (p: { ratio: number }) => void }) => {
            options.onProgress({ ratio: 0.25 });
            return AUDIO;
        });

        const result = await convertVideoToAudioSegments(createFile(), 0, asConverter(converter), '96k', 44100, NO_DEBUG, setStatuses);

        expect(result).toBe(AUDIO);
        expect(converter.prepareForInput).toHaveBeenCalledOnce();
        expect(converter.mountInput).toHaveBeenCalledOnce();
        expect(converter.probeInput).toHaveBeenCalledWith('/input_0_1/input.mp4');
        expect(converter.convertInputToMp3).toHaveBeenCalledWith('/input_0_1/input.mp4', expect.objectContaining({ bitrate: '96k', sampleRate: 44100 }));
        expect(converter.unmount).toHaveBeenCalledOnce();

        const status = store.statuses[0];
        expect(status.totalDuration).toBe(12942);
        expect(status.segments).toHaveLength(1);
        expect(status.segments[0]).toMatchObject({ segmentIndex: 0, startTime: 0, endTime: 12942, status: 'completed', progress: 100, audioBlob: AUDIO });
        expect(status.completedSegmentIndices).toEqual([0]);
        expect(status.audioConversionProgress).toBe(100);
        expect(status.status).toBe('converting');
        expect(store.phases).toEqual(expect.arrayContaining(['video_analysis', 'audio_conversion']));
        expect(mocks.reportHandledError).not.toHaveBeenCalled();
    });

    it('進捗は ffmpeg の ratio を % にして区間と全体の両方へ書く', async () => {
        const converter = createConverter();
        const { store, setStatuses } = createStatusStore();
        const seen: number[] = [];
        converter.convertInputToMp3.mockImplementation(async (_path: string, options: { onProgress: (p: { ratio: number }) => void }) => {
            options.onProgress({ ratio: 0.4 });
            seen.push(store.statuses[0].audioConversionProgress, store.statuses[0].segments[0].progress);
            return AUDIO;
        });

        await convertVideoToAudioSegments(createFile(), 0, asConverter(converter), '96k', 44100, NO_DEBUG, setStatuses);
        expect(seen).toEqual([40, 40]);
    });

    it('wasm が死んだら作り直して 1 回だけやり直し、成功すれば痕跡は送らない', async () => {
        const converter = createConverter();
        const { store, setStatuses } = createStatusStore();
        converter.convertInputToMp3
            .mockRejectedValueOnce(new FfmpegWorkerDeadError('停止', 'RuntimeError: memory access out of bounds'))
            .mockResolvedValueOnce(AUDIO);

        const result = await convertVideoToAudioSegments(createFile(), 0, asConverter(converter), '96k', 44100, NO_DEBUG, setStatuses);

        expect(result).toBe(AUDIO);
        expect(converter.prepareForInput).toHaveBeenCalledTimes(2);
        expect(converter.mountInput).toHaveBeenCalledTimes(2);
        // 死んだ側のマウントも片付ける
        expect(converter.unmount).toHaveBeenCalledTimes(2);
        expect(store.statuses[0].status).toBe('converting');
        expect(mocks.reportHandledError).not.toHaveBeenCalled();
    });

    it('作り直しても死ぬなら諦め、再読み込みを促す文言と痕跡を残す', async () => {
        const converter = createConverter();
        const { store, setStatuses } = createStatusStore();
        converter.convertInputToMp3.mockRejectedValue(new FfmpegWorkerDeadError('停止', 'RuntimeError: table index is out of bounds'));

        const result = await convertVideoToAudioSegments(createFile(), 0, asConverter(converter), '96k', 44100, NO_DEBUG, setStatuses);

        expect(result).toBeNull();
        expect(converter.convertInputToMp3).toHaveBeenCalledTimes(2);
        expect(store.statuses[0]).toMatchObject({
            status: 'error',
            failedPhase: 'audio_conversion',
            error: expect.stringContaining('ページを再読み込み'),
        });
        expect(mocks.reportHandledError).toHaveBeenCalledOnce();
        expect(mocks.reportHandledError).toHaveBeenCalledWith(expect.objectContaining({
            source: 'audio_conversion',
            context: expect.objectContaining({ fileName: 'booth.mp4', sizeBytes: 1_300_000_000, workerDead: true, attempt: 1 }),
        }));
    });

    it('通常の失敗はやり直さず、文言をそのまま出して痕跡を残す', async () => {
        const converter = createConverter();
        const { store, setStatuses } = createStatusStore();
        converter.probeInput.mockRejectedValue(new Error('この動画には音声トラックが含まれていません。音声付きの動画をアップロードしてください。'));

        const result = await convertVideoToAudioSegments(createFile(), 0, asConverter(converter), '96k', 44100, NO_DEBUG, setStatuses);

        expect(result).toBeNull();
        expect(converter.prepareForInput).toHaveBeenCalledOnce();
        expect(converter.convertInputToMp3).not.toHaveBeenCalled();
        expect(converter.unmount).toHaveBeenCalledOnce();
        expect(store.statuses[0]).toMatchObject({
            status: 'error',
            error: expect.stringContaining('音声トラックが含まれていません'),
        });
        expect(mocks.reportHandledError).toHaveBeenCalledWith(expect.objectContaining({
            context: expect.objectContaining({ workerDead: false, attempt: 0 }),
        }));
    });

    it('デバッグの FFmpeg エラーは変換を呼ばずに失敗させる', async () => {
        const converter = createConverter();
        const { store, setStatuses } = createStatusStore();

        const result = await convertVideoToAudioSegments(
            createFile(), 0, asConverter(converter), '96k', 44100,
            { ...NO_DEBUG, ffmpegError: true, errorAtFileIndex: 0 }, setStatuses,
        );

        expect(result).toBeNull();
        expect(converter.convertInputToMp3).not.toHaveBeenCalled();
        expect(store.statuses[0].error).toContain('[デバッグ]');
    });

    it('別ファイルのステータスには触らない', async () => {
        const converter = createConverter();
        const { store, setStatuses } = createStatusStore();
        store.statuses = [createStatus('f0'), createStatus('f1')];

        await convertVideoToAudioSegments(createFile(), 1, asConverter(converter), '96k', 44100, NO_DEBUG, setStatuses);

        expect(store.statuses[0]).toEqual(createStatus('f0'));
        expect(store.statuses[1].segments).toHaveLength(1);
    });
});

describe('resumeVideoConversion', () => {
    it('旧区間を捨てて丸ごと変換し直す', async () => {
        const converter = createConverter();
        const { store, setStatuses } = createStatusStore();
        const previous: FileProcessingStatus = {
            ...createStatus('f1'),
            totalDuration: 12942,
            segments: [
                { segmentIndex: 0, startTime: 0, endTime: 216, status: 'completed', progress: 100, audioBlob: AUDIO },
                { segmentIndex: 1, startTime: 216, endTime: 432, status: 'error', progress: 0 },
            ],
            completedSegmentIndices: [0],
        };
        store.statuses = [previous];

        const result = await resumeVideoConversion(createFile(), 0, previous, asConverter(converter), '64k', 44100, NO_DEBUG, setStatuses);

        expect(result).toBe(AUDIO);
        expect(converter.convertInputToMp3).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ bitrate: '64k' }));
        expect(store.statuses[0].segments).toHaveLength(1);
        expect(store.statuses[0].completedSegmentIndices).toEqual([0]);
    });
});

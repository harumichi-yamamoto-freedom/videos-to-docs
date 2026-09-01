import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/prompts';
import type { FileProcessingStatus, FileWithPrompts } from '@/types/processing';

const reactHarness = vi.hoisted(() => ({
    stateCursor: 0,
    stateValues: [] as unknown[],
}));

const serviceMocks = vi.hoisted(() => ({
    getBase64: vi.fn(),
    getCurrentUserId: vi.fn(),
    saveTranscription: vi.fn(),
    transcribeWithBase64: vi.fn(),
    uploadAudioToStorage: vi.fn(),
    validatePromptPermission: vi.fn(),
}));

vi.mock('react', () => ({
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: () => undefined,
    useRef: <T>(initialValue: T) => ({ current: initialValue }),
    useState: <T>(initialValue: T | (() => T)) => {
        const stateIndex = reactHarness.stateCursor;
        reactHarness.stateCursor += 1;
        reactHarness.stateValues[stateIndex] = typeof initialValue === 'function'
            ? (initialValue as () => T)()
            : initialValue;

        const setState = (nextValue: T | ((current: T) => T)) => {
            const currentValue = reactHarness.stateValues[stateIndex] as T;
            reactHarness.stateValues[stateIndex] = typeof nextValue === 'function'
                ? (nextValue as (current: T) => T)(currentValue)
                : nextValue;
        };

        return [reactHarness.stateValues[stateIndex] as T, setState] as const;
    },
}));

vi.mock('@/lib/ffmpeg', () => ({ VideoConverter: class VideoConverter {} }));
vi.mock('@/lib/gemini', () => ({ GeminiClient: class GeminiClient {} }));
vi.mock('@/lib/firestore', () => ({
    saveTranscription: serviceMocks.saveTranscription,
}));
vi.mock('@/lib/storage', () => ({
    uploadAudioToStorage: serviceMocks.uploadAudioToStorage,
}));
vi.mock('@/lib/promptPermissions', () => ({
    validatePromptPermission: serviceMocks.validatePromptPermission,
}));
vi.mock('@/lib/auth', () => ({
    getCurrentUserId: serviceMocks.getCurrentUserId,
}));
vi.mock('@/constants/geminiModels', () => ({
    canonicalizeGeminiModel: (model?: string) => model ?? 'gemini-default',
    GEMINI_DEFAULT_MODEL_SENTINEL: 'gemini-default-sentinel',
}));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    }),
}));

import {
    cancelPromptStates,
    countPendingSaveDrafts,
    derivePhase,
    evaluateCompletion,
    needsDiscardConfirmation,
    resolveSavePendingPromptIds,
    useVideoProcessing,
} from './useVideoProcessing';

const FILE_ID = 'file-1';

const createDeferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
};

const createPrompt = (id: string, name: string): Prompt => ({
    id,
    name,
    content: `${name} content`,
    model: 'gemini-test',
    isDefault: false,
    ownerType: 'user',
    ownerId: 'user-1',
    createdBy: 'user-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

const createStatus = (totalTranscriptions: number): FileProcessingStatus => ({
    fileId: FILE_ID,
    fileName: 'sample.mp3',
    status: 'waiting',
    phase: 'waiting',
    audioConversionProgress: 0,
    transcriptionCount: 0,
    totalTranscriptions,
    completedPromptIds: [],
    promptStates: {},
    savePendingPromptIds: [],
    segmentDuration: 30,
    segments: [],
    completedSegmentIndices: [],
});

const createFile = (promptIds: string[]): FileWithPrompts => ({
    file: {
        name: 'sample.mp3',
        type: 'audio/mpeg',
    } as File,
    selectedPromptIds: promptIds,
});

const createJob = (file: FileWithPrompts) => ({ file, fileIndex: 0, fileId: FILE_ID });

const getCurrentStatus = () =>
    (reactHarness.stateValues[0] as FileProcessingStatus[])[0];

beforeEach(() => {
    reactHarness.stateCursor = 0;
    reactHarness.stateValues = [];
    vi.clearAllMocks();
    serviceMocks.getBase64.mockResolvedValue('base64-data');
    serviceMocks.getCurrentUserId.mockReturnValue('user-1');
    serviceMocks.saveTranscription.mockResolvedValue('doc-1');
    serviceMocks.uploadAudioToStorage.mockResolvedValue('audio/path');
});

describe.each([
    ['initial processing', false],
    ['resume processing', true],
] as const)('useVideoProcessing child settlement: %s', (_label, resume) => {
    it('waits for every prompt and aggregates failures before setting the error status', async () => {
        const prompts = [
            createPrompt('prompt-a', 'Prompt A'),
            createPrompt('prompt-b', 'Prompt B'),
            createPrompt('prompt-c', 'Prompt C'),
        ];
        const saveDeferred = createDeferred<void>();
        serviceMocks.transcribeWithBase64.mockImplementation(
            (_base64, _mimeType, _fileName, content: string) => {
                if (content !== 'Prompt B content') {
                    return Promise.reject(new Error(`${content.replace(' content', '')} failed`));
                }
                return Promise.resolve({ success: true, text: 'Prompt B result' });
            }
        );
        serviceMocks.saveTranscription.mockReturnValue(saveDeferred.promise);

        const hook = useVideoProcessing(
            prompts,
            { ffmpegError: false, geminiError: false, errorAtFileIndex: 0, errorAtSegmentIndex: 0 },
            vi.fn()
        );
        hook.setProcessingStatuses([createStatus(prompts.length)]);
        hook.geminiClientRef.current = {
            getBase64: serviceMocks.getBase64,
            transcribeWithBase64: serviceMocks.transcribeWithBase64,
        } as never;

        const file = createFile(prompts.map(prompt => prompt.id!));
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });
        const processingPromise = resume
            ? hook.processTranscriptionResume(createJob(file), audioBlob, [], '192k', 44100)
            : hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        let finished = false;
        void processingPromise.then(() => {
            finished = true;
        });

        await vi.waitFor(() => {
            expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
        });
        expect(finished).toBe(false);
        expect(getCurrentStatus().status).toBe('transcribing');

        saveDeferred.resolve();
        await processingPromise;

        expect(finished).toBe(true);
        expect(getCurrentStatus()).toMatchObject({
            status: 'error',
            failedPhase: 'text_generation',
            transcriptionCount: 1,
            completedPromptIds: ['prompt-b'],
        });
        expect(getCurrentStatus().error).toContain('Prompt A');
        expect(getCurrentStatus().error).toContain('Prompt A failed');
        expect(getCurrentStatus().error).toContain('Prompt C');
        expect(getCurrentStatus().error).toContain('Prompt C failed');
    });
});

describe.each([
    ['initial processing', false],
    ['resume processing', true],
] as const)('useVideoProcessing preparation settlement: %s', (_label, resume) => {
    it('waits for both preparation tasks and reports every rejected reason together', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const uploadDeferred = createDeferred<string | null>();
        serviceMocks.getBase64.mockRejectedValue(new Error('base64 failed'));
        serviceMocks.uploadAudioToStorage.mockReturnValue(uploadDeferred.promise);

        const hook = useVideoProcessing(
            [prompt],
            { ffmpegError: false, geminiError: false, errorAtFileIndex: 0, errorAtSegmentIndex: 0 }
        );
        hook.setProcessingStatuses([createStatus(1)]);
        hook.geminiClientRef.current = {
            getBase64: serviceMocks.getBase64,
            transcribeWithBase64: serviceMocks.transcribeWithBase64,
        } as never;

        const file = createFile([prompt.id!]);
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });
        const processingPromise = resume
            ? hook.processTranscriptionResume(createJob(file), audioBlob, [], '192k', 44100)
            : hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        let finished = false;
        void processingPromise.then(() => {
            finished = true;
        });

        await vi.waitFor(() => {
            expect(serviceMocks.uploadAudioToStorage).toHaveBeenCalledTimes(1);
        });
        expect(finished).toBe(false);
        expect(getCurrentStatus().status).toBe('transcribing');

        uploadDeferred.reject(new Error('storage failed'));
        await processingPromise;

        expect(finished).toBe(true);
        expect(serviceMocks.transcribeWithBase64).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('error');
        expect(getCurrentStatus().error).toContain('Base64変換');
        expect(getCurrentStatus().error).toContain('Storageアップロード');
        expect(getCurrentStatus().error).toContain('storage failed');
    });
});

const useProcessingHarness = (prompts: Prompt[], totalTranscriptions = prompts.length) => {
    const hook = useVideoProcessing(
        prompts,
        { ffmpegError: false, geminiError: false, errorAtFileIndex: 0, errorAtSegmentIndex: 0 }
    );
    hook.setProcessingStatuses([createStatus(totalTranscriptions)]);
    hook.geminiClientRef.current = {
        getBase64: serviceMocks.getBase64,
        transcribeWithBase64: serviceMocks.transcribeWithBase64,
    } as never;
    return hook;
};

describe('useVideoProcessing owner pinning', () => {
    it('refuses to save when the signed-in user changes after the job started', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockImplementation(() => {
            // 生成中にサインインし直したユーザーへ切り替わる状況を再現する
            serviceMocks.getCurrentUserId.mockReturnValue('user-2');
            return Promise.resolve({ success: true, text: 'generated' });
        });

        const hook = useProcessingHarness([prompt]);
        const file = createFile([prompt.id!]);

        await hook.processTranscription(
            createJob(file),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('canceled');
        expect(getCurrentStatus().completedPromptIds).toEqual([]);
    });

    it('saves under the uid captured at job start when the uid never changes', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });

        const hook = useProcessingHarness([prompt]);
        const file = createFile([prompt.id!]);

        await hook.processTranscription(
            createJob(file),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
        expect(getCurrentStatus().status).toBe('completed');
    });
});

describe('useVideoProcessing idempotency', () => {
    it('does not generate or save the same file and prompt twice across a resume', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });

        const hook = useProcessingHarness([prompt]);
        const file = createFile([prompt.id!]);
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });

        await hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        // 完了済みIDを渡し忘れた再開でも、二重生成・二重保存をしない
        await hook.processTranscriptionResume(createJob(file), audioBlob, [], '192k', 44100);

        expect(serviceMocks.transcribeWithBase64).toHaveBeenCalledTimes(1);
        expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
        expect(getCurrentStatus().status).toBe('completed');
        expect(getCurrentStatus().transcriptionCount).toBe(1);
    });
});

describe('useVideoProcessing completion gate', () => {
    it('treats a blank generation as a failure instead of completing', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: '   \n  ' });

        const hook = useProcessingHarness([prompt]);
        const file = createFile([prompt.id!]);

        await hook.processTranscription(
            createJob(file),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('error');
        expect(getCurrentStatus().error).toContain('空');
    });

    it('does not complete when no prompt is selected for the file', async () => {
        const hook = useProcessingHarness([createPrompt('prompt-a', 'Prompt A')], 0);
        const file = createFile([]);

        await hook.processTranscription(
            createJob(file),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(serviceMocks.transcribeWithBase64).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('error');
    });

    it('completes only after every planned prompt has been saved', async () => {
        const prompts = [
            createPrompt('prompt-a', 'Prompt A'),
            createPrompt('prompt-b', 'Prompt B'),
        ];
        serviceMocks.transcribeWithBase64.mockImplementation(
            (_base64, _mimeType, _fileName, content: string) =>
                content === 'Prompt A content'
                    ? Promise.resolve({ success: true, text: 'A result' })
                    : Promise.reject(new Error('Prompt B failed'))
        );

        const hook = useProcessingHarness(prompts);
        const file = createFile(prompts.map(prompt => prompt.id!));

        await hook.processTranscription(
            createJob(file),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(getCurrentStatus().status).toBe('error');
        expect(getCurrentStatus().transcriptionCount).toBe(1);
        expect(getCurrentStatus().totalTranscriptions).toBe(2);
    });
});

describe('evaluateCompletion', () => {
    it('counts only prompts that are part of the plan', () => {
        // 計画外のID（削除済みプロンプトの completedPromptIds 等）が分母を超えない
        expect(evaluateCompletion(['a'], ['a', 'deleted-prompt'])).toEqual({
            savedCount: 1,
            plannedCount: 1,
            isComplete: true,
        });
    });

    it('never completes on an empty plan', () => {
        expect(evaluateCompletion([], [])).toEqual({
            savedCount: 0,
            plannedCount: 0,
            isComplete: false,
        });
        expect(evaluateCompletion([], ['a'])).toMatchObject({ isComplete: false });
    });

    it('stays incomplete while a planned prompt is unsaved', () => {
        expect(evaluateCompletion(['a', 'b'], ['a'])).toEqual({
            savedCount: 1,
            plannedCount: 2,
            isComplete: false,
        });
    });

    it('deduplicates both sides so a repeated id cannot inflate the count', () => {
        expect(evaluateCompletion(['a', 'a'], ['a', 'a'])).toEqual({
            savedCount: 1,
            plannedCount: 1,
            isComplete: true,
        });
    });
});

describe('useVideoProcessing job exclusion', () => {
    it('ignores a second start while the first job is still in flight', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const saveDeferred = createDeferred<void>();
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });
        serviceMocks.saveTranscription.mockReturnValue(saveDeferred.promise);

        const hook = useProcessingHarness([prompt]);
        const file = createFile([prompt.id!]);
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });

        const first = hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        await vi.waitFor(() => {
            expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
        });

        // 1本目がまだ保存中（冪等キーは未登録）の状態で2本目を投げる
        await hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        expect(serviceMocks.transcribeWithBase64).toHaveBeenCalledTimes(1);

        saveDeferred.resolve();
        await first;
        expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
    });
});

describe('useVideoProcessing abort handling', () => {
    it('does not save a document generated before the job was canceled', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        serviceMocks.transcribeWithBase64.mockImplementation(() => {
            hook.cancelJob(FILE_ID, '中止しました。');
            return Promise.resolve({ success: true, text: 'generated' });
        });

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('canceled');
    });

    it('waits for the running job to settle before clearing the state', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const saveDeferred = createDeferred<void>();
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });
        serviceMocks.saveTranscription.mockReturnValue(saveDeferred.promise);

        const hook = useProcessingHarness([prompt]);
        const running = hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );
        await vi.waitFor(() => {
            expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
        });

        let resetFinished = false;
        const reset = hook.resetProcessing('中止しました。').then(() => {
            resetFinished = true;
        });

        await new Promise(resolve => setTimeout(resolve, 0));
        // 変換・保存が走っている間にリセットが完了すると ffmpeg 二重走行を招く
        expect(resetFinished).toBe(false);

        saveDeferred.resolve();
        await running;
        await reset;
        expect(resetFinished).toBe(true);
    });
});

describe('useVideoProcessing prompt integrity', () => {
    it('refuses to generate when a selected prompt is no longer available', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt], 2);

        await hook.processTranscription(
            createJob(createFile([prompt.id!, 'deleted-prompt'])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(serviceMocks.transcribeWithBase64).not.toHaveBeenCalled();
        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('error');
        expect(getCurrentStatus().error).toContain('見つかりません');
    });

    it('completes on a resume even when completedPromptIds carries a deleted prompt', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });

        const hook = useProcessingHarness([prompt]);

        await hook.processTranscriptionResume(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            ['deleted-prompt'],
            '192k',
            44100
        );

        expect(getCurrentStatus().status).toBe('completed');
        expect(getCurrentStatus().transcriptionCount).toBe(1);
        expect(getCurrentStatus().totalTranscriptions).toBe(1);
    });
});

describe('useVideoProcessing save failure', () => {
    it('keeps the prompt in the save-pending set so the retry hint can be shown', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });
        serviceMocks.saveTranscription.mockRejectedValue(new Error('firestore down'));

        const hook = useProcessingHarness([prompt]);
        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(getCurrentStatus()).toMatchObject({ status: 'error', failedPhase: 'saving' });
        expect(getCurrentStatus().savePendingPromptIds).toContain('prompt-a');
        expect(hook.countPendingSaves(FILE_ID, ['prompt-a'])).toBe(1);
    });

    it('retries only the save, without generating again', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });
        serviceMocks.saveTranscription.mockRejectedValueOnce(new Error('firestore down'));

        const hook = useProcessingHarness([prompt]);
        const job = createJob(createFile([prompt.id!]));
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });

        await hook.processTranscription(job, audioBlob, '192k', 44100);
        expect(getCurrentStatus().status).toBe('error');

        serviceMocks.saveTranscription.mockResolvedValue('doc-1');
        await hook.processTranscriptionResume(job, null, [], '192k', 44100);

        expect(serviceMocks.transcribeWithBase64).toHaveBeenCalledTimes(1);
        expect(serviceMocks.getBase64).toHaveBeenCalledTimes(1);
        expect(getCurrentStatus().status).toBe('completed');
    });
});

describe('useVideoProcessing owner argument', () => {
    it('passes the pinned uid to saveTranscription so the write is checked there too', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });

        const hook = useProcessingHarness([prompt]);
        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
        expect(serviceMocks.saveTranscription.mock.calls[0][11]).toBe('user-1');
    });
});

describe('derivePhase', () => {
    it('reports generation and saving from the prompt states', () => {
        expect(derivePhase({ a: 'generating', b: 'saving' }, 'uploading')).toBe('text_generation');
        expect(derivePhase({ a: 'saved', b: 'saving' }, 'uploading')).toBe('saving');
    });

    it.each([
        'waiting',
        'video_analysis',
        'audio_conversion',
        'audio_concat',
        'direct_video_send',
        'uploading',
        'completed',
        'canceled',
    ] as const)('keeps the %s phase when no prompt is generating or saving', (phase) => {
        // プロンプト単位の状態が決めるのは生成中と保存中だけ。
        // それ以外のフェーズを text_generation で塗り潰さない
        expect(derivePhase({ a: 'pending' }, phase)).toBe(phase);
        expect(derivePhase({ a: 'saved', b: 'failed' }, phase)).toBe(phase);
        expect(derivePhase({}, phase)).toBe(phase);
    });
});

describe('countPendingSaveDrafts (V1)', () => {
    it('sums the unsaved drafts across every file', () => {
        expect(countPendingSaveDrafts([])).toBe(0);
        expect(countPendingSaveDrafts([
            { ...createStatus(2), savePendingPromptIds: ['a', 'b'] },
            { ...createStatus(1), fileId: 'file-2', savePendingPromptIds: ['c'] },
            { ...createStatus(1), fileId: 'file-3', savePendingPromptIds: [] },
            { ...createStatus(1), fileId: 'file-4', savePendingPromptIds: undefined },
        ])).toBe(3);
    });
});

describe('useVideoProcessing discard confirmation (V1)', () => {
    it('asks for confirmation when unsaved drafts exist even with no job running', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });
        serviceMocks.saveTranscription.mockRejectedValue(new Error('firestore down'));

        const hook = useProcessingHarness([prompt]);
        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        // 保存失敗後、ジョブは決着済み（activeJobIds は空）なのに下書きは残っている。
        // 「実行中か」だけで確認を出すと、この課金済み資産が無確認で消える
        const liveStatuses = reactHarness.stateValues[0] as FileProcessingStatus[];
        const liveActiveJobIds = reactHarness.stateValues[3] as string[];

        expect(liveActiveJobIds).toEqual([]);
        expect(countPendingSaveDrafts(liveStatuses)).toBe(1);
    });

    it('does not ask for confirmation when nothing would be lost', () => {
        const hook = useProcessingHarness([createPrompt('prompt-a', 'Prompt A')]);
        expect(hook.pendingSaveCount).toBe(0);
        expect(hook.needsDiscardConfirm).toBe(false);
    });
});

describe('useVideoProcessing forced discard (V2)', () => {
    it('reports a timeout and keeps the progress when a job will not stop', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const saveDeferred = createDeferred<void>();
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });
        serviceMocks.saveTranscription.mockReturnValue(saveDeferred.promise);

        const hook = useProcessingHarness([prompt]);
        const running = hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );
        await vi.waitFor(() => {
            expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
        });

        const outcome = await hook.resetProcessing('中止しました。', 20);

        expect(outcome).toBe('timeout');
        // 進捗を消してしまうと、止まらない処理の様子が画面から消える
        expect((reactHarness.stateValues[0] as FileProcessingStatus[]).length).toBe(1);

        hook.forceDiscardProcessing();
        expect(reactHarness.stateValues[0]).toEqual([]);
        // 占有を握ったままだと hasActiveJobs が下りず、画面が封鎖されたままになる
        expect(reactHarness.stateValues[3]).toEqual([]);
        expect(hook.claimJob(FILE_ID)).not.toBeNull();

        saveDeferred.resolve();
        await running;
    });

    it('settles normally when the job finishes inside the limit', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });

        const hook = useProcessingHarness([prompt]);
        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        await expect(hook.resetProcessing('中止しました。', 20)).resolves.toBe('settled');
        expect(reactHarness.stateValues[0]).toEqual([]);
    });
});

describe('useVideoProcessing markJobCanceled (V6)', () => {
    it('cancels a file that has not reached a terminal state', () => {
        const hook = useProcessingHarness([createPrompt('prompt-a', 'Prompt A')]);
        hook.markJobCanceled(FILE_ID, '待機中に中止しました。');

        expect(getCurrentStatus()).toMatchObject({
            status: 'canceled',
            phase: 'canceled',
            error: '待機中に中止しました。',
        });
    });

    it.each(['completed', 'error'] as const)('never overwrites a %s result', (finalStatus) => {
        const hook = useProcessingHarness([createPrompt('prompt-a', 'Prompt A')]);
        hook.setProcessingStatuses([{
            ...createStatus(1),
            status: finalStatus,
            phase: finalStatus === 'completed' ? 'completed' : 'text_generation',
            error: finalStatus === 'error' ? '元のエラー' : undefined,
        }]);

        hook.markJobCanceled(FILE_ID, '中止しました。');

        expect(getCurrentStatus().status).toBe(finalStatus);
        expect(getCurrentStatus().error).not.toBe('中止しました。');
    });
});

describe('needsDiscardConfirmation (V1)', () => {
    it.each([
        [0, 0, false],
        [1, 0, true],
        [0, 1, true],
        [2, 3, true],
    ])('activeJobs=%i pendingSaves=%i -> %s', (activeJobs, pendingSaves, expected) => {
        expect(needsDiscardConfirmation(activeJobs, pendingSaves)).toBe(expected);
    });

    it('confirms on unsaved drafts even when nothing is running', () => {
        // 保存失敗後はジョブが決着済み。ここを落とすと課金済みの下書きが無確認で消える
        expect(needsDiscardConfirmation(0, 1)).toBe(true);
    });
});

describe('resolveSavePendingPromptIds (U1)', () => {
    const withDrafts = (...ids: string[]) => (promptId: string) => ids.includes(promptId);

    it('lists every state that still holds an unsaved draft', () => {
        expect(resolveSavePendingPromptIds(
            { a: 'saving', b: 'failed', c: 'canceled', d: 'generating' },
            withDrafts('b', 'c', 'd')
        )).toEqual(['a', 'b', 'c', 'd']);
    });

    it('does not list states whose draft is gone', () => {
        expect(resolveSavePendingPromptIds(
            { a: 'saved', b: 'failed', c: 'canceled', d: 'pending' },
            withDrafts()
        )).toEqual([]);
    });

    it('keeps a canceled prompt listed while its draft survives', () => {
        // 中止経路だけ savePendingPromptIds を書き忘れると、ここが空になる
        expect(resolveSavePendingPromptIds({ a: 'canceled' }, withDrafts('a'))).toEqual(['a']);
    });
});

describe('cancelPromptStates (U1)', () => {
    it('keeps settled outcomes and cancels the rest', () => {
        expect(cancelPromptStates({
            a: 'saved', b: 'failed', c: 'generating', d: 'saving', e: 'pending',
        })).toEqual({
            a: 'saved', b: 'failed', c: 'canceled', d: 'canceled', e: 'canceled',
        });
    });
});

describe('useVideoProcessing cancel after generation (U1)', () => {
    it('still reports the generated draft as save-pending after a cancel', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        serviceMocks.transcribeWithBase64.mockImplementation(() => {
            // 生成が終わり下書きが出来た直後に中止される
            hook.cancelJob(FILE_ID, '中止しました。');
            return Promise.resolve({ success: true, text: 'generated' });
        });

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('canceled');
        // 課金済みの下書きが残っているのだから、破棄前に警告できる状態でなければならない
        expect(getCurrentStatus().savePendingPromptIds).toContain('prompt-a');
        expect(countPendingSaveDrafts(
            reactHarness.stateValues[0] as FileProcessingStatus[]
        )).toBe(1);
        expect(hook.countPendingSaves(FILE_ID, ['prompt-a'])).toBe(1);
    });

    it('reports nothing pending when the cancel happened before generation', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        serviceMocks.transcribeWithBase64.mockImplementation(() =>
            Promise.reject(new Error('generation failed'))
        );

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '192k',
            44100
        );

        expect(countPendingSaveDrafts(
            reactHarness.stateValues[0] as FileProcessingStatus[]
        )).toBe(0);
    });
});

describe('resolveSavePendingPromptIds pending state (G2)', () => {
    const withDrafts = (...ids: string[]) => (promptId: string) => ids.includes(promptId);

    it('counts a pending prompt that already has a draft', () => {
        // 保存のみ再試行の開始時、残りは 'pending' に戻される。
        // ここを外すと、その瞬間だけ破棄確認が消えて課金済みの下書きが失われる
        expect(resolveSavePendingPromptIds({ a: 'pending' }, withDrafts('a'))).toEqual(['a']);
    });

    it('does not count a pending prompt with no draft', () => {
        expect(resolveSavePendingPromptIds({ a: 'pending' }, withDrafts())).toEqual([]);
    });

    it('never counts a saved prompt, draft or not', () => {
        expect(resolveSavePendingPromptIds({ a: 'saved' }, withDrafts('a'))).toEqual([]);
    });
});

describe('useVideoProcessing save-only retry keeps the discard gate (G2)', () => {
    it('still reports the draft as save-pending while the retry is in flight', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.transcribeWithBase64.mockResolvedValue({ success: true, text: 'generated' });
        serviceMocks.saveTranscription.mockRejectedValueOnce(new Error('firestore down'));

        const hook = useProcessingHarness([prompt]);
        const job = createJob(createFile([prompt.id!]));
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });

        await hook.processTranscription(job, audioBlob, '192k', 44100);
        expect(getCurrentStatus().savePendingPromptIds).toContain('prompt-a');

        // 保存のみの再試行を開始した直後も、下書きは失われる資産のまま
        const saveDeferred = createDeferred<string>();
        serviceMocks.saveTranscription.mockReturnValue(saveDeferred.promise);
        const retrying = hook.processTranscriptionResume(job, null, [], '192k', 44100);

        await vi.waitFor(() => {
            expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(2);
        });
        expect(countPendingSaveDrafts(
            reactHarness.stateValues[0] as FileProcessingStatus[]
        )).toBe(1);

        saveDeferred.resolve('doc-1');
        await retrying;
        expect(getCurrentStatus().status).toBe('completed');
        expect(countPendingSaveDrafts(
            reactHarness.stateValues[0] as FileProcessingStatus[]
        )).toBe(0);
    });
});

/**
 * G2: 「promptStates を書く経路は必ず withPromptStates を通す」は挙動に現れない不変条件。
 * 種付けの直後に markPromptState が同期で上書きするため、値の差を観測できる瞬間が無い。
 * よって形（唯一の書き手であること）を直接検査する。
 */
describe('savePendingPromptIds has a single writer (G2 invariant)', () => {
    const source = readFileSync(
        fileURLToPath(new URL('./useVideoProcessing.ts', import.meta.url)),
        'utf8'
    );

    it('assigns savePendingPromptIds in exactly one place', () => {
        expect(source.match(/savePendingPromptIds:/g) ?? []).toHaveLength(1);
    });

    it('never builds a status literal with its own promptStates map', () => {
        // `promptStates: {` は withPromptStates を迂回した書き手の形
        expect(source.match(/promptStates: \{/g) ?? []).toHaveLength(0);
    });

    it('detects a bypassing writer when one is introduced', () => {
        // 検出器が本当に反応することを、違反を注入して確かめる
        const violating = source.replace(
            'const markPromptState = useCallback',
            'const bypass = (s: never) => ({ ...s, promptStates: { a: 1 }, savePendingPromptIds: [] });\n    const markPromptState = useCallback'
        );
        expect(violating.match(/savePendingPromptIds:/g) ?? []).toHaveLength(2);
        expect(violating.match(/promptStates: \{/g) ?? []).toHaveLength(1);
    });
});

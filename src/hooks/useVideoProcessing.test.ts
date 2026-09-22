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
    generateDocument: vi.fn(),
    getCurrentUserId: vi.fn(),
    saveTranscription: vi.fn(),
    uploadAudioToStorage: vi.fn(),
    validatePromptPermission: vi.fn(),
}));

// 全文文字起こし（バッチ）の提出・確認再開だけを差し替える。段階のヘルパは実物を使う。
const batchMocks = vi.hoisted(() => ({
    runBatchTranscription: vi.fn(),
    resumeBatchTranscription: vi.fn(),
}));

// 実測の長さ。既定は「測れなかった」＝従来の推定へ落ちる（既存テストの挙動を変えない）
const durationMocks = vi.hoisted(() => ({
    measureMediaDurationSec: vi.fn(),
}));

vi.mock('@/hooks/batchTranscriptionClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/hooks/batchTranscriptionClient')>()),
    runBatchTranscription: batchMocks.runBatchTranscription,
    resumeBatchTranscription: batchMocks.resumeBatchTranscription,
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

vi.mock('@/lib/mediaDuration', () => ({
    measureMediaDurationSec: durationMocks.measureMediaDurationSec,
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
    estimateAudioSec,
    isMediaTooLargeFailure,
    countPendingSaveDrafts,
    derivePhase,
    evaluateCompletion,
    needsDiscardConfirmation,
    resolveSavePendingPromptIds,
    useVideoProcessing,
} from './useVideoProcessing';
import {
    GENERATE_MAX_MEDIA_BYTES,
    GENERATE_SYNC_MAX_MEDIA_BYTES,
} from '@/lib/generateApiContract';
import { AZURE_BATCH_MAX_AUDIO_SEC } from '@/lib/azureBatchContract';
import { TRANSCRIPT_PROMPT_ID } from '@/lib/transcriptPrompt';
import type { RunBatchTranscriptionInput, RunBatchTranscriptionResult } from './batchTranscriptionClient';

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
    durationMocks.measureMediaDurationSec.mockResolvedValue(null);
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
        serviceMocks.generateDocument.mockImplementation(
            ({ prompt: { content } }: { prompt: { content: string } }) => {
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
            generateDocument: serviceMocks.generateDocument,
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
] as const)('useVideoProcessing storage upload gate (#4): %s', (_label, resume) => {
    it('Storage へのアップロード失敗は upload フェーズの明示エラーにし、API を呼ばない', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const uploadDeferred = createDeferred<string>();
        serviceMocks.uploadAudioToStorage.mockReturnValue(uploadDeferred.promise);

        const hook = useVideoProcessing(
            [prompt],
            { ffmpegError: false, geminiError: false, errorAtFileIndex: 0, errorAtSegmentIndex: 0 }
        );
        hook.setProcessingStatuses([createStatus(1)]);
        hook.geminiClientRef.current = {
            generateDocument: serviceMocks.generateDocument,
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
        expect(getCurrentStatus()).toMatchObject({ status: 'transcribing', phase: 'uploading' });

        uploadDeferred.reject(new Error('storage failed'));
        await processingPromise;

        expect(finished).toBe(true);
        // 以前は「失敗しても続行」だったが、サーバは Storage から読むので続行できない
        expect(serviceMocks.generateDocument).not.toHaveBeenCalled();
        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
        expect(getCurrentStatus()).toMatchObject({ status: 'error', failedPhase: 'upload', phase: 'uploading' });
        expect(getCurrentStatus().error).toContain('Storageアップロード');
        expect(getCurrentStatus().error).toContain('storage failed');
    });

    it('古い test double のように null を返しても成功扱いにしない', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.uploadAudioToStorage.mockResolvedValue(null as never);

        const hook = useVideoProcessing(
            [prompt],
            { ffmpegError: false, geminiError: false, errorAtFileIndex: 0, errorAtSegmentIndex: 0 }
        );
        hook.setProcessingStatuses([createStatus(1)]);
        hook.geminiClientRef.current = { generateDocument: serviceMocks.generateDocument } as never;

        const file = createFile([prompt.id!]);
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });
        await (resume
            ? hook.processTranscriptionResume(createJob(file), audioBlob, [], '192k', 44100)
            : hook.processTranscription(createJob(file), audioBlob, '192k', 44100));

        expect(serviceMocks.generateDocument).not.toHaveBeenCalled();
        expect(getCurrentStatus()).toMatchObject({ status: 'error', failedPhase: 'upload' });
    });
});

const useProcessingHarness = (prompts: Prompt[], totalTranscriptions = prompts.length) => {
    const hook = useVideoProcessing(
        prompts,
        { ffmpegError: false, geminiError: false, errorAtFileIndex: 0, errorAtSegmentIndex: 0 }
    );
    hook.setProcessingStatuses([createStatus(totalTranscriptions)]);
    hook.geminiClientRef.current = {
        generateDocument: serviceMocks.generateDocument,
    } as never;
    return hook;
};

describe('useVideoProcessing owner pinning', () => {
    it('refuses to save when the signed-in user changes after the job started', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.generateDocument.mockImplementation(() => {
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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });

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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });

        const hook = useProcessingHarness([prompt]);
        const file = createFile([prompt.id!]);
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });

        await hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        // 完了済みIDを渡し忘れた再開でも、二重生成・二重保存をしない
        await hook.processTranscriptionResume(createJob(file), audioBlob, [], '192k', 44100);

        expect(serviceMocks.generateDocument).toHaveBeenCalledTimes(1);
        expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
        expect(getCurrentStatus().status).toBe('completed');
        expect(getCurrentStatus().transcriptionCount).toBe(1);
    });
});

describe('useVideoProcessing completion gate', () => {
    it('treats a blank generation as a failure instead of completing', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: '   \n  ' });

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

        expect(serviceMocks.generateDocument).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('error');
    });

    it('completes only after every planned prompt has been saved', async () => {
        const prompts = [
            createPrompt('prompt-a', 'Prompt A'),
            createPrompt('prompt-b', 'Prompt B'),
        ];
        serviceMocks.generateDocument.mockImplementation(
            ({ prompt: { content } }: { prompt: { content: string } }) =>
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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });
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
        expect(serviceMocks.generateDocument).toHaveBeenCalledTimes(1);

        saveDeferred.resolve();
        await first;
        expect(serviceMocks.saveTranscription).toHaveBeenCalledTimes(1);
    });
});

describe('useVideoProcessing abort handling', () => {
    it('does not save a document generated before the job was canceled', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        serviceMocks.generateDocument.mockImplementation(() => {
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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });
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

        expect(serviceMocks.generateDocument).not.toHaveBeenCalled();
        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
        expect(getCurrentStatus().status).toBe('error');
        expect(getCurrentStatus().error).toContain('見つかりません');
    });

    it('completes on a resume even when completedPromptIds carries a deleted prompt', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });

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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });
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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });
        serviceMocks.saveTranscription.mockRejectedValueOnce(new Error('firestore down'));

        const hook = useProcessingHarness([prompt]);
        const job = createJob(createFile([prompt.id!]));
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });

        await hook.processTranscription(job, audioBlob, '192k', 44100);
        expect(getCurrentStatus().status).toBe('error');

        serviceMocks.saveTranscription.mockResolvedValue('doc-1');
        await hook.processTranscriptionResume(job, null, [], '192k', 44100);

        expect(serviceMocks.generateDocument).toHaveBeenCalledTimes(1);
        // 下書きが残っているので Storage へ上げ直さない
        expect(serviceMocks.uploadAudioToStorage).toHaveBeenCalledTimes(1);
        expect(getCurrentStatus().status).toBe('completed');
    });
});

describe('useVideoProcessing owner argument', () => {
    it('passes the pinned uid to saveTranscription so the write is checked there too', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });

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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });
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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });
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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });

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
        serviceMocks.generateDocument.mockImplementation(() => {
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
        serviceMocks.generateDocument.mockImplementation(() =>
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
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });
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

describe('useVideoProcessing サーバ経由の文書生成 (#4)', () => {
    const DEBUG_OFF = { ffmpegError: false, geminiError: false, errorAtFileIndex: 0, errorAtSegmentIndex: 0 };

    beforeEach(() => {
        serviceMocks.generateDocument.mockResolvedValue({
            success: true,
            text: 'generated',
            usedModel: 'gemini-resolved',
            usedThinkingLevel: 'HIGH',
            transport: 'files_api',
            elapsedMs: 100,
        });
        serviceMocks.uploadAudioToStorage.mockResolvedValue('audio/user-1/1_sample.mp3');
    });

    it('Storage のパス・元ファイルの MIME・プロンプト・signal を API クライアントへ渡す', async () => {
        const prompt: Prompt = { ...createPrompt('prompt-a', 'Prompt A'), thinkingLevel: 'high' };
        const hook = useProcessingHarness([prompt]);
        const file = createFile([prompt.id!]);

        await hook.processTranscription(createJob(file), new Blob(['audio'], { type: 'audio/mpeg' }), '128k', 44100);

        expect(serviceMocks.uploadAudioToStorage).toHaveBeenCalledTimes(1);
        expect(serviceMocks.generateDocument).toHaveBeenCalledTimes(1);
        expect(serviceMocks.generateDocument).toHaveBeenCalledWith({
            storagePath: 'audio/user-1/1_sample.mp3',
            fileName: 'sample.mp3',
            mimeType: 'audio/mpeg',
            prompt: {
                name: 'Prompt A',
                content: 'Prompt A content',
                model: 'gemini-test',
                thinkingLevel: 'high',
            },
            signal: expect.any(AbortSignal),
        });
        expect(getCurrentStatus()).toMatchObject({ status: 'completed', transcriptionCount: 1 });
        // 保存には応答の usedModel / thinkingLevel と Storage パスを使う
        expect(serviceMocks.saveTranscription.mock.calls[0][7]).toBe('audio/user-1/1_sample.mp3');
        expect(serviceMocks.saveTranscription.mock.calls[0][8]).toBe('gemini-resolved');
        expect(serviceMocks.saveTranscription.mock.calls[0][10]).toBe('HIGH');
    });

    it('API に渡す signal はそのジョブの中止で aborted になる', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        let capturedSignal: AbortSignal | undefined;
        serviceMocks.generateDocument.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
            capturedSignal = signal;
            hook.cancelJob(FILE_ID, '中止しました。');
            // 実物のクライアントは fetch が落ちたとき signal.reason を投げ直す
            throw signal!.reason;
        });

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '128k',
            44100
        );

        expect(capturedSignal?.aborted).toBe(true);
        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
        expect(getCurrentStatus()).toMatchObject({ status: 'canceled', phase: 'canceled' });
    });

    it('動画直送 (Blob が video/*) はサーバへ video/* を渡す', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        const file: FileWithPrompts = {
            file: { name: 'clip.mp4', type: 'video/mp4' } as File,
            selectedPromptIds: [prompt.id!],
        };

        await hook.processTranscription(createJob(file), file.file as Blob, '128k', 44100);

        expect(serviceMocks.generateDocument.mock.calls[0][0]).toMatchObject({
            fileName: 'clip.mp4',
            mimeType: 'video/mp4',
        });
        expect(serviceMocks.uploadAudioToStorage.mock.calls[0][2]).toMatchObject({ originalFileType: 'video' });
    });

    it('動画を音声に変換した Blob (audio/mpeg) は元が動画でも audio/mpeg を渡す', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        const file: FileWithPrompts = {
            file: { name: 'clip.mp4', type: 'video/mp4' } as File,
            selectedPromptIds: [prompt.id!],
        };

        await hook.processTranscription(createJob(file), new Blob(['mp3'], { type: 'audio/mpeg' }), '128k', 44100);

        expect(serviceMocks.generateDocument.mock.calls[0][0]).toMatchObject({ mimeType: 'audio/mpeg' });
    });

    it('複数プロンプトでも Storage へのアップロードは 1 回で、同じパスを共有する', async () => {
        const prompts = [createPrompt('prompt-a', 'Prompt A'), createPrompt('prompt-b', 'Prompt B')];
        const hook = useProcessingHarness(prompts);
        const file = createFile(prompts.map(prompt => prompt.id!));

        await hook.processTranscription(createJob(file), new Blob(['audio'], { type: 'audio/mpeg' }), '128k', 44100);

        expect(serviceMocks.uploadAudioToStorage).toHaveBeenCalledTimes(1);
        expect(serviceMocks.generateDocument).toHaveBeenCalledTimes(2);
        const paths = serviceMocks.generateDocument.mock.calls.map(call => call[0].storagePath);
        expect(paths).toEqual(['audio/user-1/1_sample.mp3', 'audio/user-1/1_sample.mp3']);
        expect(getCurrentStatus()).toMatchObject({ status: 'completed', transcriptionCount: 2 });
    });

    it('API の失敗文言 (429 等) をそのままプロンプトの失敗として表示する', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.generateDocument.mockResolvedValue({
            success: false,
            error: '1時間あたりの上限に達しました。（約90秒後に再試行できます）',
        });
        const hook = useProcessingHarness([prompt]);

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '128k',
            44100
        );

        expect(getCurrentStatus()).toMatchObject({ status: 'error', failedPhase: 'text_generation' });
        expect(getCurrentStatus().error).toContain('約90秒後に再試行できます');
        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
    });

    it('デバッグの「Gemini エラーを発生させる」はクライアント側で API を呼ばずに失敗にする', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useVideoProcessing([prompt], { ...DEBUG_OFF, geminiError: true, errorAtFileIndex: 0 });
        hook.setProcessingStatuses([createStatus(1)]);
        hook.geminiClientRef.current = { generateDocument: serviceMocks.generateDocument } as never;

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '128k',
            44100
        );

        expect(serviceMocks.uploadAudioToStorage).not.toHaveBeenCalled();
        expect(serviceMocks.generateDocument).not.toHaveBeenCalled();
        expect(getCurrentStatus()).toMatchObject({ status: 'error', failedPhase: 'text_generation' });
        expect(getCurrentStatus().error).toContain('[デバッグ]');
    });
});

describe('useVideoProcessing 全文文字起こし（バッチ）の確認待ちと再開（仕様 §A4）', () => {
    const transcriptPrompt = createPrompt(TRANSCRIPT_PROMPT_ID, '全文文字起こし');
    const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });
    const submitted = { jobId: 'job-1', docId: 'doc-1' };
    const pendingResult: RunBatchTranscriptionResult = {
        outcome: 'pending', success: false, pending: true, ...submitted, lastStatus: null,
    };
    const succeededResult: RunBatchTranscriptionResult = { outcome: 'succeeded', success: true, ...submitted };

    beforeEach(() => {
        batchMocks.runBatchTranscription.mockReset();
        batchMocks.resumeBatchTranscription.mockReset();
    });

    it('🔴 確認上限の pending は赤い失敗にせず「確認待ち」にし、段階と ID を処理欄へ残す', async () => {
        batchMocks.runBatchTranscription.mockImplementation(async (input: RunBatchTranscriptionInput) => {
            input.onSubmitted?.(submitted);
            input.onTick?.({ status: 'running', docId: 'doc-1', stage: 'queued' });
            input.onTick?.({ status: 'running', docId: 'doc-1', stage: 'transcribing', azureStatusCheckedAtMs: 1_700_000_000_000 });
            return pendingResult;
        });
        const hook = useProcessingHarness([transcriptPrompt]);

        await hook.processTranscription(createJob(createFile([TRANSCRIPT_PROMPT_ID])), audioBlob, '192k', 44100);

        const status = getCurrentStatus();
        expect(status.status).toBe('pending_confirmation');
        expect(status.phase).toBe('awaiting_confirmation');
        expect(status.error).toBeUndefined();
        expect(status.failedPhase).toBeUndefined();
        expect(status.promptStates[TRANSCRIPT_PROMPT_ID]).toBe('awaiting_confirmation');
        expect(status.batch).toMatchObject({
            jobId: 'job-1', docId: 'doc-1', promptId: TRANSCRIPT_PROMPT_ID,
            stage: 'transcribing', observedAtMs: 1_700_000_000_000, confirmation: 'pending',
        });
        expect(status.completedPromptIds).toEqual([]);
        expect(serviceMocks.saveTranscription).not.toHaveBeenCalled();
    });

    it('🔴 確認待ちからの再開は保存した ID で確認を再開し、submit も音声の再アップロードもしない', async () => {
        batchMocks.runBatchTranscription.mockImplementation(async (input: RunBatchTranscriptionInput) => {
            input.onSubmitted?.(submitted);
            return pendingResult;
        });
        batchMocks.resumeBatchTranscription.mockResolvedValue(succeededResult);
        const hook = useProcessingHarness([transcriptPrompt]);
        const file = createFile([TRANSCRIPT_PROMPT_ID]);

        await hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        expect(getCurrentStatus().status).toBe('pending_confirmation');
        expect(serviceMocks.uploadAudioToStorage).toHaveBeenCalledTimes(1);

        await hook.processTranscriptionResume(createJob(file), audioBlob, [], '192k', 44100);

        expect(batchMocks.runBatchTranscription).toHaveBeenCalledTimes(1);
        expect(serviceMocks.uploadAudioToStorage).toHaveBeenCalledTimes(1);
        expect(batchMocks.resumeBatchTranscription).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ jobId: 'job-1', docId: 'doc-1', signal: expect.any(AbortSignal) }),
        );
        expect(getCurrentStatus()).toMatchObject({
            status: 'completed',
            transcriptionCount: 1,
            completedPromptIds: [TRANSCRIPT_PROMPT_ID],
        });
        expect(getCurrentStatus().batch).toMatchObject({ jobId: 'job-1', stage: 'completed', confirmation: 'done' });
    });

    it('提出後の中止は「この画面での確認の停止」として ID と段階を残し、再開でも submit しない', async () => {
        batchMocks.runBatchTranscription.mockImplementation((input: RunBatchTranscriptionInput) => {
            input.onSubmitted?.(submitted);
            input.onTick?.({ status: 'running', docId: 'doc-1', stage: 'transcribing' });
            return new Promise<RunBatchTranscriptionResult>((_resolve, reject) => {
                input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
            });
        });
        const hook = useProcessingHarness([transcriptPrompt]);
        const file = createFile([TRANSCRIPT_PROMPT_ID]);

        const processing = hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        await vi.waitFor(() => expect(batchMocks.runBatchTranscription).toHaveBeenCalledTimes(1));
        hook.cancelJob(FILE_ID, 'この画面での確認を停止しました。');
        await processing;

        expect(getCurrentStatus()).toMatchObject({ status: 'canceled', phase: 'canceled' });
        expect(getCurrentStatus().batch).toMatchObject({ jobId: 'job-1', stage: 'transcribing', confirmation: 'stopped' });

        batchMocks.resumeBatchTranscription.mockResolvedValue(succeededResult);
        await hook.processTranscriptionResume(createJob(file), audioBlob, [], '192k', 44100);

        expect(batchMocks.runBatchTranscription).toHaveBeenCalledTimes(1);
        expect(batchMocks.resumeBatchTranscription).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ jobId: 'job-1', docId: 'doc-1' }),
        );
        expect(getCurrentStatus().status).toBe('completed');
    });

    it('サーバが失敗を確定した場合はこれまでどおり理由つきの失敗にする', async () => {
        batchMocks.runBatchTranscription.mockImplementation(async (input: RunBatchTranscriptionInput) => {
            input.onSubmitted?.(submitted);
            return { outcome: 'failed', success: false, ...submitted, error: '音声が長すぎます' };
        });
        const hook = useProcessingHarness([transcriptPrompt]);

        await hook.processTranscription(createJob(createFile([TRANSCRIPT_PROMPT_ID])), audioBlob, '192k', 44100);

        expect(getCurrentStatus()).toMatchObject({ status: 'error', failedPhase: 'text_generation' });
        expect(getCurrentStatus().error).toContain('音声が長すぎます');
    });

    it('成功時は batch を完了で閉じ、再開しても submit も確認再開も呼ばない（冪等）', async () => {
        batchMocks.runBatchTranscription.mockImplementation(async (input: RunBatchTranscriptionInput) => {
            input.onSubmitted?.(submitted);
            input.onTick?.({ status: 'succeeded', docId: 'doc-1', stage: 'completed' });
            return succeededResult;
        });
        const hook = useProcessingHarness([transcriptPrompt]);
        const file = createFile([TRANSCRIPT_PROMPT_ID]);

        await hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        expect(getCurrentStatus()).toMatchObject({ status: 'completed', transcriptionCount: 1 });
        expect(getCurrentStatus().batch).toMatchObject({ stage: 'completed', confirmation: 'done' });

        await hook.processTranscriptionResume(createJob(file), audioBlob, [TRANSCRIPT_PROMPT_ID], '192k', 44100);
        expect(batchMocks.runBatchTranscription).toHaveBeenCalledTimes(1);
        expect(batchMocks.resumeBatchTranscription).not.toHaveBeenCalled();
    });

    /**
     * 🔴 提出の往復中の中止（レビュー 2026-09-22 S2）。提出は中止で切らずに完了し、
     *    ID は中止の後に届く。届いた ID を保持できないと再開が再 submit になり、二重課金と
     *    重複文書を生む。ここは呼出元側の錠（client 側の錠は batchTranscriptionClient.test.ts）。
     */
    it('🔴 提出の往復中に中止しても、遅れて届いた ID を保持して再開は確認から始める（再 submit しない）', async () => {
        batchMocks.runBatchTranscription.mockImplementation((input: RunBatchTranscriptionInput) =>
            new Promise<RunBatchTranscriptionResult>((_resolve, reject) => {
                // 実装の契約: 提出は中止で切らず、完了させて ID を渡してから中止で拒否する
                input.signal?.addEventListener('abort', () => {
                    input.onSubmitted?.(submitted);
                    reject(input.signal?.reason);
                }, { once: true });
            }));
        const hook = useProcessingHarness([transcriptPrompt]);
        const file = createFile([TRANSCRIPT_PROMPT_ID]);

        const processing = hook.processTranscription(createJob(file), audioBlob, '192k', 44100);
        await vi.waitFor(() => expect(batchMocks.runBatchTranscription).toHaveBeenCalledTimes(1));
        hook.cancelJob(FILE_ID, 'この画面での確認を停止しました。');
        await processing;

        expect(getCurrentStatus()).toMatchObject({ status: 'canceled', phase: 'canceled' });
        expect(getCurrentStatus().batch).toMatchObject({
            jobId: 'job-1', docId: 'doc-1', promptId: TRANSCRIPT_PROMPT_ID, confirmation: 'stopped',
        });

        batchMocks.resumeBatchTranscription.mockResolvedValue(succeededResult);
        await hook.processTranscriptionResume(createJob(file), audioBlob, [], '192k', 44100);

        expect(batchMocks.runBatchTranscription).toHaveBeenCalledTimes(1);
        expect(serviceMocks.uploadAudioToStorage).toHaveBeenCalledTimes(1);
        expect(batchMocks.resumeBatchTranscription).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ jobId: 'job-1', docId: 'doc-1' }),
        );
        expect(getCurrentStatus().status).toBe('completed');
    });

    it('🔴 提出の応答が消えた失敗は、再提出で文書が重複し得る案内を利用者に見える文言で出す', async () => {
        batchMocks.runBatchTranscription.mockRejectedValue(new Error(
            '提出の応答を受け取れませんでした。'
            + '再開すると再提出になり、既に受理されていた場合は文書が重複します。'
            + '文書一覧で「処理中」の文書が無いか確認してから再開してください。'));
        const hook = useProcessingHarness([transcriptPrompt]);

        await hook.processTranscription(createJob(createFile([TRANSCRIPT_PROMPT_ID])), audioBlob, '192k', 44100);

        expect(getCurrentStatus()).toMatchObject({ status: 'error', failedPhase: 'text_generation' });
        expect(getCurrentStatus().error).toContain('提出の応答を受け取れませんでした。');
        expect(getCurrentStatus().error).toContain('既に受理されていた場合は文書が重複します。');
        expect(getCurrentStatus().error).toContain('文書一覧で「処理中」の文書が無いか確認してから再開してください。');
    });
});


/**
 * サイズ超過だけに「変換し直して再試行」を出すための種別づけ。
 * 🔴 判定はサーバ契約のコードと HTTP status だけ。文言は見ない
 *    (サーバ側の文言は実際に変わった: 「大きすぎます」→「上限 200MB を超えています」)。
 */
describe('isMediaTooLargeFailure（サイズ超過の見分け）', () => {
    it('契約コード media_too_large を拾う', () => {
        expect(isMediaTooLargeFailure({ errorCode: 'media_too_large', errorStatus: 413 })).toBe(true);
    });

    it('契約本文が読めない応答でも HTTP 413 で拾う', () => {
        expect(isMediaTooLargeFailure({ errorCode: 'unknown', errorStatus: 413 })).toBe(true);
    });

    it('他の失敗は拾わない', () => {
        expect(isMediaTooLargeFailure({ errorCode: 'rate_limited', errorStatus: 429 })).toBe(false);
        expect(isMediaTooLargeFailure({ errorCode: 'upstream_error', errorStatus: 502 })).toBe(false);
        expect(isMediaTooLargeFailure({})).toBe(false);
    });

    it('🔴 文言では判定しない（サーバが言い回しを変えても結果が変わらない）', () => {
        // どちらもサーバが実際に返してきた/返しうるサイズ超過の文言だが、種別はコードだけで決まる
        expect(isMediaTooLargeFailure({ errorCode: 'media_too_large' })).toBe(true);
        // 「大きすぎます」と書いてあってもコードが別なら too_large にしない
        expect(isMediaTooLargeFailure({ errorCode: 'upstream_error', errorStatus: 502 })).toBe(false);
    });
});

describe('useVideoProcessing サイズ超過の失敗（変換し直して再試行の土台）', () => {
    const overLimitBlob = (size: number = GENERATE_MAX_MEDIA_BYTES + 1) =>
        ({ size, type: 'audio/mpeg' }) as Blob;

    it('アップロード前のサイズガードは too_large と実測値を残す', async () => {
        const transcriptPrompt = createPrompt(TRANSCRIPT_PROMPT_ID, '全文文字起こし');
        const hook = useProcessingHarness([transcriptPrompt]);
        const file = createFile([TRANSCRIPT_PROMPT_ID]);

        await hook.processTranscription(createJob(file), overLimitBlob(), '96k', 44100);

        expect(getCurrentStatus()).toMatchObject({
            status: 'error',
            failedPhase: 'upload',
            failureKind: 'too_large',
            sizeFailure: {
                bytes: GENERATE_MAX_MEDIA_BYTES + 1,
                bitrate: '96k',
                // 変換済みの Blob を送っていた＝下げれば効く
                wasConverted: true,
                // 文字起こしだけの行なので、破ったのはアップロード (Storage) の上限のまま
                limitBytes: GENERATE_MAX_MEDIA_BYTES,
            },
        });
        expect(serviceMocks.uploadAudioToStorage).not.toHaveBeenCalled();
    });

    /**
     * 🔴 同じアップロードを文字起こしも使う。生成の上限 (200MB) を一律に持ち込むと、
     *    300MB のファイルで**正常に動くはずの文字起こしまで殺す**。
     *    絞ってよいのは「この実行に文字起こしが 1 つも無い」＝生成専用のときだけ。
     */
    it('🔴 生成専用の行は、同期生成の上限を超えた時点でアップロードせずに落とす', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        const blob = { size: 300 * 1024 * 1024, type: 'audio/mpeg' } as Blob;

        await hook.processTranscription(createJob(createFile([prompt.id!])), blob, '96k', 44100);

        expect(serviceMocks.uploadAudioToStorage).not.toHaveBeenCalled();
        expect(getCurrentStatus()).toMatchObject({
            status: 'error',
            failureKind: 'too_large',
            sizeFailure: { limitBytes: GENERATE_SYNC_MAX_MEDIA_BYTES },
        });
        expect(getCurrentStatus().error).toContain('文書生成に送れる上限');
    });

    it('🔴 文字起こしを含む行の 300MB は、アップロードして文字起こしを走らせる', async () => {
        const transcriptPrompt = createPrompt(TRANSCRIPT_PROMPT_ID, '全文文字起こし');
        batchMocks.runBatchTranscription.mockImplementation(
            async (input: RunBatchTranscriptionInput) => {
                input.onSubmitted?.({ jobId: 'job-1', docId: 'doc-1' });
                return { outcome: 'succeeded', success: true, jobId: 'job-1', docId: 'doc-1' };
            }
        );
        const hook = useProcessingHarness([transcriptPrompt]);
        const blob = { size: 300 * 1024 * 1024, type: 'audio/mpeg' } as Blob;

        await hook.processTranscription(createJob(createFile([TRANSCRIPT_PROMPT_ID])), blob, '96k', 44100);

        expect(serviceMocks.uploadAudioToStorage).toHaveBeenCalledTimes(1);
        expect(batchMocks.runBatchTranscription).toHaveBeenCalledTimes(1);
        expect(getCurrentStatus()).toMatchObject({ status: 'completed' });
    });

    /**
     * 🔴 6時間・192k (518MB) はアップロードのガード (500MB) が先に発火する。予算をそのまま
     *    500MB にすると 192k のままが選ばれ、再変換 415MB → アップロードは通る →
     *    今度は生成が 200MB 超で 413（2 押し目）。生成を含む行は両方を満たす値まで一度で下げる。
     */
    it('🔴 生成を含む行は、アップロード上限で落ちても予算を同期生成の上限まで絞る', async () => {
        const transcriptPrompt = createPrompt(TRANSCRIPT_PROMPT_ID, '全文文字起こし');
        const docPrompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([transcriptPrompt, docPrompt], 2);

        await hook.processTranscription(
            createJob(createFile([TRANSCRIPT_PROMPT_ID, 'prompt-a'])),
            overLimitBlob(),
            '192k',
            44100
        );

        expect(getCurrentStatus().sizeFailure).toMatchObject({
            limitBytes: GENERATE_SYNC_MAX_MEDIA_BYTES,
        });
    });

    it('文字起こしだけの行には、生成の上限を持ち込まない', async () => {
        const transcriptPrompt = createPrompt(TRANSCRIPT_PROMPT_ID, '全文文字起こし');
        const hook = useProcessingHarness([transcriptPrompt]);

        await hook.processTranscription(
            createJob(createFile([TRANSCRIPT_PROMPT_ID])),
            overLimitBlob(),
            '192k',
            44100
        );

        expect(getCurrentStatus().sizeFailure).toMatchObject({
            limitBytes: GENERATE_MAX_MEDIA_BYTES,
        });
    });

    it('🔴 元ファイルをそのまま送っていた失敗は wasConverted=false（下げても効かない入力）', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        // 変換を通らずそのまま送られる経路では、送る Blob が元ファイルそのもの
        const file: FileWithPrompts = {
            file: { name: '会議音声.m4a', type: 'audio/mp4', size: GENERATE_MAX_MEDIA_BYTES + 1 } as File,
            selectedPromptIds: [prompt.id!],
        };

        await hook.processTranscription(createJob(file), file.file as Blob, '96k', 44100);

        expect(getCurrentStatus()).toMatchObject({
            failureKind: 'too_large',
            sizeFailure: { wasConverted: false, bitrate: '96k' },
        });
    });

    it('🔴 サーバ 413 (media_too_large) は、破った上限を「同期文書生成の上限」として記録する', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        // 文言ではなく契約コードで種別が決まる。文言はサーバ都合で変わる前提で無関係な文にしておく
        serviceMocks.generateDocument.mockResolvedValue({
            success: false,
            error: 'サーバ側の都合でいつ変わってもよい文言',
            errorCode: 'media_too_large',
            errorStatus: 413,
        });
        const hook = useProcessingHarness([prompt]);
        const audioBlob = new Blob(['audio'], { type: 'audio/mpeg' });

        await hook.processTranscription(createJob(createFile([prompt.id!])), audioBlob, '128k', 44100);

        // 🔴 ボタンを出すには実測値が必ず要る。413 の経路でも欠けないこと
        expect(getCurrentStatus()).toMatchObject({
            status: 'error',
            failureKind: 'too_large',
            sizeFailure: {
                bytes: audioBlob.size,
                bitrate: '128k',
                wasConverted: true,
                limitBytes: GENERATE_SYNC_MAX_MEDIA_BYTES,
            },
        });
    });

    it('契約本文が読めない 413 でも種別を落とさない', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.generateDocument.mockResolvedValue({
            success: false,
            error: '文書生成サーバがエラーを返しました（HTTP 413）。',
            errorCode: 'unknown',
            errorStatus: 413,
        });
        const hook = useProcessingHarness([prompt]);

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '128k',
            44100
        );

        expect(getCurrentStatus()).toMatchObject({
            failureKind: 'too_large',
            sizeFailure: { limitBytes: GENERATE_SYNC_MAX_MEDIA_BYTES },
        });
    });

    // 時間上限はバッチ提出の 400 で返る別経路。413 でも media_too_large でもないので種別は付かない
    it('🔴 時間上限で失敗したジョブには種別を付けない（下げても直らないため）', async () => {
        const transcriptPrompt = createPrompt(TRANSCRIPT_PROMPT_ID, '全文文字起こし');
        batchMocks.runBatchTranscription.mockImplementation(async (input: RunBatchTranscriptionInput) => {
            input.onSubmitted?.({ jobId: 'job-1', docId: 'doc-1' });
            return {
                outcome: 'failed', success: false, jobId: 'job-1', docId: 'doc-1',
                error: `音声が長すぎます（上限 ${Math.floor(AZURE_BATCH_MAX_AUDIO_SEC / 60)} 分）。分割してお試しください。`,
            };
        });
        const hook = useProcessingHarness([transcriptPrompt]);

        await hook.processTranscription(
            createJob(createFile([TRANSCRIPT_PROMPT_ID])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '96k',
            44100
        );

        expect(getCurrentStatus()).toMatchObject({ status: 'error' });
        expect(getCurrentStatus().failureKind).toBeUndefined();
        expect(getCurrentStatus().sizeFailure).toBeUndefined();
    });

    it('サイズ以外の失敗には種別も実測値も残さない', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        serviceMocks.generateDocument.mockResolvedValue({
            success: false,
            error: '1時間あたりの上限に達しました。（約90秒後に再試行できます）',
            errorCode: 'rate_limited',
            errorStatus: 429,
        });
        const hook = useProcessingHarness([prompt]);

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            new Blob(['audio'], { type: 'audio/mpeg' }),
            '128k',
            44100
        );

        expect(getCurrentStatus().failureKind).toBeUndefined();
        expect(getCurrentStatus().sizeFailure).toBeUndefined();
    });

    /**
     * 🔴 実害: 2 行とも 192k で変換済み・両方 413。行1で再試行すると setBitrate('64k') が
     *    グローバル値を書き換える。行2で通常の「再開する」を押すと 192k のキャッシュが
     *    再利用されるのに、失敗の記録が 64k になり計画が `already_lowest` に化ける
     *    ＝実際には有効な 96k の再試行が隠れる。焼いた値のほうを正とする。
     */
    it('🔴 キャッシュ済み音声の失敗には、その Blob を焼いたビットレートを記録する', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        const cachedBlob = overLimitBlob();
        // 192k で変換済みのキャッシュを持つ行
        hook.setProcessingStatuses([{
            ...createStatus(1),
            convertedAudioBlob: cachedBlob,
            convertedAudioBitrate: '192k',
        }]);

        // 画面のビットレートは他の行の再試行で 64k に変わっている
        await hook.processTranscriptionResume(createJob(createFile([prompt.id!])), cachedBlob, [], '64k', 44100);

        expect(getCurrentStatus().sizeFailure).toMatchObject({ bitrate: '192k', wasConverted: true });
    });

    it('焼いた値が残っていない（そのまま送る経路など）ときは渡された値を使う', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);

        await hook.processTranscription(createJob(createFile([prompt.id!])), overLimitBlob(), '96k', 44100);

        expect(getCurrentStatus().sizeFailure).toMatchObject({ bitrate: '96k' });
    });

    it('新しい試行を始めると前回の種別が消える', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        const hook = useProcessingHarness([prompt]);
        const file = createFile([prompt.id!]);

        await hook.processTranscription(createJob(file), overLimitBlob(), '96k', 44100);
        expect(getCurrentStatus().failureKind).toBe('too_large');

        // 上限内の Blob で再試行すれば、種別も実測値も残らない
        serviceMocks.generateDocument.mockResolvedValue({ success: true, text: 'generated' });
        await hook.processTranscriptionResume(
            createJob(file), new Blob(['audio'], { type: 'audio/mpeg' }), [], '64k', 44100
        );

        expect(getCurrentStatus()).toMatchObject({ status: 'completed' });
        expect(getCurrentStatus().failureKind).toBeUndefined();
        expect(getCurrentStatus().sizeFailure).toBeUndefined();
    });
});


/**
 * 🔴 既存バグ: `estimateAudioSec` は「サイズ ÷ 画面のビットレート」で長さを出すので、
 *    そのまま送られる入力（画面設定で焼かれていない）では実長を誤る。
 *    元が 192k の m4a を既定 96k で出すと長さが 2 倍に見え、**2 時間の商談が**
 *    「音声が長すぎます（上限 240 分）」で誤って拒否される。しかも 400 なので種別が付かず、
 *    正しい回避策（ビットレートを上げる）は同じ画面が「使われません」と言っている。
 */
describe('useVideoProcessing 提出に渡す音声長（実測を優先する）', () => {
    const transcriptPrompt = createPrompt(TRANSCRIPT_PROMPT_ID, '全文文字起こし');

    /** 192k・2時間30分 = 9000秒。画面設定 96k での推定は 18000 秒（＝4時間超）になる */
    const AS_IS_BLOB = { size: (192 * 1000 / 8) * 9000, type: 'audio/mp4' } as Blob;

    /** サーバの提出ゲート（`/api/transcribe/submit` の 240 分判定）を再現する */
    const submitWithServerGate = () =>
        batchMocks.runBatchTranscription.mockImplementation(
            async (input: RunBatchTranscriptionInput) => {
                if (input.audioSec > AZURE_BATCH_MAX_AUDIO_SEC) {
                    throw new Error(
                        `音声が長すぎます（上限 ${Math.floor(AZURE_BATCH_MAX_AUDIO_SEC / 60)} 分）。分割してお試しください。`
                    );
                }
                input.onSubmitted?.({ jobId: 'job-1', docId: 'doc-1' });
                return { outcome: 'succeeded', success: true, jobId: 'job-1', docId: 'doc-1' };
            }
        );

    // 🔴 ハーネス生成 (フック呼び出し) は各テスト内で直接行う。補助関数に包むと
    //    react-hooks/rules-of-hooks に当たる（この補助は提出だけを受け持つ）
    const runSubmit = (
        hook: ReturnType<typeof useProcessingHarness>,
        blob: Blob,
        bitrate = '96k',
    ) => hook.processTranscription(
        createJob(createFile([TRANSCRIPT_PROMPT_ID])), blob, bitrate, 44100
    );

    it('🔴 そのまま送られる 2時間30分の音声は、実測が渡るので提出が通る', async () => {
        // 推定だと 18000 秒（4時間超）になり、実際は 9000 秒
        expect(estimateAudioSec(AS_IS_BLOB, '96k')).toBeGreaterThan(AZURE_BATCH_MAX_AUDIO_SEC);
        durationMocks.measureMediaDurationSec.mockResolvedValue(9000);
        submitWithServerGate();

        await runSubmit(useProcessingHarness([transcriptPrompt]), AS_IS_BLOB);

        expect(batchMocks.runBatchTranscription.mock.calls[0][0].audioSec).toBe(9000);
        expect(getCurrentStatus()).toMatchObject({ status: 'completed' });
    });

    it('🔴 実測でも 4 時間を超える音声は、従来どおり提出の門で落ちる', async () => {
        durationMocks.measureMediaDurationSec.mockResolvedValue(AZURE_BATCH_MAX_AUDIO_SEC + 1);
        submitWithServerGate();

        await runSubmit(useProcessingHarness([transcriptPrompt]), AS_IS_BLOB);

        expect(getCurrentStatus()).toMatchObject({ status: 'error' });
        expect(getCurrentStatus().error).toContain('音声が長すぎます');
    });

    it('測れなかったときは従来の推定へ落ちる', async () => {
        durationMocks.measureMediaDurationSec.mockResolvedValue(null);
        batchMocks.runBatchTranscription.mockImplementation(
            async (input: RunBatchTranscriptionInput) => {
                input.onSubmitted?.({ jobId: 'job-1', docId: 'doc-1' });
                return { outcome: 'succeeded', success: true, jobId: 'job-1', docId: 'doc-1' };
            }
        );

        // 🔴 推定が 0 にならない大きさで測る。極小の Blob だと推定も 0 になり、
        //    「門を素通しにする 0」との区別がつかない
        const blob = { size: (128 * 1000 / 8) * 600, type: 'audio/mpeg' } as Blob;
        await runSubmit(useProcessingHarness([transcriptPrompt]), blob, '128k');

        const passed = batchMocks.runBatchTranscription.mock.calls[0][0].audioSec;
        expect(passed).toBe(estimateAudioSec(blob, '128k'));
        expect(passed).toBe(600);
    });

    it('変換済み入力でも実測をそのまま渡す（推定とほぼ一致し、挙動は変わらない）', async () => {
        // 96k で 1 時間ぶんに変換した Blob。推定も実測も 3600 秒
        const converted = { size: (96 * 1000 / 8) * 3600, type: 'audio/mpeg' } as Blob;
        expect(estimateAudioSec(converted, '96k')).toBe(3600);
        durationMocks.measureMediaDurationSec.mockResolvedValue(3600);
        submitWithServerGate();

        await runSubmit(useProcessingHarness([transcriptPrompt]), converted);

        expect(batchMocks.runBatchTranscription.mock.calls[0][0].audioSec).toBe(3600);
        expect(getCurrentStatus()).toMatchObject({ status: 'completed' });
    });

    it('サイズ超過の記録にも実測の長さを残す（下げ先の見積りに使う）', async () => {
        const prompt = createPrompt('prompt-a', 'Prompt A');
        durationMocks.measureMediaDurationSec.mockResolvedValue(9000);
        const hook = useProcessingHarness([prompt]);

        await hook.processTranscription(
            createJob(createFile([prompt.id!])),
            { size: GENERATE_MAX_MEDIA_BYTES + 1, type: 'audio/mpeg' } as Blob,
            '96k',
            44100
        );

        expect(getCurrentStatus().sizeFailure).toMatchObject({ durationSec: 9000 });
    });
});

describe('resolveMediaMimeType（/api/generate に送る mimeType は storagePath 上のデータの種別）', () => {
    // 2026-09-22: e2e で「変換済み動画の mimeType は audio/mpeg」を観測し、契約コメント
    // (generateApiContract.ts) の「元ファイルの MIME」と食い違っていた。実装の意図はこちら
    // (Gemini へ渡すのは変換後のバイト列なので、その種別を送る) で、コメントを直した。ここで固定する。
    it('変換済み (Blob が audio/mpeg) の動画は audio/mpeg を送る', async () => {
        const { resolveMediaMimeType } = await import('./useVideoProcessing');
        expect(resolveMediaMimeType('audio/mpeg', 'video')).toBe('audio/mpeg');
    });

    it('動画直送 (Blob が video/*) は video/* をそのまま送る', async () => {
        const { resolveMediaMimeType } = await import('./useVideoProcessing');
        expect(resolveMediaMimeType('video/mp4', 'video')).toBe('video/mp4');
        expect(resolveMediaMimeType('video/quicktime', 'video')).toBe('video/quicktime');
    });

    it('Blob に種別が無いときだけ元ファイルの区分から補う', async () => {
        const { resolveMediaMimeType } = await import('./useVideoProcessing');
        expect(resolveMediaMimeType('', 'video')).toBe('video/mp4');
        expect(resolveMediaMimeType('', 'audio')).toBe('audio/mpeg');
    });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileProcessingStatus } from '@/types/processing';
import type { Prompt } from '@/lib/prompts';
import type { PromptLoadStatus } from '@/hooks/usePromptManagement';

const state = vi.hoisted(() => ({
    prompts: [] as Prompt[],
    promptStatus: 'success' as PromptLoadStatus,
    promptError: null as string | null,
    statuses: [] as FileProcessingStatus[],
    workflowError: null as string | null,
    pendingSaveCount: 0,
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: { uid: 'user-1' }, loading: false }),
}));

vi.mock('@/hooks/usePromptManagement', () => ({
    usePromptManagement: () => ({
        data: state.prompts,
        availablePrompts: state.prompts,
        status: state.promptStatus,
        error: state.promptError,
        retry: vi.fn(),
        reloadPrompts: vi.fn(),
        bulkSelectedPromptIds: [],
        toggleBulkPrompt: vi.fn(),
    }),
}));

vi.mock('@/hooks/useFileManagement', () => ({
    useFileManagement: () => ({
        selectedFiles: [],
        handleFilesSelected: vi.fn(),
        handleRemoveFile: vi.fn(),
        toggleFilePrompt: vi.fn(),
        clearFiles: vi.fn(),
        cleanupDeletedPrompts: vi.fn(),
    }),
}));

vi.mock('@/hooks/useVideoProcessing', () => ({
    useVideoProcessing: () => ({
        processingStatuses: state.statuses,
        setProcessingStatuses: vi.fn(),
        isProcessing: false,
        setIsProcessing: vi.fn(),
        ffmpegLoaded: false,
        setFfmpegLoaded: vi.fn(),
        converterRef: { current: null },
        geminiClientRef: { current: null },
        audioConversionQueueRef: { current: false },
        processTranscription: vi.fn(),
        processTranscriptionResume: vi.fn(),
        activeJobIds: [],
        hasActiveJobs: false,
        pendingSaveCount: state.pendingSaveCount,
        needsDiscardConfirm: state.pendingSaveCount > 0,
        pendingSavesForFile: () => state.pendingSaveCount,
        needsRemovalConfirm: () => state.pendingSaveCount > 0,
        isCanceling: false,
        claimJob: vi.fn(),
        cancelJob: vi.fn(),
        markJobCanceled: vi.fn(),
        resetProcessing: vi.fn(),
        forceDiscardProcessing: vi.fn(),
        countPendingSaves: vi.fn(() => 0),
    }),
}));

vi.mock('@/hooks/useProcessingWorkflow', () => ({
    useProcessingWorkflow: () => ({
        handleStartProcessing: vi.fn(),
        handleResumeFile: vi.fn(),
        workflowError: state.workflowError,
        clearWorkflowError: vi.fn(),
        reportWorkflowError: vi.fn(),
    }),
}));

// S2-2: 離脱ガードは next/navigation を使う。ここは見出し・文言の錠なので中身を差し替える
vi.mock('@/hooks/useNavigationGuard', () => ({
    useNavigationGuard: () => ({ leaveConfirmation: null, approveLeave: vi.fn(), denyLeave: vi.fn() }),
}));

vi.mock('@/components/PromptListSidebar', () => ({
    PromptListSidebar: () => <div>プロンプト一覧</div>,
}));
vi.mock('@/components/prompts/PromptModals', () => ({
    PromptModals: () => null,
}));
vi.mock('@/components/NotificationBanner', () => ({
    NotificationBanner: () => null,
}));
vi.mock('@/components/DebugControls', () => ({
    DebugControls: () => null,
}));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const pageModule = await import('./page');
const HomePage = pageModule.default;
const { removeFileEntry } = pageModule;

const render = () => renderToStaticMarkup(<HomePage />);

const createPrompt = (id: string): Prompt => ({
    id,
    name: `プロンプト ${id}`,
    content: 'content',
    model: 'gemini-test',
    isDefault: false,
    ownerType: 'user',
    ownerId: 'user-1',
    createdBy: 'user-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

beforeEach(() => {
    state.prompts = [createPrompt('prompt-a')];
    state.promptStatus = 'success';
    state.promptError = null;
    state.statuses = [];
    state.workflowError = null;
    state.pendingSaveCount = 0;
});

describe('home page headings (R11)', () => {
    it('has exactly one h1 and it names the page', () => {
        const markup = render();

        expect(markup.match(/<h1\b/g) ?? []).toHaveLength(1);
        expect(markup).toMatch(/<h1[^>]*>ホーム<\/h1>/);
    });

    it('demotes the card headings below the page heading', () => {
        const markup = render();

        // アップロードカードは h1 ではなく h2
        expect(markup).toContain('動画・音声をアップロード');
        expect(markup).not.toMatch(/<h1[^>]*>[^<]*動画・音声をアップロード/);
        expect(markup).toMatch(/<h2[^>]*>\s*動画・音声をアップロード\s*<\/h2>/);
    });

    it('keeps the progress card heading at h2 when statuses exist', () => {
        state.statuses = [{
            fileId: 'f1',
            fileName: 'sample.mp4',
            status: 'waiting',
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
        }];

        const markup = render();

        expect(markup.match(/<h1\b/g) ?? []).toHaveLength(1);
        expect(markup).toMatch(/<h2[^>]*id="processing-status-heading"/);
    });
});

describe('home page prompt guidance (R8)', () => {
    it('offers to create a prompt only when the list loaded successfully', () => {
        state.prompts = [];
        state.promptStatus = 'success';

        expect(render()).toContain('プロンプトを作成する');
    });

    it('shows the load error instead of claiming there are no prompts yet', () => {
        state.prompts = [];
        state.promptStatus = 'error';
        state.promptError = 'プロンプト一覧の読み込みに失敗しました。';

        const markup = render();

        expect(markup).toContain('プロンプト一覧の読み込みに失敗しました。');
        expect(markup).not.toContain('プロンプトがまだありません');
        expect(markup).not.toContain('プロンプトを作成する');
    });

    it('says nothing about missing prompts while the list is still loading', () => {
        state.prompts = [];
        state.promptStatus = 'loading';

        expect(render()).not.toContain('プロンプトを作成する');
    });
});

describe('removeFileEntry (V3)', () => {
    const status = (fileId: string): FileProcessingStatus => ({
        fileId,
        fileName: `${fileId}.mp4`,
        status: 'error',
        phase: 'text_generation',
        audioConversionProgress: 0,
        transcriptionCount: 0,
        totalTranscriptions: 1,
        completedPromptIds: [],
        promptStates: {},
        savePendingPromptIds: [],
        segmentDuration: 30,
        segments: [],
        completedSegmentIndices: [],
    });

    it('drops the id and its progress row together so the two lists stay aligned', () => {
        const result = removeFileEntry(['f1', 'f2', 'f3'], 'f2', [status('f1'), status('f2'), status('f3')]);

        expect(result.fileIds).toEqual(['f1', 'f3']);
        expect(result.statuses.map(entry => entry.fileId)).toEqual(['f1', 'f3']);
        // 残った各ファイルの位置が両リストで一致していること（再開の前提条件）
        result.fileIds.forEach((fileId, index) => {
            expect(result.statuses[index].fileId).toBe(fileId);
        });
    });

    it('leaves the progress rows alone when the removed file never ran', () => {
        const result = removeFileEntry(['f1', 'f2'], 'f2', [status('f1')]);

        expect(result.fileIds).toEqual(['f1']);
        expect(result.statuses.map(entry => entry.fileId)).toEqual(['f1']);
    });

    it('is a no-op for an id that is not present', () => {
        const result = removeFileEntry(['f1'], 'missing', [status('f1')]);

        expect(result.fileIds).toEqual(['f1']);
        expect(result.statuses).toHaveLength(1);
    });
});

describe('home page prompt retry wiring (V5)', () => {
    it('offers a retry next to the load error', () => {
        state.prompts = [];
        state.promptStatus = 'error';
        state.promptError = 'プロンプト一覧の読み込みに失敗しました。';

        const markup = render();

        expect(markup).toContain('プロンプト一覧を再読み込みする');
    });

    it('does not offer a retry when there is nothing to retry', () => {
        state.prompts = [createPrompt('prompt-a')];
        state.promptStatus = 'success';

        expect(render()).not.toContain('プロンプト一覧を再読み込みする');
    });

    it('says the list is loading rather than showing an empty upload card', () => {
        state.prompts = [];
        state.promptStatus = 'loading';

        const markup = render();

        expect(markup).toContain('プロンプト一覧を読み込んでいます');
        expect(markup).not.toContain('プロンプトを作成する');
    });
});

/** G5: role="alert" の枠ごとに切り出す。どの枠にボタンが入っているかを見るため */
const alertBlocks = (markup: string): string[] => {
    const blocks: string[] = [];
    let cursor = 0;
    while (true) {
        const start = markup.indexOf('role="alert"', cursor);
        if (start === -1) break;
        // 次の alert 枠の直前まで、あるいは末尾までを1枠とみなす
        const nextStart = markup.indexOf('role="alert"', start + 1);
        blocks.push(markup.slice(start, nextStart === -1 ? undefined : nextStart));
        cursor = start + 1;
    }
    return blocks;
};

describe('home page notice pairing (U4/G5)', () => {
    it('puts the retry inside the prompt-failure block, not the workflow one', () => {
        state.prompts = [];
        state.promptStatus = 'error';
        state.promptError = 'プロンプト一覧の読み込みに失敗しました。';
        state.workflowError = '処理エンジンの初期化に失敗しました。';

        const blocks = alertBlocks(render());
        const workflowBlock = blocks.find(block => block.includes('処理エンジンの初期化に失敗しました。'));
        const promptBlock = blocks.find(block => block.includes('プロンプト一覧の読み込みに失敗しました。'));

        expect(workflowBlock).toBeDefined();
        expect(promptBlock).toBeDefined();
        // 別々の枠であること（片方を優先表示にすると1枠に潰れる）
        expect(workflowBlock).not.toBe(promptBlock);
        // 再読み込みは「読み込みに失敗した」と書いてある枠の中だけにある
        expect(promptBlock).toContain('プロンプト一覧を再読み込みする');
        expect(workflowBlock).not.toContain('プロンプト一覧を再読み込みする');
    });

    it('shows only the workflow notice when the prompt list is healthy', () => {
        state.prompts = [createPrompt('prompt-a')];
        state.promptStatus = 'success';
        state.workflowError = '処理エンジンの初期化に失敗しました。';

        const markup = render();

        expect(markup).toContain('処理エンジンの初期化に失敗しました。');
        expect(markup).not.toContain('プロンプト一覧を再読み込みする');
    });
});

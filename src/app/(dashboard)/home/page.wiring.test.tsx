import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { FileProcessingStatus } from '@/types/processing';

/**
 * JSX は react/jsx-runtime が担うので、'react' のフックだけ差し替えれば
 * DOM なしで「クリック → 状態更新 → 再描画」を回せる。
 */
const reactHarness = vi.hoisted(() => ({
    stateCursor: 0,
    stateValues: [] as unknown[],
    effects: [] as Array<() => void>,
}));

const hookMocks = vi.hoisted(() => ({
    resetProcessing: vi.fn(),
    forceDiscardProcessing: vi.fn(),
    handleRemoveFile: vi.fn(),
    clearFiles: vi.fn(),
    statuses: [] as FileProcessingStatus[],
    fileIds: [] as string[],
    hasActiveJobs: false,
    pendingSaveCount: 0,
    user: { uid: 'user-1' } as { uid: string } | null,
}));

vi.mock('react', async () => {
    const actual = await vi.importActual<typeof import('react')>('react');
    return {
        ...actual,
        useCallback: <T,>(callback: T) => callback,
        useEffect: (effect: () => void | (() => void)) => {
            reactHarness.effects.push(() => { effect(); });
        },
        useState: <T,>(initialValue: T | (() => T)) => {
            const index = reactHarness.stateCursor;
            reactHarness.stateCursor += 1;
            if (!(index in reactHarness.stateValues)) {
                reactHarness.stateValues[index] = typeof initialValue === 'function'
                    ? (initialValue as () => T)()
                    : initialValue;
            }
            const setState = (next: T | ((current: T) => T)) => {
                const current = reactHarness.stateValues[index] as T;
                reactHarness.stateValues[index] = typeof next === 'function'
                    ? (next as (current: T) => T)(current)
                    : next;
            };
            return [reactHarness.stateValues[index] as T, setState] as const;
        },
    };
});

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: hookMocks.user, loading: false }),
}));

vi.mock('@/hooks/usePromptManagement', () => ({
    usePromptManagement: () => ({
        data: [],
        availablePrompts: [],
        status: 'success',
        error: null,
        retry: vi.fn(),
        reloadPrompts: vi.fn(),
        bulkSelectedPromptIds: [],
        toggleBulkPrompt: vi.fn(),
    }),
}));

vi.mock('@/hooks/useFileManagement', () => ({
    useFileManagement: () => ({
        selectedFiles: hookMocks.fileIds.map(fileId => ({
            file: { name: `${fileId}.mp4`, type: 'video/mp4' } as File,
            selectedPromptIds: ['prompt-a'],
        })),
        handleFilesSelected: vi.fn(),
        handleRemoveFile: hookMocks.handleRemoveFile,
        toggleFilePrompt: vi.fn(),
        clearFiles: hookMocks.clearFiles,
        cleanupDeletedPrompts: vi.fn(),
    }),
}));

vi.mock('@/hooks/useVideoProcessing', () => ({
    useVideoProcessing: () => ({
        processingStatuses: hookMocks.statuses,
        setProcessingStatuses: (updater: unknown) => {
            hookMocks.statuses = typeof updater === 'function'
                ? (updater as (p: FileProcessingStatus[]) => FileProcessingStatus[])(hookMocks.statuses)
                : (updater as FileProcessingStatus[]);
        },
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
        hasActiveJobs: hookMocks.hasActiveJobs,
        pendingSaveCount: hookMocks.pendingSaveCount,
        needsDiscardConfirm: hookMocks.hasActiveJobs || hookMocks.pendingSaveCount > 0,
        pendingSavesForFile: (fileId: string) =>
            hookMocks.statuses
                .filter(status => status.fileId === fileId)
                .reduce((total, status) => total + (status.savePendingPromptIds?.length ?? 0), 0),
        needsRemovalConfirm: (fileId: string) =>
            hookMocks.statuses.some(status =>
                status.fileId === fileId && (status.savePendingPromptIds?.length ?? 0) > 0
            ),
        isCanceling: false,
        claimJob: vi.fn(),
        cancelJob: vi.fn(),
        markJobCanceled: vi.fn(),
        resetProcessing: hookMocks.resetProcessing,
        forceDiscardProcessing: hookMocks.forceDiscardProcessing,
        countPendingSaves: vi.fn(() => 0),
    }),
}));

vi.mock('@/hooks/useProcessingWorkflow', () => ({
    useProcessingWorkflow: () => ({
        handleStartProcessing: vi.fn(),
        handleResumeFile: vi.fn(),
        workflowError: null,
        clearWorkflowError: vi.fn(),
        reportWorkflowError: vi.fn(),
    }),
}));

vi.mock('@/components/PromptListSidebar', () => ({ PromptListSidebar: () => null }));
vi.mock('@/components/prompts/PromptModals', () => ({ PromptModals: () => null }));
vi.mock('@/components/NotificationBanner', () => ({ NotificationBanner: () => null }));
vi.mock('@/components/DebugControls', () => ({ DebugControls: () => null }));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const HomePage = (await import('./page')).default;

interface Node {
    type: unknown;
    props: Record<string, unknown>;
}

/** 要素ツリーを深さ優先で全部たどる（DOM なしで描画結果を検査するため） */
const walk = (node: ReactNode, visit: (element: Node) => void): void => {
    if (Array.isArray(node)) {
        node.forEach(child => walk(child, visit));
        return;
    }
    if (!node || typeof node !== 'object') return;

    const element = node as unknown as ReactElement<Record<string, unknown>>;
    if (!element.props) return;

    visit({ type: element.type, props: element.props });
    walk(element.props.children as ReactNode, visit);
};

const textOf = (node: ReactNode): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    const element = node as unknown as ReactElement<Record<string, unknown>>;
    return element.props ? textOf(element.props.children as ReactNode) : '';
};

const render = () => {
    reactHarness.stateCursor = 0;
    reactHarness.effects = [];
    const tree = HomePage() as unknown as ReactNode;

    const elements: Node[] = [];
    walk(tree, element => elements.push(element));

    return {
        elements,
        text: textOf(tree),
        runEffects: () => reactHarness.effects.forEach(effect => effect()),
        button: (label: string) => elements.find(element =>
            element.type === 'button' && textOf(element.props.children as ReactNode).includes(label)
        ),
    };
};

/** G6: 利用者を差し替えて再描画し、effect をもう一度流す */
const switchUser = async (uid: string | null) => {
    hookMocks.user = uid === null ? null : { uid };
    render().runEffects();
    await Promise.resolve();
    await Promise.resolve();
    // effect が状態を書き換えたあとの画面を返す
    return render();
};

const click = async (label: string) => {
    const target = render().button(label);
    expect(target, `button not found: ${label}`).toBeDefined();
    await (target!.props.onClick as () => unknown)();
};

const createStatus = (fileId: string): FileProcessingStatus => ({
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

beforeEach(() => {
    reactHarness.stateValues = [];
    reactHarness.stateCursor = 0;
    reactHarness.effects = [];
    vi.clearAllMocks();
    hookMocks.statuses = [];
    hookMocks.fileIds = [];
    hookMocks.hasActiveJobs = false;
    hookMocks.pendingSaveCount = 0;
    hookMocks.user = { uid: 'user-1' };
    hookMocks.resetProcessing.mockResolvedValue('settled');
});

describe('discard confirmation wiring (V1/U2)', () => {
    it('asks before discarding when unsaved drafts exist and nothing is running', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.pendingSaveCount = 2;

        await click('新しい処理を開始する');

        const after = render();
        expect(after.text).toContain('破棄してよろしいですか');
        expect(after.text).toContain('保存待ちの文書 2 件が失われます');
        // 確認を出した時点では、まだ何も捨てていない
        expect(hookMocks.resetProcessing).not.toHaveBeenCalled();
    });

    it('discards straight away when nothing would be lost', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.pendingSaveCount = 0;

        await click('新しい処理を開始する');

        expect(render().text).not.toContain('破棄してよろしいですか');
        expect(hookMocks.resetProcessing).toHaveBeenCalledTimes(1);
    });
});

describe('force discard wiring (V2/U2/U6)', () => {
    it('opens the force-discard dialog when the jobs will not stop', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.hasActiveJobs = true;
        hookMocks.resetProcessing.mockResolvedValue('timeout');

        await click('新しい処理を開始する');
        await click('中止して破棄する');

        const after = render();
        expect(after.text).toContain('実行中の処理を停止できませんでした');
        expect(after.text).toContain('まだ動いています');
        expect(after.button('強制的に破棄する')).toBeDefined();
        // 止まっていないので進捗はまだ消さない
        expect(hookMocks.forceDiscardProcessing).not.toHaveBeenCalled();
    });

    it('stops claiming the jobs are still running once they settle (U6)', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.hasActiveJobs = true;
        hookMocks.resetProcessing.mockResolvedValue('timeout');

        await click('新しい処理を開始する');
        await click('中止して破棄する');

        // 待っている間にジョブが決着した
        hookMocks.hasActiveJobs = false;
        const after = render();

        expect(after.text).toContain('処理は停止しました');
        expect(after.text).not.toContain('まだ動いています');
        expect(after.button('破棄する')).toBeDefined();
    });

    it('releases the screen when the user chooses to force discard', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.hasActiveJobs = true;
        hookMocks.resetProcessing.mockResolvedValue('timeout');

        await click('新しい処理を開始する');
        await click('中止して破棄する');
        await click('強制的に破棄する');

        expect(hookMocks.forceDiscardProcessing).toHaveBeenCalledTimes(1);
        expect(render().text).not.toContain('停止できませんでした');
    });
});

describe('auth change wiring (U3)', () => {
    it('clears the previous user progress even when the jobs will not stop', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.resetProcessing.mockResolvedValue('timeout');

        const first = render();
        first.runEffects();
        await Promise.resolve();
        await Promise.resolve();

        // 主体が変わった以上、前の利用者の進捗を画面に残さない
        expect(hookMocks.forceDiscardProcessing).toHaveBeenCalledTimes(1);
        expect(hookMocks.clearFiles).toHaveBeenCalled();
    });

    it('does not force-discard when the jobs stopped in time', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.resetProcessing.mockResolvedValue('settled');

        const first = render();
        first.runEffects();
        await Promise.resolve();
        await Promise.resolve();

        expect(hookMocks.forceDiscardProcessing).not.toHaveBeenCalled();
        expect(hookMocks.clearFiles).toHaveBeenCalled();
    });
});

describe('file removal wiring (V3/U2)', () => {
    it('removes the progress row together with the file', async () => {
        hookMocks.fileIds = [];
        hookMocks.statuses = [createStatus('media-1')];

        // FileDropZone が発行したIDを親が受け取った状態を作る
        const tree = render();
        const dropZone = tree.elements.find(element =>
            typeof element.props.onFilesSelected === 'function'
        );
        expect(dropZone).toBeDefined();
        (dropZone!.props.onFilesSelected as (f: File[], ids: string[]) => void)(
            [{ name: 'media-1.mp4', type: 'video/mp4' } as File],
            ['media-1']
        );

        const withFile = render();
        const remover = withFile.elements.find(element =>
            typeof element.props.onRemoveFileById === 'function'
        );
        (remover!.props.onRemoveFileById as (fileId: string) => void)('media-1');

        expect(hookMocks.handleRemoveFile).toHaveBeenCalledWith(0);
        // 進捗行を残すと fileIds と位置がずれ、全ファイルの再開が拒否される
        expect(hookMocks.statuses).toEqual([]);
    });
});

describe('dialog carry-over across users (G1/G6)', () => {
    it('does not leave the force-discard dialog on the next user screen', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.hasActiveJobs = true;
        hookMocks.resetProcessing.mockResolvedValue('timeout');

        await click('新しい処理を開始する');
        await click('中止して破棄する');
        expect(render().text).toContain('停止できませんでした');

        // 別の利用者に切り替わる
        hookMocks.resetProcessing.mockResolvedValue('settled');
        const afterSwitch = await switchUser('user-2');

        expect(afterSwitch.text).not.toContain('停止できませんでした');
        expect(render().text).not.toContain('停止できませんでした');
    });

    it('does not leave the discard confirmation on the next user screen', async () => {
        hookMocks.statuses = [createStatus('f1')];
        hookMocks.pendingSaveCount = 1;

        await click('新しい処理を開始する');
        expect(render().text).toContain('破棄してよろしいですか');

        const afterSwitch = await switchUser('user-2');

        expect(afterSwitch.text).not.toContain('破棄してよろしいですか');
    });
});

describe('per-file removal gate (G3)', () => {
    const selectFile = (fileId: string) => {
        const dropZone = render().elements.find(element =>
            typeof element.props.onFilesSelected === 'function'
        );
        (dropZone!.props.onFilesSelected as (f: File[], ids: string[]) => void)(
            [{ name: `${fileId}.mp4`, type: 'video/mp4' } as File],
            [fileId]
        );
    };
    const removeById = (fileId: string) => {
        const remover = render().elements.find(element =>
            typeof element.props.onRemoveFileById === 'function'
        );
        (remover!.props.onRemoveFileById as (id: string) => void)(fileId);
    };

    it('asks before deleting a file that still holds an unsaved draft', () => {
        hookMocks.statuses = [{ ...createStatus('media-1'), savePendingPromptIds: ['prompt-a'] }];
        selectFile('media-1');

        removeById('media-1');

        const after = render();
        expect(after.text).toContain('保存されていない生成結果があります');
        expect(after.text).toContain('保存待ちの文書 1 件が失われます');
        // 確認を出した時点では、まだ消していない
        expect(hookMocks.handleRemoveFile).not.toHaveBeenCalled();
        expect(hookMocks.statuses).toHaveLength(1);
    });

    it('deletes immediately when the file has nothing unsaved', () => {
        hookMocks.statuses = [createStatus('media-1')];
        selectFile('media-1');

        removeById('media-1');

        expect(hookMocks.handleRemoveFile).toHaveBeenCalledWith(0);
        expect(hookMocks.statuses).toEqual([]);
        expect(render().text).not.toContain('保存されていない生成結果があります');
    });

    it('deletes once the user confirms', async () => {
        hookMocks.statuses = [{ ...createStatus('media-1'), savePendingPromptIds: ['prompt-a'] }];
        selectFile('media-1');
        removeById('media-1');

        await click('削除する');

        expect(hookMocks.handleRemoveFile).toHaveBeenCalledWith(0);
        expect(hookMocks.statuses).toEqual([]);
    });

    it('keeps the file when the user backs out', async () => {
        hookMocks.statuses = [{ ...createStatus('media-1'), savePendingPromptIds: ['prompt-a'] }];
        selectFile('media-1');
        removeById('media-1');

        await click('削除をやめる');

        expect(hookMocks.handleRemoveFile).not.toHaveBeenCalled();
        expect(hookMocks.statuses).toHaveLength(1);
        expect(render().text).not.toContain('保存されていない生成結果があります');
    });
});

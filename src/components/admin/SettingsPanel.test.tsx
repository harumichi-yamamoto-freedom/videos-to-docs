import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSettings, DefaultPromptTemplate } from '@/lib/adminSettings';

type StateEntry = [unknown, (value: unknown) => void];
type EffectCallback = () => void | (() => void);

const harness = vi.hoisted(() => ({
    effect: null as EffectCallback | null,
    stateIndex: 0,
    states: [] as StateEntry[],
    /** コンポーネントが各スロットへ渡した初期値の列。宣言順ずれの検出に使う。 */
    observedInitials: [] as unknown[],
}));

const mocks = vi.hoisted(() => ({
    getAdminSettings: vi.fn(),
    updateAdminSettings: vi.fn(),
    retryGuestDefaultPromptsSync: vi.fn(),
    getCurrentUserId: vi.fn(() => 'admin-1'),
    logAudit: vi.fn(),
    loggerError: vi.fn(),
}));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();

    return {
        ...actual,
        forwardRef: vi.fn((render: unknown) => render),
        useEffect: vi.fn((effect: EffectCallback) => {
            harness.effect = effect;
        }),
        useImperativeHandle: vi.fn(),
        /* positional な偽 useState。スロット表(arrangePanelState)は宣言順に
           完全依存するため、ずれたら黙って隣の値を返す前に大声で落とす:
           - 表より多く呼ばれたら即エラー（宣言の追加漏れ）
           - 各スロットへ渡された初期値を記録し、専用の順序カナリアで照合 */
        useState: vi.fn((initialValue: unknown) => {
            harness.observedInitials.push(initialValue);
            const entry = harness.states[harness.stateIndex];
            if (!entry) {
                throw new Error(
                    `fake useState のスロット ${harness.stateIndex} が未定義です。`
                    + ' SettingsPanel の useState 宣言と arrangePanelState の表を同じ順で更新してください。',
                );
            }
            harness.stateIndex += 1;
            return entry;
        }),
    };
});

vi.mock('@/lib/adminSettings', () => ({
    getAdminSettings: mocks.getAdminSettings,
    updateAdminSettings: mocks.updateAdminSettings,
    retryGuestDefaultPromptsSync: mocks.retryGuestDefaultPromptsSync,
}));

vi.mock('@/lib/auth', () => ({
    getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock('@/lib/auditLog', () => ({
    logAudit: mocks.logAudit,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({
        error: mocks.loggerError,
    }),
}));

vi.mock('@/constants/geminiModels', () => ({
    getGeminiModelLabel: (model?: string) => model ?? 'デフォルト',
}));

vi.mock('@/constants/geminiThinking', () => ({
    canonicalizeThinkingLevel: (level?: string) => level ?? 'default',
    THINKING_LEVELS: [
        { id: 'default', label: '自動' },
        { id: 'high', label: '高' },
    ],
}));

vi.mock('./DefaultPromptEditModal', () => ({
    default: () => null,
}));

import SettingsPanel from './SettingsPanel';

const settings: AdminSettings = {
    maxPromptSize: 50 * 1024,
    maxDocumentSize: 500 * 1024,
    rateLimit: {
        promptsPerHour: 100,
        documentsPerHour: 50,
    },
};

const prompts: DefaultPromptTemplate[] = [{
    name: '議事録',
    content: '議事録を作成してください。',
    model: 'gemini-3.7-flash',
    thinkingLevel: 'high',
}];

type PanelState = {
    settings?: AdminSettings | null;
    defaultPrompts?: DefaultPromptTemplate[];
    originalSettings?: AdminSettings | null;
    originalPrompts?: DefaultPromptTemplate[];
    loading?: boolean;
    saving?: boolean;
    loadError?: string | null;
    feedback?: { kind: 'success' | 'warning' | 'error'; message: string } | null;
    guestSyncFailed?: boolean;
    syncingGuestPrompts?: boolean;
    pendingDeletePromptIndex?: number | null;
};

function arrangePanelState(overrides: PanelState = {}) {
    const values = {
        settings: overrides.settings === undefined ? settings : overrides.settings,
        defaultPrompts: overrides.defaultPrompts ?? prompts,
        originalSettings: overrides.originalSettings === undefined
            ? settings
            : overrides.originalSettings,
        originalPrompts: overrides.originalPrompts ?? prompts,
        loading: overrides.loading ?? false,
        saving: overrides.saving ?? false,
        loadError: overrides.loadError ?? null,
        feedback: overrides.feedback ?? null,
        guestSyncFailed: overrides.guestSyncFailed ?? false,
        syncingGuestPrompts: overrides.syncingGuestPrompts ?? false,
    };
    const setters = {
        settings: vi.fn(),
        defaultPrompts: vi.fn(),
        originalSettings: vi.fn(),
        originalPrompts: vi.fn(),
        loading: vi.fn(),
        saving: vi.fn(),
        loadError: vi.fn(),
        feedback: vi.fn(),
        guestSyncFailed: vi.fn(),
        syncingGuestPrompts: vi.fn(),
        isModalOpen: vi.fn(),
        editingPromptIndex: vi.fn(),
        modalMode: vi.fn(),
        pendingDeletePromptIndex: vi.fn(),
    };

    harness.stateIndex = 0;
    harness.observedInitials = [];
    harness.states = [
        [values.settings, setters.settings],
        [values.defaultPrompts, setters.defaultPrompts],
        [values.originalSettings, setters.originalSettings],
        [values.originalPrompts, setters.originalPrompts],
        [values.loading, setters.loading],
        [values.saving, setters.saving],
        [values.loadError, setters.loadError],
        [values.feedback, setters.feedback],
        [values.guestSyncFailed, setters.guestSyncFailed],
        [values.syncingGuestPrompts, setters.syncingGuestPrompts],
        [false, setters.isModalOpen],
        [null, setters.editingPromptIndex],
        ['create', setters.modalMode],
        [overrides.pendingDeletePromptIndex ?? null, setters.pendingDeletePromptIndex],
    ];

    return setters;
}

function renderPanel(): React.ReactNode {
    const render = SettingsPanel as unknown as (
        props: object,
        ref: React.ForwardedRef<unknown>,
    ) => React.ReactNode;

    const tree = render({}, null);
    if (harness.stateIndex !== harness.states.length) {
        throw new Error(
            `useState の呼出し数 ${harness.stateIndex} がスロット表の ${harness.states.length} と不一致です。`
            + ' SettingsPanel の useState 宣言と arrangePanelState の表を同じ順で更新してください。',
        );
    }
    return tree;
}

function getText(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }

    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return '';
    }

    return React.Children.toArray(node.props.children).map(getText).join('');
}

function findButton(
    node: React.ReactNode,
    label: string,
): React.ReactElement<{ onClick: () => void | Promise<void>; disabled?: boolean }> | null {
    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return null;
    }

    if (node.type === 'button' && getText(node).includes(label)) {
        return node as React.ReactElement<{
            onClick: () => void | Promise<void>;
            disabled?: boolean;
        }>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const button = findButton(child, label);

        if (button) return button;
    }

    return null;
}

function findRowDeleteButton(
    node: React.ReactNode,
): React.ReactElement<{ onClick: (e: React.MouseEvent) => void; title?: string }> | null {
    if (!React.isValidElement<{ children?: React.ReactNode; title?: string }>(node)) {
        return null;
    }

    if (node.type === 'button' && node.props.title === '削除') {
        return node as React.ReactElement<{
            onClick: (e: React.MouseEvent) => void;
            title?: string;
        }>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const button = findRowDeleteButton(child);

        if (button) return button;
    }

    return null;
}

function countElements(node: React.ReactNode, type: string): number {
    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return 0;
    }

    return (node.type === type ? 1 : 0) + React.Children.toArray(node.props.children)
        .reduce<number>((count, child) => count + countElements(child, type), 0);
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

const nativeDialogs = vi.hoisted(() => ({
    confirm: vi.fn(() => true),
    alert: vi.fn(),
}));

describe('SettingsPanel', () => {
    beforeEach(() => {
        harness.effect = null;
        vi.clearAllMocks();
        mocks.getAdminSettings.mockReset();
        mocks.updateAdminSettings.mockReset();
        mocks.retryGuestDefaultPromptsSync.mockReset();
        mocks.logAudit.mockReset();
        mocks.logAudit.mockResolvedValue(undefined);
        nativeDialogs.confirm.mockClear();
        nativeDialogs.alert.mockClear();
        vi.stubGlobal('confirm', nativeDialogs.confirm);
        vi.stubGlobal('alert', nativeDialogs.alert);
    });

    afterEach(() => {
        // 確認も結果表示も画面内で完結する。ネイティブの confirm()/alert() へ
        // 退行したらどのテストでもここで落ちる。
        expect(nativeDialogs.confirm).not.toHaveBeenCalled();
        expect(nativeDialogs.alert).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('取得失敗時は編集UIを出さず画面内の再試行導線を表示する', async () => {
        const alertMock = vi.fn();
        vi.stubGlobal('alert', alertMock);
        const loadSetters = arrangePanelState({ loading: true });
        mocks.getAdminSettings
            .mockRejectedValueOnce(new Error('permission-denied'))
            .mockResolvedValueOnce({
                ...settings,
                defaultPrompts: prompts,
            });

        renderPanel();
        expect(harness.effect).not.toBeNull();
        harness.effect?.();
        await flushPromises();

        expect(loadSetters.settings).toHaveBeenCalledWith(null);
        expect(loadSetters.originalSettings).toHaveBeenCalledWith(null);
        expect(loadSetters.defaultPrompts).toHaveBeenCalledWith([]);
        expect(loadSetters.originalPrompts).toHaveBeenCalledWith([]);
        expect(loadSetters.loadError).toHaveBeenNthCalledWith(1, null);
        expect(loadSetters.loadError).toHaveBeenLastCalledWith(
            '設定を読み込めませんでした。編集を開始するには再試行してください。',
        );
        expect(loadSetters.loading).toHaveBeenNthCalledWith(1, true);
        expect(loadSetters.loading).toHaveBeenLastCalledWith(false);
        expect(alertMock).not.toHaveBeenCalled();

        const retrySetters = arrangePanelState({
            settings: null,
            originalSettings: null,
            loadError: '設定を読み込めませんでした。編集を開始するには再試行してください。',
        });

        const tree = renderPanel();
        const retryButton = findButton(tree, '読み込みを再試行');

        expect(getText(tree)).toContain('設定を読み込めませんでした。');
        expect(countElements(tree, 'input')).toBe(0);
        expect(retryButton).not.toBeNull();

        await retryButton?.props.onClick();

        expect(mocks.getAdminSettings).toHaveBeenCalledTimes(2);
        expect(retrySetters.settings).toHaveBeenLastCalledWith({
            ...settings,
            defaultPrompts: prompts,
        });
        expect(retrySetters.loading).toHaveBeenNthCalledWith(1, true);
        expect(retrySetters.loading).toHaveBeenLastCalledWith(false);
    });

    it('再読み込み後も未解消のゲスト同期失敗警告と再同期導線を復元する', async () => {
        const failedSettings: AdminSettings = {
            ...settings,
            defaultPrompts: prompts,
            lastGuestSyncStatus: 'failed',
        };
        const loadSetters = arrangePanelState({ loading: true });
        mocks.getAdminSettings.mockResolvedValueOnce(failedSettings);

        renderPanel();
        harness.effect?.();
        await flushPromises();

        expect(loadSetters.settings).toHaveBeenCalledWith(failedSettings);
        expect(loadSetters.guestSyncFailed).toHaveBeenNthCalledWith(1, false);
        expect(loadSetters.guestSyncFailed).toHaveBeenLastCalledWith(true);
        expect(loadSetters.feedback).toHaveBeenLastCalledWith({
            kind: 'warning',
            message: '前回のゲスト用共通プロンプトの同期が失敗しています。',
        });

        arrangePanelState({
            settings: failedSettings,
            originalSettings: failedSettings,
            feedback: {
                kind: 'warning',
                message: '前回のゲスト用共通プロンプトの同期が失敗しています。',
            },
            guestSyncFailed: true,
        });

        const restoredTree = renderPanel();

        expect(getText(restoredTree)).toContain(
            '前回のゲスト用共通プロンプトの同期が失敗しています。',
        );
        expect(findButton(restoredTree, '同期を再試行')).not.toBeNull();
    });

    it('完了statusを書けなかったpending状態も再読み込み後に未解消として復元する', async () => {
        const pendingSettings: AdminSettings = {
            ...settings,
            defaultPrompts: prompts,
            lastGuestSyncStatus: 'pending',
        };
        const loadSetters = arrangePanelState({ loading: true });
        mocks.getAdminSettings.mockResolvedValueOnce(pendingSettings);

        renderPanel();
        harness.effect?.();
        await flushPromises();

        expect(loadSetters.guestSyncFailed).toHaveBeenLastCalledWith(true);
        expect(loadSetters.feedback).toHaveBeenLastCalledWith({
            kind: 'warning',
            message: 'ゲスト用共通プロンプトの同期が完了していません。',
        });

        arrangePanelState({
            settings: pendingSettings,
            originalSettings: pendingSettings,
            feedback: {
                kind: 'warning',
                message: 'ゲスト用共通プロンプトの同期が完了していません。',
            },
            guestSyncFailed: true,
        });

        expect(findButton(renderPanel(), '同期を再試行')).not.toBeNull();
    });

    it('設定とプロンプトを一回の更新呼出しへ統合し同期失敗を警告する', async () => {
        const changedSettings = {
            ...settings,
            maxPromptSize: 60 * 1024,
        };
        const setters = arrangePanelState({
            settings: changedSettings,
            originalSettings: settings,
        });
        mocks.updateAdminSettings.mockResolvedValueOnce({
            settingsUpdated: true,
            guestPromptsSync: 'failed',
        });

        const saveButton = findButton(renderPanel(), '設定を保存');
        expect(saveButton?.props.disabled).toBe(false);

        await saveButton?.props.onClick();

        expect(mocks.updateAdminSettings).toHaveBeenCalledTimes(1);
        expect(mocks.updateAdminSettings).toHaveBeenCalledWith({
            ...changedSettings,
            defaultPrompts: prompts,
        }, 'admin-1');
        expect(setters.originalSettings).toHaveBeenCalledWith({
            ...changedSettings,
            defaultPrompts: prompts,
        });
        expect(setters.guestSyncFailed).toHaveBeenCalledWith(true);
        expect(setters.feedback).toHaveBeenCalledWith({
            kind: 'warning',
            message: '設定は保存しましたが、ゲスト用共通プロンプトを同期できませんでした。',
        });
    });

    it('設定保存後の監査失敗を保存失敗と誤表示しない', async () => {
        const changedSettings = {
            ...settings,
            maxDocumentSize: 600 * 1024,
        };
        const setters = arrangePanelState({
            settings: changedSettings,
            originalSettings: settings,
        });
        mocks.updateAdminSettings.mockResolvedValueOnce({
            settingsUpdated: true,
            guestPromptsSync: 'succeeded',
        });
        mocks.logAudit.mockRejectedValueOnce(new Error('audit failed'));

        await findButton(renderPanel(), '設定を保存')?.props.onClick();

        expect(setters.originalSettings).toHaveBeenCalledWith({
            ...changedSettings,
            defaultPrompts: prompts,
        });
        expect(setters.feedback).toHaveBeenLastCalledWith({
            kind: 'warning',
            message: '設定は保存しましたが、監査ログを記録できませんでした。',
        });
        expect(setters.feedback).not.toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('設定を保存できませんでした'),
        }));
    });

    it('ゲスト同期失敗の警告から再同期できる', async () => {
        const setters = arrangePanelState({
            feedback: {
                kind: 'warning',
                message: '設定は保存しましたが、ゲスト用共通プロンプトを同期できませんでした。',
            },
            guestSyncFailed: true,
        });
        mocks.retryGuestDefaultPromptsSync.mockResolvedValueOnce(undefined);

        const retryButton = findButton(renderPanel(), '同期を再試行');
        expect(retryButton).not.toBeNull();

        await retryButton?.props.onClick();

        expect(mocks.retryGuestDefaultPromptsSync).toHaveBeenCalledWith('admin-1');
        expect(setters.guestSyncFailed).toHaveBeenCalledWith(false);
        expect(setters.feedback).toHaveBeenLastCalledWith({
            kind: 'success',
            message: 'ゲスト用共通プロンプトを同期しました。',
        });
    });

    it('再同期失敗時は警告を未解消のまま保持する', async () => {
        const setters = arrangePanelState({
            feedback: {
                kind: 'warning',
                message: '前回のゲスト用共通プロンプトの同期が失敗しています。',
            },
            guestSyncFailed: true,
        });
        mocks.retryGuestDefaultPromptsSync.mockRejectedValueOnce(new Error('sync failed'));

        await findButton(renderPanel(), '同期を再試行')?.props.onClick();

        expect(setters.guestSyncFailed).toHaveBeenCalledWith(true);
        expect(setters.feedback).toHaveBeenLastCalledWith({
            kind: 'error',
            message: 'ゲスト用共通プロンプトを同期できませんでした。再試行してください。',
        });
    });

    it('スロット表はコンポーネントのuseState宣言順と同期している（順序カナリア）', () => {
        arrangePanelState();
        renderPanel();

        // コンポーネントが各スロットへ渡した初期値の列。宣言の並べ替え・増減は
        // ここで大声で落ち、arrangePanelState の表を同じ順で直すよう促す。
        expect(harness.observedInitials).toEqual([
            null,      // settings
            [],        // defaultPrompts
            null,      // originalSettings
            [],        // originalPrompts
            true,      // loading
            false,     // saving
            null,      // loadError
            null,      // feedback
            false,     // guestSyncFailed
            false,     // syncingGuestPrompts
            false,     // isModalOpen
            null,      // editingPromptIndex
            'create',  // modalMode
            null,      // pendingDeletePromptIndex
        ]);
    });

    it('行の削除ボタンは直接消さず、対象行の確認ダイアログを開く', () => {
        const setters = arrangePanelState();
        const tree = renderPanel();
        const deleteButton = findRowDeleteButton(tree);
        expect(deleteButton).not.toBeNull();
        // 確認前はダイアログを描画しない。
        expect(getText(tree)).not.toContain('を削除しますか？');

        const stopPropagation = vi.fn();
        deleteButton?.props.onClick({ stopPropagation } as unknown as React.MouseEvent);

        expect(stopPropagation).toHaveBeenCalled();
        expect(setters.pendingDeletePromptIndex).toHaveBeenCalledWith(0);
        expect(setters.defaultPrompts).not.toHaveBeenCalled();
    });

    it('削除確認は対象名を含み、承諾でその行だけを一覧から除く', () => {
        const setters = arrangePanelState({ pendingDeletePromptIndex: 0 });
        const tree = renderPanel();

        expect(getText(tree)).toContain('「議事録」を削除しますか？');
        expect(getText(tree)).toContain('「設定を保存」を押すまでは確定されません。');

        findButton(tree, '削除する')?.props.onClick();

        expect(setters.defaultPrompts).toHaveBeenCalledWith([]);
        expect(setters.pendingDeletePromptIndex).toHaveBeenCalledWith(null);
    });

    it('削除確認をキャンセルすると一覧は変わらない', () => {
        const setters = arrangePanelState({ pendingDeletePromptIndex: 0 });
        const tree = renderPanel();

        findButton(tree, 'キャンセル')?.props.onClick();

        expect(setters.defaultPrompts).not.toHaveBeenCalled();
        expect(setters.pendingDeletePromptIndex).toHaveBeenCalledWith(null);
    });
});

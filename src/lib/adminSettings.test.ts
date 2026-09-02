import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const database = { name: 'mock-firestore' };
    const documentReference = { id: 'config' };
    const timestamp = { type: 'server-timestamp' };
    const persistedData: Record<string, unknown> = {};
    const transactionGet = vi.fn();
    const transactionSet = vi.fn();
    const runTransaction = vi.fn((
        _database: unknown,
        updateFunction: (transaction: {
            get: typeof transactionGet;
            set: typeof transactionSet;
        }) => Promise<unknown>,
    ) => updateFunction({ get: transactionGet, set: transactionSet }));

    return {
        database,
        documentReference,
        persistedData,
        timestamp,
        doc: vi.fn(() => documentReference),
        getDoc: vi.fn(),
        runTransaction,
        setDoc: vi.fn(),
        serverTimestamp: vi.fn(() => timestamp),
        syncGuestDefaultPrompts: vi.fn(),
        transactionGet,
        transactionSet,
        loggerError: vi.fn(),
    };
});

vi.mock('firebase/firestore', () => ({
    doc: mocks.doc,
    getDoc: mocks.getDoc,
    runTransaction: mocks.runTransaction,
    setDoc: mocks.setDoc,
    serverTimestamp: mocks.serverTimestamp,
}));

vi.mock('./firebase', () => ({
    db: mocks.database,
}));

vi.mock('./prompts', () => ({
    syncGuestDefaultPrompts: mocks.syncGuestDefaultPrompts,
}));

vi.mock('./logger', () => ({
    createLogger: () => ({
        error: mocks.loggerError,
        info: vi.fn(),
    }),
}));

import {
    getAdminSettings,
    getDefaultPrompts,
    INITIAL_DEFAULT_PROMPTS,
    retryGuestDefaultPromptsSync,
    updateAdminSettings,
    updateDefaultPrompts,
    validateDocumentSize,
    validatePromptSize,
} from './adminSettings';

describe('adminSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDoc.mockReset();
        for (const key of Object.keys(mocks.persistedData)) delete mocks.persistedData[key];
        mocks.setDoc.mockReset().mockImplementation(async (
            _reference: unknown,
            data: Record<string, unknown>,
        ) => {
            Object.assign(mocks.persistedData, data);
        });
        mocks.syncGuestDefaultPrompts.mockReset().mockResolvedValue(undefined);
        mocks.transactionGet.mockReset().mockImplementation(async () => {
            return {
                exists: () => true,
                data: () => ({ ...mocks.persistedData }),
            };
        });
        mocks.transactionSet.mockReset().mockImplementation((
            _reference: unknown,
            data: Record<string, unknown>,
        ) => {
            Object.assign(mocks.persistedData, data);
        });
    });

    it('管理画面用の設定取得失敗は既定値で隠さずエラーを伝播する', async () => {
        mocks.getDoc.mockRejectedValue(new Error('permission-denied'));

        await expect(getAdminSettings()).rejects.toThrow('管理者設定の取得に失敗しました');

        expect(mocks.setDoc).not.toHaveBeenCalled();
    });

    it.each([
        {
            scenario: 'configが未作成',
            arrangeRead: () => mocks.getDoc.mockResolvedValue({
                exists: () => false,
            }),
        },
        {
            scenario: '未認証・一般ユーザー相当で読み取りできない',
            arrangeRead: () => mocks.getDoc.mockRejectedValue(new Error('permission-denied')),
        },
    ])('$scenarioでも一般実行APIは既定値で成功し書き込みを行わない', async ({ arrangeRead }) => {
        arrangeRead();

        await expect(validatePromptSize('prompt')).resolves.toEqual({
            valid: true,
            size: 6,
            maxSize: 50000,
        });
        await expect(validateDocumentSize('document')).resolves.toEqual({
            valid: true,
            size: 8,
            maxSize: 500000,
        });
        await expect(getDefaultPrompts()).resolves.toEqual(INITIAL_DEFAULT_PROMPTS);

        expect(mocks.getDoc).toHaveBeenCalledTimes(3);
        expect(mocks.setDoc).not.toHaveBeenCalled();
    });

    it('管理画面用の取得だけが未作成configを初期化する', async () => {
        mocks.getDoc.mockResolvedValue({
            exists: () => false,
        });

        const result = await getAdminSettings();

        expect(result).toEqual(expect.objectContaining({
            maxPromptSize: 50000,
            maxDocumentSize: 500000,
            defaultPrompts: INITIAL_DEFAULT_PROMPTS,
        }));
        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        expect(mocks.setDoc).toHaveBeenCalledWith(
            mocks.documentReference,
            expect.objectContaining({
                maxPromptSize: 50000,
                maxDocumentSize: 500000,
                defaultPrompts: INITIAL_DEFAULT_PROMPTS,
                updatedAt: mocks.timestamp,
            }),
        );
    });

    it('管理画面用の取得は既存configの未作成defaultPromptsだけを移行する', async () => {
        mocks.getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({
                maxPromptSize: 1234,
                maxDocumentSize: 5678,
                rateLimit: {
                    promptsPerHour: 10,
                    documentsPerHour: 5,
                },
                lastGuestSyncStatus: 'failed',
            }),
        });

        const result = await getAdminSettings();

        expect(result).toEqual(expect.objectContaining({
            maxPromptSize: 1234,
            maxDocumentSize: 5678,
            defaultPrompts: INITIAL_DEFAULT_PROMPTS,
            lastGuestSyncStatus: 'failed',
        }));
        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        expect(mocks.setDoc).toHaveBeenCalledWith(
            mocks.documentReference,
            {
                defaultPrompts: INITIAL_DEFAULT_PROMPTS,
                updatedAt: mocks.timestamp,
            },
            { merge: true },
        );
    });

    it('設定とデフォルトプロンプトを保存し同期成功状態も同じdocumentへ記録する', async () => {
        const result = await updateAdminSettings({
            maxPromptSize: 1024,
            maxDocumentSize: 2048,
            rateLimit: {
                promptsPerHour: 10,
                documentsPerHour: 5,
            },
            defaultPrompts: [{
                name: '要約',
                content: '要約してください。',
                model: 'gemini-3.7-flash',
                thinkingLevel: 'high',
            }],
        }, 'admin-1');

        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        expect(mocks.setDoc).toHaveBeenCalledWith(
            mocks.documentReference,
            expect.objectContaining({
                maxPromptSize: 1024,
                maxDocumentSize: 2048,
                defaultPrompts: [{
                    name: '要約',
                    content: '要約してください。',
                    model: 'gemini-3.7-flash',
                    thinkingLevel: 'high',
                }],
                lastGuestSyncStatus: 'pending',
                lastGuestSyncAt: mocks.timestamp,
                lastGuestSyncBy: 'admin-1',
                lastGuestSyncOperationId: expect.any(String),
                updatedAt: mocks.timestamp,
                updatedBy: 'admin-1',
            }),
            { merge: true },
        );
        const operationId = (
            mocks.setDoc.mock.calls[0][1] as { lastGuestSyncOperationId: string }
        ).lastGuestSyncOperationId;
        expect(mocks.transactionSet).toHaveBeenCalledWith(
            mocks.documentReference,
            {
                lastGuestSyncStatus: 'succeeded',
                lastGuestSyncAt: mocks.timestamp,
                lastGuestSyncBy: 'admin-1',
                lastGuestSyncOperationId: operationId,
            },
            { merge: true },
        );
        expect(mocks.syncGuestDefaultPrompts).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            settingsUpdated: true,
            guestPromptsSync: 'succeeded',
        });
    });

    it('設定保存直後のreadが失敗しても同期には保存したprompt snapshotだけを渡す', async () => {
        const savedPrompts = [{
            name: '保存した要約',
            content: '保存した内容で要約してください。',
            model: 'gemini-3.7-flash',
            thinkingLevel: 'high' as const,
        }];
        let promptsObservedBySync: unknown;
        mocks.getDoc.mockRejectedValue(new Error('transient read failure'));
        mocks.syncGuestDefaultPrompts.mockImplementationOnce(async () => {
            promptsObservedBySync = await getDefaultPrompts();
        });

        await expect(updateAdminSettings({ defaultPrompts: savedPrompts }, 'admin-1'))
            .resolves.toEqual({
                settingsUpdated: true,
                guestPromptsSync: 'succeeded',
            });

        expect(promptsObservedBySync).toEqual(savedPrompts);
        // 1 回だけの read は保存前の同期要否判定 (失敗→安全側で同期)。同期用snapshotは
        // 直接受け渡すため、同期自体は fail-open の runtime read へ到達しない。
        expect(mocks.getDoc).toHaveBeenCalledTimes(1);
    });

    it('再同期はpending化前の管理者readで確定したprompt snapshotを使用する', async () => {
        const savedPrompts = [{
            name: '再同期する議事録',
            content: '保存済みの内容で議事録を作成してください。',
            model: 'gemini-3.7-flash',
            thinkingLevel: 'high' as const,
        }];
        let promptsObservedBySync: unknown;
        Object.assign(mocks.persistedData, {
            maxPromptSize: 1024,
            maxDocumentSize: 2048,
            rateLimit: { promptsPerHour: 10, documentsPerHour: 5 },
            defaultPrompts: savedPrompts,
            lastGuestSyncStatus: 'failed',
        });
        mocks.syncGuestDefaultPrompts.mockImplementationOnce(async () => {
            promptsObservedBySync = await getDefaultPrompts();
        });

        await expect(retryGuestDefaultPromptsSync('admin-1')).resolves.toBeUndefined();

        expect(promptsObservedBySync).toEqual(savedPrompts);
        expect(mocks.getDoc).not.toHaveBeenCalled();
        expect(mocks.transactionSet).toHaveBeenNthCalledWith(
            1,
            mocks.documentReference,
            expect.objectContaining({
                lastGuestSyncStatus: 'pending',
                lastGuestSyncOperationId: expect.any(String),
            }),
            { merge: true },
        );
    });

    it('再同期開始transactionが競合で再実行された場合は最新config snapshotを同期する', async () => {
        const stalePrompts = [{ name: '旧設定', content: '旧内容' }];
        const latestPrompts = [{ name: '新設定', content: '新内容' }];
        let promptsObservedBySync: unknown;
        const abandonedTransactionSet = vi.fn();
        mocks.syncGuestDefaultPrompts.mockImplementationOnce(async () => {
            promptsObservedBySync = await getDefaultPrompts();
        });
        mocks.runTransaction.mockImplementationOnce(async (_database, updateFunction) => {
            mocks.transactionGet.mockResolvedValueOnce({
                exists: () => true,
                data: () => ({
                    defaultPrompts: stalePrompts,
                    lastGuestSyncStatus: 'failed',
                }),
            });
            await updateFunction({
                get: mocks.transactionGet,
                set: abandonedTransactionSet as typeof mocks.transactionSet,
            });

            Object.assign(mocks.persistedData, {
                defaultPrompts: latestPrompts,
                lastGuestSyncStatus: 'succeeded',
                lastGuestSyncOperationId: 'competing-operation',
            });
            mocks.transactionGet.mockResolvedValueOnce({
                exists: () => true,
                data: () => ({ ...mocks.persistedData }),
            });
            return updateFunction({
                get: mocks.transactionGet,
                set: mocks.transactionSet,
            });
        });

        await expect(retryGuestDefaultPromptsSync('admin-retry')).resolves.toBeUndefined();

        expect(abandonedTransactionSet).toHaveBeenCalledOnce();
        expect(promptsObservedBySync).toEqual(expect.arrayContaining([
            expect.objectContaining(latestPrompts[0]),
        ]));
        expect(promptsObservedBySync).not.toEqual(expect.arrayContaining([
            expect.objectContaining(stalePrompts[0]),
        ]));
    });

    it('古い同期完了は新しいfailed状態を上書きしない', async () => {
        mocks.transactionGet.mockResolvedValueOnce({
            exists: () => true,
            data: () => ({
                lastGuestSyncStatus: 'failed',
                lastGuestSyncOperationId: 'newer-operation',
            }),
        });

        await expect(updateAdminSettings({
            defaultPrompts: [{ name: '古い設定', content: '古い内容' }],
        }, 'admin-old')).resolves.toEqual({
            settingsUpdated: true,
            guestPromptsSync: 'failed',
        });

        expect(mocks.transactionSet).not.toHaveBeenCalled();
    });

    it.each(['pending', 'succeeded'] as const)(
        '新しい操作が%sの間に古い同期が完了した場合は再確認が必要なfailedへ戻す',
        async newerStatus => {
            mocks.transactionGet.mockResolvedValueOnce({
                exists: () => true,
                data: () => ({
                    lastGuestSyncStatus: newerStatus,
                    lastGuestSyncOperationId: 'newer-operation',
                }),
            });

            await expect(updateAdminSettings({
                defaultPrompts: [{ name: '古い設定', content: '古い内容' }],
            }, 'admin-old')).resolves.toEqual({
                settingsUpdated: true,
                guestPromptsSync: 'failed',
            });

            expect(mocks.transactionSet).toHaveBeenCalledWith(
                mocks.documentReference,
                {
                    lastGuestSyncStatus: 'failed',
                    lastGuestSyncAt: mocks.timestamp,
                },
                { merge: true },
            );
        },
    );

    it('設定保存後のゲスト同期失敗を部分失敗として返し再試行できる', async () => {
        mocks.syncGuestDefaultPrompts
            .mockRejectedValueOnce(new Error('sync failed'))
            .mockResolvedValueOnce(undefined);

        const result = await updateAdminSettings({
            defaultPrompts: [{ name: '議事録', content: '議事録を作成してください。' }],
        }, 'admin-1');

        expect(result).toEqual({
            settingsUpdated: true,
            guestPromptsSync: 'failed',
        });
        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        const firstOperationId = (
            mocks.setDoc.mock.calls[0][1] as { lastGuestSyncOperationId: string }
        ).lastGuestSyncOperationId;
        expect(mocks.transactionSet).toHaveBeenLastCalledWith(
            mocks.documentReference,
            {
                lastGuestSyncStatus: 'failed',
                lastGuestSyncAt: mocks.timestamp,
                lastGuestSyncBy: 'admin-1',
                lastGuestSyncOperationId: firstOperationId,
            },
            { merge: true },
        );

        await expect(retryGuestDefaultPromptsSync('admin-1')).resolves.toBeUndefined();
        expect(mocks.syncGuestDefaultPrompts).toHaveBeenCalledTimes(2);
        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        expect(mocks.transactionSet).toHaveBeenCalledTimes(3);
        const retryOperationId = (
            mocks.transactionSet.mock.calls[1][1] as { lastGuestSyncOperationId: string }
        ).lastGuestSyncOperationId;
        expect(mocks.transactionSet).toHaveBeenLastCalledWith(
            mocks.documentReference,
            {
                lastGuestSyncStatus: 'succeeded',
                lastGuestSyncAt: mocks.timestamp,
                lastGuestSyncBy: 'admin-1',
                lastGuestSyncOperationId: retryOperationId,
            },
            { merge: true },
        );
    });

    it('再同期失敗も未解消状態として記録してエラーを伝播する', async () => {
        mocks.syncGuestDefaultPrompts.mockRejectedValueOnce(new Error('sync failed'));
        Object.assign(mocks.persistedData, {
            maxPromptSize: 1024,
            maxDocumentSize: 2048,
            rateLimit: { promptsPerHour: 10, documentsPerHour: 5 },
            defaultPrompts: [{ name: '議事録', content: '議事録を作成してください。' }],
            lastGuestSyncStatus: 'failed',
        });

        await expect(retryGuestDefaultPromptsSync('admin-2'))
            .rejects.toThrow('ゲストデフォルトプロンプトの同期に失敗しました');

        expect(mocks.setDoc).not.toHaveBeenCalled();
        expect(mocks.transactionSet).toHaveBeenNthCalledWith(
            1,
            mocks.documentReference,
            expect.objectContaining({
                lastGuestSyncStatus: 'pending',
                lastGuestSyncAt: mocks.timestamp,
                lastGuestSyncBy: 'admin-2',
                lastGuestSyncOperationId: expect.any(String),
            }),
            { merge: true },
        );
        const operationId = (
            mocks.transactionSet.mock.calls[0][1] as { lastGuestSyncOperationId: string }
        ).lastGuestSyncOperationId;
        expect(mocks.transactionSet).toHaveBeenNthCalledWith(
            2,
            mocks.documentReference,
            {
                lastGuestSyncStatus: 'failed',
                lastGuestSyncAt: mocks.timestamp,
                lastGuestSyncBy: 'admin-2',
                lastGuestSyncOperationId: operationId,
            },
            { merge: true },
        );
    });

    it('互換更新APIは本体保存後のゲスト同期失敗を部分成功として返す', async () => {
        mocks.syncGuestDefaultPrompts.mockRejectedValueOnce(new Error('sync failed'));

        await expect(updateDefaultPrompts([
            { name: '議事録', content: '議事録を作成してください。' },
        ], 'admin-1')).resolves.toEqual({
            settingsUpdated: true,
            guestPromptsSync: 'failed',
        });

        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        expect(mocks.transactionSet).toHaveBeenCalledOnce();
    });

    it('同期成功状態の記録失敗は設定保存成功を保ちつつ未解消として返す', async () => {
        mocks.runTransaction.mockRejectedValueOnce(new Error('status write failed'));

        await expect(updateAdminSettings({
            defaultPrompts: [{ name: '議事録', content: '議事録を作成してください。' }],
        }, 'admin-1')).resolves.toEqual({
            settingsUpdated: true,
            guestPromptsSync: 'failed',
        });

        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        expect(mocks.setDoc).toHaveBeenCalledWith(
            mocks.documentReference,
            expect.objectContaining({
                lastGuestSyncStatus: 'pending',
                lastGuestSyncOperationId: expect.any(String),
            }),
            { merge: true },
        );
        expect(mocks.syncGuestDefaultPrompts).toHaveBeenCalledTimes(1);
        expect(mocks.transactionSet).not.toHaveBeenCalled();
    });

    it('互換更新APIは本体保存失敗のみ更新失敗として拒否する', async () => {
        mocks.setDoc.mockRejectedValueOnce(new Error('write failed'));

        await expect(updateDefaultPrompts([
            { name: '議事録', content: '議事録を作成してください。' },
        ], 'admin-1')).rejects.toThrow('デフォルトプロンプトの更新に失敗しました');

        expect(mocks.syncGuestDefaultPrompts).not.toHaveBeenCalled();
    });

    it('設定documentの保存失敗時はゲスト同期を開始しない', async () => {
        mocks.setDoc.mockRejectedValueOnce(new Error('write failed'));

        await expect(updateAdminSettings({
            defaultPrompts: [{ name: '議事録', content: '議事録を作成してください。' }],
        }, 'admin-1')).rejects.toThrow('管理者設定の更新に失敗しました');

        expect(mocks.syncGuestDefaultPrompts).not.toHaveBeenCalled();
    });
});

describe('adminSettings ゲスト同期の要否 (S2-5)', () => {
    const storedPrompts = [
        { name: '打ち合わせの流れ', content: '流れ', model: 'default', thinkingLevel: 'default' as const },
        { name: '希望条件', content: '希望条件を整理', model: 'gemini-3.7-flash', thinkingLevel: 'high' as const },
    ];

    function arrangeStoredConfig(overrides: Record<string, unknown> = {}) {
        mocks.getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({
                maxPromptSize: 50000,
                maxDocumentSize: 500000,
                defaultPrompts: storedPrompts,
                lastGuestSyncStatus: 'succeeded',
                ...overrides,
            }),
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDoc.mockReset();
        for (const key of Object.keys(mocks.persistedData)) delete mocks.persistedData[key];
        // 同期完了 status の finalize transaction が setDoc で書いた operationId を読めるよう、
        // 上の describe と同じく保存内容を persistedData へ通す
        mocks.setDoc.mockReset().mockImplementation(async (
            _reference: unknown,
            data: Record<string, unknown>,
        ) => {
            Object.assign(mocks.persistedData, data);
        });
        mocks.syncGuestDefaultPrompts.mockReset().mockResolvedValue(undefined);
        mocks.transactionGet.mockReset().mockImplementation(async () => ({
            exists: () => true,
            data: () => ({ ...mocks.persistedData }),
        }));
        mocks.transactionSet.mockReset().mockImplementation((
            _reference: unknown,
            data: Record<string, unknown>,
        ) => {
            Object.assign(mocks.persistedData, data);
        });
    });

    it('保存前と同じdefaultPromptsの保存ではゲスト同期を要求しない', async () => {
        arrangeStoredConfig();

        const result = await updateAdminSettings({
            maxPromptSize: 60000,
            defaultPrompts: storedPrompts.map(prompt => ({ ...prompt })),
        }, 'admin-1');

        expect(result).toEqual({ settingsUpdated: true, guestPromptsSync: 'not-requested' });
        expect(mocks.syncGuestDefaultPrompts).not.toHaveBeenCalled();
        expect(mocks.setDoc).toHaveBeenCalledTimes(1);
        const savedData = mocks.setDoc.mock.calls[0][1] as Record<string, unknown>;
        expect(savedData).toEqual(expect.objectContaining({
            maxPromptSize: 60000,
            defaultPrompts: storedPrompts,
            updatedBy: 'admin-1',
        }));
        expect(savedData).not.toHaveProperty('lastGuestSyncStatus');
        expect(savedData).not.toHaveProperty('lastGuestSyncOperationId');
        expect(mocks.transactionSet).not.toHaveBeenCalled();
    });

    it('model/thinkingLevel の未設定と既定値の違いだけなら同じとみなす', async () => {
        arrangeStoredConfig({
            defaultPrompts: [
                { name: '打ち合わせの流れ', content: '流れ' },
                { name: '希望条件', content: '希望条件を整理', model: 'gemini-3.7-flash', thinkingLevel: ' high ' },
            ],
        });

        const result = await updateAdminSettings({ defaultPrompts: storedPrompts }, 'admin-1');

        expect(result.guestPromptsSync).toBe('not-requested');
        expect(mocks.syncGuestDefaultPrompts).not.toHaveBeenCalled();
    });

    it.each([
        {
            change: '内容',
            next: [{ ...storedPrompts[0], content: '新しい流れ' }, storedPrompts[1]],
        },
        {
            change: '名前',
            next: [{ ...storedPrompts[0], name: '商談の流れ' }, storedPrompts[1]],
        },
        {
            change: 'モデル',
            next: [{ ...storedPrompts[0], model: 'gemini-3.7-pro' }, storedPrompts[1]],
        },
        {
            change: '思考レベル',
            next: [{ ...storedPrompts[0], thinkingLevel: 'low' as const }, storedPrompts[1]],
        },
        {
            change: '件数',
            next: [storedPrompts[0]],
        },
    ])('defaultPromptsの$changeが変わった保存では同期する', async ({ next }) => {
        arrangeStoredConfig();

        const result = await updateAdminSettings({ defaultPrompts: next }, 'admin-1');

        expect(result.guestPromptsSync).toBe('succeeded');
        expect(mocks.syncGuestDefaultPrompts).toHaveBeenCalledTimes(1);
        expect(mocks.setDoc.mock.calls[0][1]).toEqual(expect.objectContaining({
            lastGuestSyncStatus: 'pending',
        }));
    });

    it.each(['failed', 'pending'] as const)(
        '前回のゲスト同期が%sのままなら同じdefaultPromptsでも同期する',
        async unresolvedStatus => {
            arrangeStoredConfig({ lastGuestSyncStatus: unresolvedStatus });

            const result = await updateAdminSettings({ defaultPrompts: storedPrompts }, 'admin-1');

            expect(result.guestPromptsSync).toBe('succeeded');
            expect(mocks.syncGuestDefaultPrompts).toHaveBeenCalledTimes(1);
        },
    );

    it.each([
        {
            scenario: 'configが未作成',
            arrangeRead: () => mocks.getDoc.mockResolvedValue({ exists: () => false }),
        },
        {
            scenario: 'defaultPromptsが未保存',
            arrangeRead: () => arrangeStoredConfig({ defaultPrompts: undefined }),
        },
        {
            scenario: '保存前の読み取りに失敗',
            arrangeRead: () => mocks.getDoc.mockRejectedValue(new Error('unavailable')),
        },
    ])('$scenarioなら比較できないので安全側で同期する', async ({ arrangeRead }) => {
        arrangeRead();

        const result = await updateAdminSettings({ defaultPrompts: storedPrompts }, 'admin-1');

        expect(result.guestPromptsSync).toBe('succeeded');
        expect(mocks.syncGuestDefaultPrompts).toHaveBeenCalledTimes(1);
    });

    it('defaultPromptsを含まない保存は保存前の読み取りも同期もしない', async () => {
        const result = await updateAdminSettings({ maxPromptSize: 60000 }, 'admin-1');

        expect(result.guestPromptsSync).toBe('not-requested');
        expect(mocks.getDoc).not.toHaveBeenCalled();
        expect(mocks.syncGuestDefaultPrompts).not.toHaveBeenCalled();
    });
});

// @vitest-environment jsdom

/**
 * ユーザー一覧取得失敗の伝え方の錠。
 * alert() ではなく画面内の role=alert バナー+再試行導線で完結すること。
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAllUsers: vi.fn(),
    logAudit: vi.fn(async () => undefined),
    loggerError: vi.fn(),
}));

vi.mock('@/lib/userManagement', () => ({
    getAllUsers: mocks.getAllUsers,
}));

vi.mock('@/lib/auditLog', () => ({
    logAudit: mocks.logAudit,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.loggerError }),
}));

import UsersPanel from './UsersPanel';

const USER = {
    uid: 'user-1',
    email: 'user@example.com',
    displayName: '山田',
    superuser: false,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    lastLoginAt: new Date('2026-09-01T00:00:00Z'),
    promptCount: 3,
    documentCount: 5,
};

describe('UsersPanel', () => {
    let container: HTMLDivElement;
    let root: Root;
    let confirmSpy: MockInstance<(message?: string) => boolean>;
    let alertSpy: MockInstance<(message?: string) => void>;

    beforeAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    beforeEach(() => {
        mocks.getAllUsers.mockReset();
        mocks.logAudit.mockClear();
        mocks.loggerError.mockClear();
        confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        // 失敗の伝達は画面内で完結する。ネイティブの confirm()/alert() へ
        // 退行したらどのテストでもここで落ちる。
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
        alertSpy.mockRestore();
    });

    async function renderPanel(): Promise<void> {
        await act(async () => {
            root.render(<UsersPanel />);
        });
    }

    it('取得成功時は一覧を表示し、エラーバナーを出さない', async () => {
        mocks.getAllUsers.mockResolvedValue([USER]);

        await renderPanel();

        expect(container.textContent).toContain('user@example.com');
        expect(container.textContent).toContain('合計: 1人');
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it('取得失敗は画面内のrole=alertで伝え、再試行で復旧できる', async () => {
        mocks.getAllUsers
            .mockRejectedValueOnce(new Error('unavailable'))
            .mockResolvedValueOnce([USER]);

        await renderPanel();

        const banner = container.querySelector('[role="alert"]');
        expect(banner?.textContent).toContain('ユーザー一覧を取得できませんでした。');
        expect(mocks.loggerError).toHaveBeenCalledTimes(1);

        const retryButton = Array.from(banner!.querySelectorAll('button')).find(
            button => button.textContent?.trim() === '再試行',
        );
        expect(retryButton).not.toBeUndefined();
        await act(async () => {
            retryButton!.click();
        });

        expect(mocks.getAllUsers).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.textContent).toContain('user@example.com');
    });
});

// @vitest-environment jsdom

/**
 * お知らせ管理の状態表示の錠。
 * 「お知らせはまだありません」は購読が空配列を返して初めて言える。
 * 読み込み中と購読失敗を空状態と同じ顔で出さないこと。
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemNotification } from '@/lib/systemNotifications';

type Subscriber = {
    onUpdate: (notifications: SystemNotification[]) => void;
    onError?: (error: Error) => void;
};

const mocks = vi.hoisted(() => ({
    subscribeToAllNotifications: vi.fn(),
    unsubscribe: vi.fn(),
    subscribers: [] as unknown[],
}));

vi.mock('@/lib/systemNotifications', () => ({
    subscribeToAllNotifications: mocks.subscribeToAllNotifications,
}));

vi.mock('./AdminNotificationEditModal', () => ({
    AdminNotificationEditModal: () => null,
}));

vi.mock('./AdminNotificationCreateModal', () => ({
    AdminNotificationCreateModal: () => null,
}));

import SystemNotificationPanel from './SystemNotificationPanel';

const NOTIFICATION: SystemNotification = {
    id: 'notification-1',
    title: 'メンテナンスのお知らせ',
    body: '9/23 02:00 から 03:00 まで停止します。',
    severity: 'info',
    published: true,
    publishedAt: new Date('2026-09-22T01:00:00Z'),
    publishedBy: 'admin-1',
};

const EMPTY_STATE = 'お知らせはまだありません';

describe('SystemNotificationPanel', () => {
    let container: HTMLDivElement;
    let root: Root;

    function subscribers(): Subscriber[] {
        return mocks.subscribers as Subscriber[];
    }

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
        mocks.subscribers.length = 0;
        mocks.unsubscribe.mockReset();
        mocks.subscribeToAllNotifications.mockReset().mockImplementation((
            onUpdate: Subscriber['onUpdate'],
            onError?: Subscriber['onError'],
        ) => {
            mocks.subscribers.push({ onUpdate, onError });
            return mocks.unsubscribe;
        });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    async function renderPanel(): Promise<void> {
        await act(async () => {
            root.render(<SystemNotificationPanel />);
        });
    }

    it('購読の結果が来るまでは空状態を断言せず読み込み中を出す', async () => {
        await renderPanel();

        expect(mocks.subscribeToAllNotifications).toHaveBeenCalledTimes(1);
        expect(container.textContent).not.toContain(EMPTY_STATE);
        expect(container.textContent).toContain('読み込み中');
        // 件数は確定してから出す。
        expect(container.textContent).not.toContain('0件');
    });

    it('購読失敗は空状態でなくrole=alertで伝え、再試行で購読し直す', async () => {
        await renderPanel();

        const subscriber = subscribers()[0];
        expect(subscriber.onError).toBeTypeOf('function');

        await act(async () => {
            subscriber.onError?.(new Error('permission-denied'));
        });

        const banner = container.querySelector('[role="alert"]');
        expect(banner?.textContent).toContain('お知らせを読み込めませんでした');
        expect(container.textContent).not.toContain(EMPTY_STATE);
        expect(container.textContent).not.toContain('0件');

        const retryButton = Array.from(banner!.querySelectorAll('button')).find(
            button => button.textContent?.trim() === '再試行',
        );
        expect(retryButton).not.toBeUndefined();

        await act(async () => {
            retryButton!.click();
        });

        expect(mocks.subscribeToAllNotifications).toHaveBeenCalledTimes(2);
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);

        await act(async () => {
            subscribers()[1].onUpdate([NOTIFICATION]);
        });

        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.textContent).toContain('メンテナンスのお知らせ');
        expect(container.textContent).toContain('1件');
    });

    it('購読が空配列を返して初めて空状態と件数を出す', async () => {
        await renderPanel();

        await act(async () => {
            subscribers()[0].onUpdate([]);
        });

        expect(container.textContent).toContain(EMPTY_STATE);
        expect(container.textContent).toContain('0件');
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });
});

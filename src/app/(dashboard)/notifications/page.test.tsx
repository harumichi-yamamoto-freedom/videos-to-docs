import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRouter, useSearchParams } from 'next/navigation';
import { arrayUnion, doc, setDoc } from 'firebase/firestore';
import { useAuth } from '@/hooks/useAuth';
import { useSystemNotifications } from '@/hooks/useSystemNotifications';
import type { SystemNotification } from '@/lib/systemNotifications';
import NotificationsPage from './page';

const mocks = vi.hoisted(() => ({
    db: { name: 'firestore' },
    dismissalsRef: { path: 'notificationDismissals/user-1' },
    loggerError: vi.fn(),
    retry: vi.fn(),
    routerReplace: vi.fn(),
}));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();

    return {
        ...actual,
        useState: vi.fn(),
    };
});

vi.mock('next/navigation', () => ({
    useRouter: vi.fn(),
    useSearchParams: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
    arrayUnion: vi.fn(),
    doc: vi.fn(),
    setDoc: vi.fn(),
}));

vi.mock('@/lib/firebase', () => ({
    db: mocks.db,
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: vi.fn(),
}));

vi.mock('@/hooks/useSystemNotifications', () => ({
    useSystemNotifications: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: mocks.loggerError }),
}));

vi.mock('@/components/NotificationDetailModal', () => ({
    NotificationDetailModal: () => null,
}));

interface PendingReadMutation {
    uid: string;
    ids: string[];
    saving: boolean;
}

interface ButtonProps {
    children?: React.ReactNode;
    className?: string;
    disabled?: boolean;
    onClick: () => void | Promise<void>;
}

const notifications: SystemNotification[] = [
    {
        id: 'notification-1',
        title: 'サービス更新のお知らせ',
        body: '新機能を追加しました。',
        severity: 'info',
        published: true,
        publishedAt: new Date('2026-09-01T00:00:00.000Z'),
        publishedBy: 'admin-1',
    },
    {
        id: 'notification-2',
        title: '重要なお知らせ',
        body: 'セキュリティ設定をご確認ください。',
        severity: 'critical',
        published: true,
        publishedAt: new Date('2026-08-31T00:00:00.000Z'),
        publishedBy: 'admin-1',
    },
];

function getText(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }
    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return '';
    }
    return React.Children.toArray(node.props.children).map(getText).join('');
}

function findElement(
    node: React.ReactNode,
    predicate: (element: React.ReactElement<{ children?: React.ReactNode; className?: string }>) => boolean,
): React.ReactElement<{ children?: React.ReactNode; className?: string }> | null {
    if (!React.isValidElement<{ children?: React.ReactNode; className?: string }>(node)) {
        return null;
    }
    if (predicate(node)) return node;
    for (const child of React.Children.toArray(node.props.children)) {
        const match = findElement(child, predicate);
        if (match) return match;
    }
    return null;
}

function findButton(node: React.ReactNode, text: string): React.ReactElement<ButtonProps> | null {
    return findElement(
        node,
        element => element.type === 'button' && getText(element).includes(text),
    ) as React.ReactElement<ButtonProps> | null;
}

function renderContent({
    pendingReadMutation = null,
    markReadErrorUid = null,
}: {
    pendingReadMutation?: PendingReadMutation | null;
    markReadErrorUid?: string | null;
} = {}) {
    const setPendingReadMutation = vi.fn();
    const setMarkReadErrorUid = vi.fn();
    vi.mocked(useState)
        .mockImplementationOnce(() => [pendingReadMutation, setPendingReadMutation])
        .mockImplementationOnce(() => [markReadErrorUid, setMarkReadErrorUid]);

    const page = NotificationsPage() as React.ReactElement<{
        children: React.ReactElement;
    }>;
    const content = page.props.children;
    const Content = content.type as () => React.ReactNode;

    return {
        tree: Content(),
        setPendingReadMutation,
        setMarkReadErrorUid,
    };
}

describe('NotificationsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(useRouter).mockReturnValue({ replace: mocks.routerReplace } as never);
        vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
        vi.mocked(useAuth).mockReturnValue({ user: { uid: 'user-1' }, loading: false } as never);
        vi.mocked(useSystemNotifications).mockReturnValue({
            notifications,
            dismissedIds: ['notification-1'],
            loading: false,
            error: null,
            stale: false,
            retrying: false,
            retry: mocks.retry,
            bannerNotifications: [],
        });
        vi.mocked(doc).mockReturnValue(mocks.dismissalsRef as never);
        vi.mocked(arrayUnion).mockReturnValue({ transform: 'arrayUnion' } as never);
        vi.mocked(setDoc).mockResolvedValue(undefined);
    });

    it('全て既読は arrayUnion で未読 ID だけを atomic 追加する', async () => {
        const { tree, setPendingReadMutation } = renderContent();
        const button = findButton(tree, '全て既読にする');

        await button?.props.onClick();

        expect(arrayUnion).toHaveBeenCalledWith('notification-2');
        expect(doc).toHaveBeenCalledWith(mocks.db, 'notificationDismissals', 'user-1');
        expect(setDoc).toHaveBeenCalledWith(
            mocks.dismissalsRef,
            {
                uid: 'user-1',
                dismissedIds: { transform: 'arrayUnion' },
            },
            { merge: true },
        );
        const optimisticMutation = setPendingReadMutation.mock.calls[0][0] as PendingReadMutation;
        expect(optimisticMutation).toEqual({
            uid: 'user-1',
            ids: ['notification-2'],
            saving: true,
        });
        const markSaved = setPendingReadMutation.mock.calls[1][0] as (
            current: PendingReadMutation | null,
        ) => PendingReadMutation | null;
        expect(markSaved(optimisticMutation)).toEqual({
            ...optimisticMutation,
            saving: false,
        });
    });

    it('既読更新の失敗時は楽観反映を rollback して画面内エラーにする', async () => {
        vi.mocked(setDoc).mockRejectedValueOnce(new Error('write failed'));
        const { tree, setPendingReadMutation, setMarkReadErrorUid } = renderContent();
        const button = findButton(tree, '全て既読にする');

        await button?.props.onClick();

        const optimisticMutation = setPendingReadMutation.mock.calls[0][0] as PendingReadMutation;
        const rollback = setPendingReadMutation.mock.calls[1][0] as (
            current: PendingReadMutation | null,
        ) => PendingReadMutation | null;
        expect(rollback(optimisticMutation)).toBeNull();
        expect(setMarkReadErrorUid).toHaveBeenLastCalledWith('user-1');
        expect(mocks.loggerError).toHaveBeenCalledOnce();
    });

    it('保存成功後も購読値が ID を含むまで楽観反映を維持する', () => {
        const mutation: PendingReadMutation = {
            uid: 'user-1',
            ids: ['notification-2'],
            saving: false,
        };
        const { tree, setPendingReadMutation } = renderContent({ pendingReadMutation: mutation });
        const title = findElement(
            tree,
            element => element.type === 'h3' && getText(element) === '重要なお知らせ',
        );

        expect(title?.props.className).toContain('font-medium');
        expect(setPendingReadMutation).not.toHaveBeenCalled();

        vi.mocked(useSystemNotifications).mockReturnValue({
            ...vi.mocked(useSystemNotifications).mock.results[0].value,
            dismissedIds: ['notification-1', 'notification-2'],
        });
        const stillSaving = renderContent({
            pendingReadMutation: { ...mutation, saving: true },
        });
        expect(stillSaving.setPendingReadMutation).not.toHaveBeenCalled();

        const acknowledged = renderContent({ pendingReadMutation: mutation });
        expect(acknowledged.setPendingReadMutation).toHaveBeenCalledWith(null);
    });

    it('既読行を透明化せず、未読ドットとタイトル重量で状態を表す', () => {
        const { tree } = renderContent();
        const container = findElement(
            tree,
            element => element.type === 'div' && element.props.className?.includes('max-w-3xl') === true,
        );
        const readTitle = findElement(
            tree,
            element => element.type === 'h3' && getText(element) === 'サービス更新のお知らせ',
        );
        const unreadTitle = findElement(
            tree,
            element => element.type === 'h3' && getText(element) === '重要なお知らせ',
        );
        const unreadMarker = findElement(
            tree,
            element => element.type === 'span' && getText(element) === '未読',
        );
        const listButton = findButton(tree, 'サービス更新のお知らせ');

        expect(container).not.toBeNull();
        expect(readTitle?.props.className).toContain('font-medium');
        expect(unreadTitle?.props.className).toContain('font-semibold');
        expect(unreadMarker).not.toBeNull();
        expect(listButton?.props.className).not.toContain('opacity-60');
    });

    it('既読化エラーの警告は再試行CTAを持ち、押すと既読化を再実行してエラーを畳む', async () => {
        const { tree, setMarkReadErrorUid } = renderContent({ markReadErrorUid: 'user-1' });
        const retryButton = findButton(tree, 'もう一度既読にする');

        expect(retryButton).not.toBeNull();
        await retryButton?.props.onClick();

        expect(setMarkReadErrorUid).toHaveBeenCalledWith(null);
        expect(setDoc).toHaveBeenCalledTimes(1);
        expect(arrayUnion).toHaveBeenCalledWith('notification-2');
    });

    it('未ログインでは既読化エラーの警告を出さない（uid 不在同士の一致を誤検出しない）', () => {
        vi.mocked(useAuth).mockReturnValue({ user: null, loading: false } as never);
        const { tree } = renderContent();

        expect(getText(tree)).not.toContain('全てのお知らせを既読にできませんでした');
        expect(findButton(tree, 'もう一度既読にする')).toBeNull();
        expect(findButton(tree, '全て既読にする')).toBeNull();
    });

    it('本体コラムは左揃えの読み幅制限で、中央寄せ（mx-auto）へ戻さない', () => {
        const { tree } = renderContent();
        const container = findElement(
            tree,
            element => element.type === 'div' && element.props.className?.includes('max-w-3xl') === true,
        );

        expect(container).not.toBeNull();
        expect(container?.props.className).not.toContain('mx-auto');
    });

    it('購読失敗時は stale 案内と再試行 UI を表示する', () => {
        vi.mocked(useSystemNotifications).mockReturnValue({
            notifications,
            dismissedIds: ['notification-1'],
            loading: false,
            error: new Error('subscription failed'),
            stale: true,
            retrying: false,
            retry: mocks.retry,
            bannerNotifications: [],
        });
        const { tree } = renderContent();
        const retryButton = findButton(tree, '再試行する');

        expect(getText(tree)).toContain('表示中の内容は以前に取得した情報です。');
        retryButton?.props.onClick();
        expect(mocks.retry).toHaveBeenCalledOnce();
    });
});

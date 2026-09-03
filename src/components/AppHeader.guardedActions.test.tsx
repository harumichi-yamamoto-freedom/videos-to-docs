// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGN_IN_LABEL } from '@/components/ui/labels';
import { NAVIGATION_INTENT_EVENT, requestGuardedAction } from '@/hooks/useNavigationGuard';

/**
 * S2-2: ヘッダーのログイン/ログアウトは、処理中の画面に問い合わせてから実行する。
 * 問い合わせ (requestGuardedAction) を止める側が居なければ即実行、居れば承認まで待つ。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    user: { uid: 'u1', email: 'a@example.com', displayName: '東野', providerData: [{ providerId: 'password' }] } as
        | { uid: string; email: string; displayName: string; providerData: { providerId: string }[] }
        | null,
    signOutNow: vi.fn(),
    beginAccountDeletion: vi.fn(),
    authModalOpen: [] as boolean[],
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: state.user, loading: false }),
}));
vi.mock('@/hooks/useAdmin', async () => {
    const { adminAccessResult } = await import('@/testUtils/hookResults');
    return { useAdmin: () => adminAccessResult('denied') };
});
vi.mock('@/hooks/useSystemNotifications', async () => {
    const { systemNotificationsResult } = await import('@/testUtils/hookResults');
    return {
        useSystemNotifications: () => systemNotificationsResult({
            notifications: [],
            dismissedIds: [],
            error: null,
        }),
    };
});
vi.mock('next/navigation', () => ({
    usePathname: () => '/home',
    useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next/link', () => ({
    default: ({
        children,
        href,
        ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
        <a href={href} {...props}>{children}</a>
    ),
}));
vi.mock('@/lib/auth', () => ({ signOutNow: state.signOutNow }));
vi.mock('./AccountDeletionFlow', () => ({
    useAccountDeletionFlow: () => ({
        beginAccountDeletion: state.beginAccountDeletion,
        accountDeletionDialog: null,
    }),
}));
vi.mock('@/lib/relationships', () => ({
    subscribeToPendingSubordinateRelationships: vi.fn(() => vi.fn()),
}));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('./AuthModal', () => ({
    default: ({ isOpen }: { isOpen: boolean }) => {
        state.authModalOpen.push(isOpen);
        return null;
    },
}));
vi.mock('./PasswordChangeModal', () => ({ default: () => null }));
vi.mock('./DisplayNameModal', () => ({ default: () => null }));

const { AppHeader } = await import('./AppHeader');

type Mounted = { container: HTMLDivElement; root: Root };
const mountedHeaders = new Set<Mounted>();

async function mountHeader(): Promise<Mounted> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const mounted = { container, root };
    mountedHeaders.add(mounted);
    await act(async () => {
        root.render(<AppHeader />);
    });
    return mounted;
}

function buttonByText(mounted: Mounted, label: string): HTMLButtonElement {
    const button = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button'))
        .find(element => element.textContent?.trim() === label);
    if (!button) throw new Error(`${label} ボタンがありません`);
    return button;
}

async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
        element.click();
        await Promise.resolve();
    });
}

/** ガード中の画面の代わりに、意図イベントを止める側を立てる */
function installBlockingGuard(): { proceeds: Array<() => void>; remove: () => void } {
    const proceeds: Array<() => void> = [];
    const listener = (event: Event) => {
        event.preventDefault();
        proceeds.push((event as CustomEvent<{ proceed: () => void }>).detail.proceed);
    };
    window.addEventListener(NAVIGATION_INTENT_EVENT, listener);
    return { proceeds, remove: () => window.removeEventListener(NAVIGATION_INTENT_EVENT, listener) };
}

describe('requestGuardedAction', () => {
    it('止める側が居なければその場で実行する', () => {
        const proceed = vi.fn();
        requestGuardedAction('signout', proceed);
        expect(proceed).toHaveBeenCalledTimes(1);
    });

    it('止める側が preventDefault したら実行せず、承認で渡した proceed を呼ぶ', () => {
        const guard = installBlockingGuard();
        try {
            const proceed = vi.fn();
            requestGuardedAction('signin', proceed);
            expect(proceed).not.toHaveBeenCalled();
            expect(guard.proceeds).toHaveLength(1);

            guard.proceeds[0]();
            expect(proceed).toHaveBeenCalledTimes(1);
        } finally {
            guard.remove();
        }
    });
});

describe('AppHeader の認証操作は離脱ガードを通す (S2-2)', () => {
    beforeEach(() => {
        state.user = { uid: 'u1', email: 'a@example.com', displayName: '東野', providerData: [{ providerId: 'password' }] };
        state.signOutNow.mockReset().mockResolvedValue(undefined);
        state.beginAccountDeletion.mockReset().mockResolvedValue(undefined);
        state.authModalOpen = [];
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            value: vi.fn(() => ({
                matches: false,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })),
        });
        Object.defineProperty(window, 'requestAnimationFrame', {
            configurable: true,
            value: vi.fn((callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            }),
        });
    });

    afterEach(async () => {
        for (const mounted of [...mountedHeaders]) {
            mountedHeaders.delete(mounted);
            await act(async () => {
                mounted.root.unmount();
            });
            mounted.container.remove();
        }
        document.body.replaceChildren();
        vi.restoreAllMocks();
    });

    it('ログアウトは、止める側が居なければそのまま実行する', async () => {
        const mounted = await mountHeader();
        await click(buttonByText(mounted, '東野'));
        await click(buttonByText(mounted, 'ログアウト'));

        expect(state.signOutNow).toHaveBeenCalledTimes(1);
    });

    it('ログアウトは、処理中の画面が止めたら承認まで実行しない', async () => {
        const guard = installBlockingGuard();
        try {
            const mounted = await mountHeader();
            await click(buttonByText(mounted, '東野'));
            await click(buttonByText(mounted, 'ログアウト'));

            expect(state.signOutNow).not.toHaveBeenCalled();
            expect(guard.proceeds).toHaveLength(1);

            guard.proceeds[0]();
            expect(state.signOutNow).toHaveBeenCalledTimes(1);
        } finally {
            guard.remove();
        }
    });

    it('ログインの開始も同じ問い合わせを通す', async () => {
        state.user = null;
        const guard = installBlockingGuard();
        try {
            const mounted = await mountHeader();
            const signInButton = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button'))
                .find(element => element.textContent?.trim() === SIGN_IN_LABEL);
            expect(signInButton).toBeDefined();

            await click(signInButton!);
            expect(state.authModalOpen.at(-1)).toBe(false);
            expect(guard.proceeds).toHaveLength(1);

            await act(async () => {
                guard.proceeds[0]();
            });
            expect(state.authModalOpen.at(-1)).toBe(true);
        } finally {
            guard.remove();
        }
    });

    it('アカウント削除の開始も同じ問い合わせを通す', async () => {
        const guard = installBlockingGuard();
        try {
            const mounted = await mountHeader();
            await click(buttonByText(mounted, '東野'));
            await click(buttonByText(mounted, 'アカウントを削除'));

            expect(state.beginAccountDeletion).not.toHaveBeenCalled();
            guard.proceeds[0]();
            expect(state.beginAccountDeletion).toHaveBeenCalledTimes(1);
        } finally {
            guard.remove();
        }
    });
});

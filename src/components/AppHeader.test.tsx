import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ariaReferenceCount, danglingAriaReferences } from '@/testUtils/ariaReferences';
import { SIGN_IN_LABEL } from '@/components/ui/labels';

const state = vi.hoisted(() => ({
    user: { uid: 'u1', email: 'a@example.com', displayName: '東野', providerData: [{ providerId: 'password' }] } as
        | { uid: string; email: string; displayName: string; providerData: { providerId: string }[] }
        | null,
    authLoading: false,
    isAdmin: false,
    pathname: '/home',
    search: '',
    notifications: [] as { id: string }[],
    dismissedIds: [] as string[],
    notificationsError: null as Error | null,
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: state.user, loading: state.authLoading }),
}));

vi.mock('@/hooks/useAdmin', () => ({
    useAdmin: () => ({ isAdmin: state.isAdmin, loading: false, error: null, retry: vi.fn() }),
}));

vi.mock('@/hooks/useSystemNotifications', () => ({
    useSystemNotifications: () => ({
        notifications: state.notifications,
        dismissedIds: state.dismissedIds,
        loading: false,
        bannerNotifications: [],
        error: state.notificationsError,
        stale: false,
        retry: vi.fn(),
    }),
}));

vi.mock('next/navigation', () => ({
    usePathname: () => state.pathname,
    useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock('@/lib/auth', () => ({ signOutNow: vi.fn(), deleteAccount: vi.fn() }));
vi.mock('@/lib/accountDeletion', () => ({ getUserDeletionInfo: vi.fn() }));
vi.mock('@/lib/relationships', () => ({ subscribeToPendingSubordinateRelationships: vi.fn(() => vi.fn()) }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('./AuthModal', () => ({ default: () => null }));
vi.mock('./PasswordChangeModal', () => ({ default: () => null }));
vi.mock('./ReauthModal', () => ({ default: () => null }));
vi.mock('./DisplayNameModal', () => ({ default: () => null }));

const { AppHeader } = await import('./AppHeader');

interface Anchor {
    href: string;
    tag: string;
}

/** 描画結果から <a> を href 付きで拾う。属性の順序に依存しないようにタグ全体も返す。 */
function anchors(html: string): Anchor[] {
    return [...html.matchAll(/<a\b[^>]*>/g)]
        .map(match => match[0])
        .map(tag => ({ tag, href: /href="([^"]*)"/.exec(tag)?.[1] ?? '' }));
}

const render = () => renderToStaticMarkup(<AppHeader />);

beforeEach(() => {
    state.user = { uid: 'u1', email: 'a@example.com', displayName: '東野', providerData: [{ providerId: 'password' }] };
    state.authLoading = false;
    state.isAdmin = false;
    state.pathname = '/home';
    state.search = '';
    state.notifications = [];
    state.dismissedIds = [];
    state.notificationsError = null;
});

describe('AppHeader ナビゲーション (E3)', () => {
    it('主要タブが router.push ではなく href を持つ実リンクで描画される', () => {
        const hrefs = anchors(render()).map(a => a.href);
        expect(hrefs).toContain('/home');
        expect(hrefs).toContain('/documents');
        expect(hrefs).toContain('/notifications');
        expect(hrefs.some(href => href.startsWith('/team?'))).toBe(false); // チームは開くまでリンクを出さない
    });

    it('現在地のリンクだけが aria-current="page" を持つ', () => {
        state.pathname = '/documents';
        const found = anchors(render());
        const documents = found.filter(a => a.href === '/documents');
        const home = found.filter(a => a.href === '/home');

        expect(documents.length).toBeGreaterThan(0);
        expect(documents.every(a => a.tag.includes('aria-current="page"'))).toBe(true);
        // ブランドリンクも /home を指すため、ホームのタブだけを見る
        expect(home.filter(a => a.tag.includes('aria-current="page"'))).toHaveLength(0);
    });

    it('開閉式の節（チーム）にいる間もナビの現在地が消えない', () => {
        state.pathname = '/team';
        state.search = 'view=supervisors';
        const html = render();

        // チームはリンクではなく開閉トリガーなので aria-current="true"
        expect(html).toContain('aria-current="true"');
        const teamButtons = [...html.matchAll(/<button\b[^>]*>/g)]
            .map(m => m[0])
            .filter(tag => tag.includes('aria-current="true"'));
        expect(teamButtons.length).toBeGreaterThanOrEqual(2); // デスクトップ + モバイル
    });

    it('チーム以外にいるときはチームを現在地にしない', () => {
        state.pathname = '/documents';
        expect(render()).not.toContain('aria-current="true"');
    });

    it('ヘッダーは見出しを持たない（h1 は各ページの PageHeader が持つ）', () => {
        expect(render()).not.toContain('<h1');
    });

    it('ブランドは /home へのリンクで、「簡易版」はバッジとして分離されている', () => {
        const html = render();
        const brand = anchors(html).find(a => a.tag.includes('aria-label="商談くんミニ（簡易版）"'));
        expect(brand?.href).toBe('/home');
        expect(html).toContain('商談くんミニ');
        expect(html).toContain('簡易版');
    });

    it('管理者だけが管理者画面リンクを見る', () => {
        expect(anchors(render()).map(a => a.href)).not.toContain('/admin');
        state.isAdmin = true;
        expect(anchors(render()).map(a => a.href)).toContain('/admin');
    });

    it('ナビ項目はタップ下限 44px を満たす', () => {
        state.isAdmin = true;
        const navLikeTags = anchors(render())
            .map(a => a.tag)
            // ブランドリンクはナビ項目ではない（高さは h-20 の行と中のロゴで決まる）
            .filter(tag => /href="\/(home|documents|notifications|admin)"/.test(tag))
            .filter(tag => !tag.includes('aria-label="商談くんミニ'));

        expect(navLikeTags.length).toBeGreaterThanOrEqual(8); // デスクトップ4 + モバイル4
        expect(navLikeTags.every(tag => tag.includes('min-h-11'))).toBe(true);
    });

    it('中央固定のための 3 カラムグリッドを使う', () => {
        expect(render()).toContain('grid-cols-[1fr_auto_1fr]');
    });
});

describe('AppHeader の aria 参照 (Y16)', () => {
    it('aria の参照先がすべて実在する', () => {
        for (const setup of [
            () => { },
            () => { state.isAdmin = true; },
            () => { state.user = null; },
            () => { state.authLoading = true; },
        ]) {
            state.isAdmin = false;
            state.user = { uid: 'u1', email: 'a@example.com', displayName: '東野', providerData: [{ providerId: 'password' }] };
            state.authLoading = false;
            setup();

            const html = render();
            expect(ariaReferenceCount(html), '参照が 0 本では実在検査にならない').toBeGreaterThan(0);
            const dangling = danglingAriaReferences(html);
            expect(dangling, `参照先が存在しない: ${dangling.join(', ')}`).toEqual([]);
        }
    });

    it('陰性統制: 実在しない参照を検出できる', () => {
        expect(danglingAriaReferences('<button aria-controls="nope"></button>')).toEqual(['nope']);
        expect(danglingAriaReferences('<div id="x"></div><button aria-controls="x"></button>')).toEqual([]);
    });
});

describe('案内文はヘッダーの実ラベルと結び付く (Y14 / P3)', () => {
    /** モバイルメニューの panel を境に、デスクトップ側とモバイル側へ分ける。 */
    function splitByViewport(html: string): { desktop: string; mobile: string } {
        const boundary = html.indexOf('id="app-header-mobile-menu"');
        expect(boundary, 'モバイルメニューの境界が見つからない').toBeGreaterThan(-1);
        return { desktop: html.slice(0, boundary), mobile: html.slice(boundary) };
    }

    it('デスクトップとモバイルの両方に共有定数のログインボタンが出る', () => {
        state.user = null;
        const { desktop, mobile } = splitByViewport(render());
        // 片側だけの退行を緑にしないため、幅ごとに個別に見る
        expect(desktop, 'デスクトップ側のログインボタンが無い').toContain(SIGN_IN_LABEL);
        expect(mobile, 'モバイル側のログインボタンが無い').toContain(SIGN_IN_LABEL);
    });

    it('ログイン済みならどちらにもログインボタンを出さない', () => {
        const { desktop, mobile } = splitByViewport(render());
        expect(desktop).not.toContain(SIGN_IN_LABEL);
        expect(mobile).not.toContain(SIGN_IN_LABEL);
    });
});

describe('AppHeader が購読エラーを捨てない (E10)', () => {
    it('通知購読が失敗したら未読 0 件のふりをせず取得失敗を示す', () => {
        state.notificationsError = new Error('permission-denied');
        const html = render();
        expect(html).toContain('お知らせを取得できませんでした');
        expect(html).toContain('取得失敗');
    });

    it('正常時は失敗表示を出さない', () => {
        state.notifications = [{ id: 'n1' }];
        const html = render();
        expect(html).not.toContain('お知らせを取得できませんでした');
        expect(html).toContain('未読 1 件');
    });
});

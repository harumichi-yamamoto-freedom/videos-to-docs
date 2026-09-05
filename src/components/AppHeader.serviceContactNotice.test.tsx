// @vitest-environment jsdom

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SERVICE_CONTACT_NOTICE } from './ServiceContactNotice';

/**
 * サービスの不具合の連絡先案内は、どの認証状態でも常に見える。
 * 「文言が HTML に含まれる」だけを錠にすると、閉じたモバイルメニュー(inert)の中や
 * sr-only の中に落ちても緑になる。隠す仕組みの外に 1 回だけ出ることを DOM で見る。
 */

const state = vi.hoisted(() => ({
    user: { uid: 'u1', email: 'a@example.com', displayName: '利用者A', providerData: [{ providerId: 'password' }] } as
        | { uid: string; email: string; displayName: string; providerData: { providerId: string }[] }
        | null,
    authLoading: false,
    isAdmin: false,
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: state.user, loading: state.authLoading }),
}));
vi.mock('@/hooks/useAdmin', async () => {
    const { adminAccessResult } = await import('@/testUtils/hookResults');
    return { useAdmin: () => adminAccessResult(state.isAdmin ? 'allowed' : 'denied') };
});
vi.mock('@/hooks/useSystemNotifications', async () => {
    const { systemNotificationsResult } = await import('@/testUtils/hookResults');
    return { useSystemNotifications: () => systemNotificationsResult() };
});
vi.mock('next/navigation', () => ({
    usePathname: () => '/home',
    useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/lib/auth', () => ({ signOutNow: vi.fn() }));
// 実物の AccountDeletionFlow は @/lib/firebase を読み込み、API キー未設定で落ちる。
vi.mock('./AccountDeletionFlow', () => ({
    useAccountDeletionFlow: () => ({ beginAccountDeletion: vi.fn(), accountDeletionDialog: null }),
}));
vi.mock('@/lib/relationships', () => ({ subscribeToPendingSubordinateRelationships: vi.fn(() => vi.fn()) }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('./AuthModal', () => ({ default: () => null }));
vi.mock('./PasswordChangeModal', () => ({ default: () => null }));
vi.mock('./DisplayNameModal', () => ({ default: () => null }));

const { AppHeader } = await import('./AppHeader');

function parse(html: string): DocumentFragment {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
}

const renderHeader = () => parse(renderToStaticMarkup(<AppHeader />));

/** 文言をそのまま本文に持つ最内側の要素。祖先も同じ本文になるので、同じ本文の子を持つ要素は除く。 */
function noticeElements(root: ParentNode): HTMLElement[] {
    const holds = (element: Element) => element.textContent?.trim() === SERVICE_CONTACT_NOTICE;
    return Array.from(root.querySelectorAll<HTMLElement>('*'))
        .filter(element => holds(element) && !Array.from(element.children).some(holds));
}

/** 視覚か支援技術のどちらかから隠すユーティリティ。幅限定(lg:hidden 等)も「常時」を破る。 */
const HIDING_UTILITIES = new Set(['hidden', 'invisible', 'sr-only', 'collapse']);
const bareUtility = (token: string) => token.split(':').at(-1) ?? token;

/** 隠す仕組み（属性かクラス）を要素自身か祖先に持てば、その要素を返す。 */
function hidingAncestor(element: Element): Element | null {
    for (let current: Element | null = element; current; current = current.parentElement) {
        if (current.hasAttribute('inert') || current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') {
            return current;
        }
        const classes = (current.getAttribute('class') ?? '').split(/\s+/).map(bareUtility);
        if (classes.some(cls => HIDING_UTILITIES.has(cls))) return current;
    }
    return null;
}

/** 折り返しや溢れを切り捨てるユーティリティ。狭い画面で文の後半が消える。 */
const TRUNCATION = /(?:^|\s|:)(?:truncate|line-clamp-\S+|text-ellipsis|whitespace-nowrap)(?=\s|$)/;

const AUTH_STATES: { name: string; setup: () => void }[] = [
    { name: 'ログイン済み', setup: () => { } },
    { name: '未ログイン', setup: () => { state.user = null; } },
    { name: '認証確認中', setup: () => { state.authLoading = true; } },
    { name: '管理者', setup: () => { state.isAdmin = true; } },
];

describe('サービス不具合の連絡先案内は常時見える', () => {
    beforeEach(() => {
        state.user = { uid: 'u1', email: 'a@example.com', displayName: '利用者A', providerData: [{ providerId: 'password' }] };
        state.authLoading = false;
        state.isAdmin = false;
    });

    it.each(AUTH_STATES)('$name: 案内文が隠されずに 1 回だけ、sticky なヘッダーの中に出る', ({ setup }) => {
        setup();
        const found = noticeElements(renderHeader());
        expect(found, '案内文が描画されていない、または複数回出ている').toHaveLength(1);

        const notice = found[0];
        const hidden = hidingAncestor(notice);
        expect(hidden, `隠す仕組みの中にある: ${hidden?.outerHTML.slice(0, 160)}`).toBeNull();
        expect(notice.className, '切り捨てると狭い画面で文の後半が消える').not.toMatch(TRUNCATION);

        // スクロール後も見え続けるのは、sticky なヘッダーの中にあるから。
        const header = notice.closest('header');
        expect(header, 'ヘッダーの外にある').not.toBeNull();
        expect(header?.classList.contains('sticky')).toBe(true);
    });

    it('読み上げ順ではメインナビゲーションの後に来る（本題の前に割り込まない）', () => {
        const root = renderHeader();
        const nav = root.querySelector('nav[aria-label="メインナビゲーション"]');
        const [notice] = noticeElements(root);
        expect(nav).not.toBeNull();
        expect(nav!.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    });
});

describe('陰性統制: 隠す仕組みの検出器が実際に反応する', () => {
    const firstParagraph = (html: string) => parse(html).querySelector('p')!;

    it.each([
        ['inert の祖先', '<div inert><p>x</p></div>'],
        ['aria-hidden の祖先', '<div aria-hidden="true"><p>x</p></div>'],
        ['hidden 属性', '<p hidden>x</p>'],
        ['幅限定の hidden クラス', '<div class="shrink-0 lg:hidden"><p>x</p></div>'],
        ['sr-only', '<p class="sr-only">x</p>'],
    ])('%s を捕まえる', (_name, html) => {
        expect(hidingAncestor(firstParagraph(html))).not.toBeNull();
    });

    it('overflow-hidden や focus-visible:not-sr-only には反応しない', () => {
        const html = '<div class="overflow-hidden focus-visible:not-sr-only"><p class="text-xs">x</p></div>';
        expect(hidingAncestor(firstParagraph(html))).toBeNull();
    });

    it('切り捨て検出器は truncate に反応し、寸法クラスには反応しない', () => {
        expect(TRUNCATION.test('text-xs truncate text-muted')).toBe(true);
        expect(TRUNCATION.test('sm:whitespace-nowrap')).toBe(true);
        expect(TRUNCATION.test('text-xs text-center px-4')).toBe(false);
    });
});

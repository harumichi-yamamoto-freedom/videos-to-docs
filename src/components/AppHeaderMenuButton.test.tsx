import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ariaReferenceCount, danglingAriaReferences } from '@/testUtils/ariaReferences';

/**
 * iconButtonClassName 側の錠(effectiveCss.test.ts)だけでは、AppHeader が
 * その仕組みを使うのをやめても全緑になる。開状態の伝え方そのものを固定する。
 */

const captured = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

/** 開いた状態を SSR で作るため、boolean の useState 初期値だけを true に倒す。 */
const control = vi.hoisted(() => ({ openAllBooleanState: false }));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useState: (initial: unknown) =>
            actual.useState(control.openAllBooleanState && initial === false ? true : initial),
    };
});

vi.mock('@/components/ui/IconButton', () => ({
    IconButton: (props: Record<string, unknown>) => {
        captured.props.push(props);
        return null;
    },
    iconButtonClassName: () => '',
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({
        user: { uid: 'u1', email: 'a@example.com', displayName: '東野', providerData: [] },
        loading: false,
    }),
}));
vi.mock('@/hooks/useAdmin', async () => {
    const { adminAccessResult } = await import('@/testUtils/hookResults');
    return { useAdmin: () => adminAccessResult('denied') };
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
// X1 が削除フローを AccountDeletionFlow へ抽出した。ここを差し替えないと
// 実物が @/lib/firebase を読み込み、API キー未設定でモジュール読込ごと落ちる。
vi.mock('./AccountDeletionFlow', () => ({
    useAccountDeletionFlow: () => ({ beginAccountDeletion: vi.fn(), accountDeletionDialog: null }),
}));
vi.mock('@/lib/relationships', () => ({ subscribeToPendingSubordinateRelationships: vi.fn(() => vi.fn()) }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('./AuthModal', () => ({ default: () => null }));
vi.mock('./PasswordChangeModal', () => ({ default: () => null }));
vi.mock('./DisplayNameModal', () => ({ default: () => null }));

const { AppHeader } = await import('./AppHeader');

function renderHeader(open: boolean): { props: Record<string, unknown>; html: string } {
    captured.props.length = 0;
    control.openAllBooleanState = open;
    try {
        const html = renderToStaticMarkup(<AppHeader />);
        const found = captured.props.find(props => props['aria-controls'] === 'app-header-mobile-menu');
        expect(found, 'モバイルメニューのトグルが IconButton で描画されていない').toBeDefined();
        return { props: found!, html };
    } finally {
        control.openAllBooleanState = false;
    }
}

const menuButtonProps = () => renderHeader(false).props;

const COLOR_UTILITY = /\b(?:bg|text|border|ring)-[a-z][a-z0-9-]*\b/;

describe('モバイルメニューの開状態の伝え方 (Y12)', () => {
    it('開状態は selected プロパティで渡す（className の後付けではない）', () => {
        const props = menuButtonProps();
        expect(props, 'selected を渡していない').toHaveProperty('selected');
        expect(typeof props.selected).toBe('boolean');
    });

    it('配色を className で後付けしない（生成 CSS の順序に勝敗を委ねない）', () => {
        const props = menuButtonProps();
        const className = typeof props.className === 'string' ? props.className : '';
        expect(className, `色指定を className で渡している: ${className}`).not.toMatch(COLOR_UTILITY);
    });

    it('陰性統制: 色ユーティリティ検出器が実際に反応する', () => {
        expect(COLOR_UTILITY.test('border-brand-border bg-selection')).toBe(true);
        expect(COLOR_UTILITY.test('shrink-0 rounded-l-none')).toBe(false);
    });
});

describe('selected が開閉状態に連動している (P4)', () => {
    it('閉じているときは false、開いているときは true', () => {
        expect(renderHeader(false).props.selected).toBe(false);
        expect(renderHeader(true).props.selected).toBe(true);
    });

    it('selected と aria-expanded が常に同じ状態を指す（別の状態を渡していない）', () => {
        for (const open of [false, true]) {
            const { props } = renderHeader(open);
            expect(props.selected, `open=${open}`).toBe(props['aria-expanded']);
        }
    });

    it('陰性統制: 開状態の強制が実際に効いている', () => {
        // これが効いていなければ上の 2 件は「常に false 同士」を見比べるだけになる
        expect(renderHeader(true).props['aria-expanded']).toBe(true);
        expect(renderHeader(false).props['aria-expanded']).toBe(false);
    });
});

describe('開いた状態の aria 参照 (P6)', () => {
    it('メニューを開いた描画でも参照先がすべて実在する', () => {
        const { html } = renderHeader(true);
        // 開状態でしか出ない aria-controls（アカウント／チームメニュー）を含む
        expect(html).toContain('app-header-account-menu');
        expect(ariaReferenceCount(html)).toBeGreaterThan(1);
        const dangling = danglingAriaReferences(html);
        expect(dangling, `参照先が存在しない: ${dangling.join(', ')}`).toEqual([]);
    });
});

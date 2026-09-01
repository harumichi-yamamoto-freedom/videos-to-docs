import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ariaReferenceCount, danglingAriaReferences } from '@/testUtils/ariaReferences';
import { SIGN_IN_LABEL } from '@/components/ui/labels';

const routerPush = vi.hoisted(() => vi.fn());
const retryAdminCheck = vi.hoisted(() => vi.fn());

const state = vi.hoisted(() => ({
    user: { uid: 'u1' } as { uid: string } | null,
    authLoading: false,
    adminStatus: 'allowed' as 'checking' | 'allowed' | 'denied' | 'error',
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: state.user, loading: state.authLoading }) }));
vi.mock('@/hooks/useAdmin', async () => {
    const { adminAccessResult } = await import('@/testUtils/hookResults');
    return { useAdmin: () => adminAccessResult(state.adminStatus, { retry: retryAdminCheck }) };
});
vi.mock('@/components/admin/AuditLogPanel', () => ({ default: () => <div>監査ログパネル</div> }));
vi.mock('@/components/admin/SettingsPanel', () => ({ default: () => <div>設定パネル</div> }));
vi.mock('@/components/admin/UsersPanel', () => ({ default: () => <div>ユーザーパネル</div> }));
vi.mock('@/components/admin/AudioFilesPanel', () => ({ default: () => <div>音声パネル</div> }));
vi.mock('@/components/admin/SystemNotificationPanel', () => ({ default: () => <div>通知パネル</div> }));

const AdminPage = (await import('./page')).default;

const render = () => renderToStaticMarkup(<AdminPage />);

beforeEach(() => {
    routerPush.mockClear();
    retryAdminCheck.mockClear();
    state.user = { uid: 'u1' };
    state.authLoading = false;
    state.adminStatus = 'allowed';
});

describe('管理者画面のタブ (E6)', () => {
    it('5 本のタブが tablist セマンティクスを持つ', () => {
        const html = render();
        expect(html).toContain('role="tablist"');
        expect(html.match(/role="tab"/g)).toHaveLength(5);
        expect(html).toContain('role="tabpanel"');
    });

    it('選択中のタブだけが aria-selected="true" かつ Tab で到達できる', () => {
        const tabTags = [...render().matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map(m => m[0]);
        expect(tabTags.filter(tag => tag.includes('aria-selected="true"'))).toHaveLength(1);
        expect(tabTags.filter(tag => tag.includes('tabindex="0"'))).toHaveLength(1);
        expect(tabTags.filter(tag => tag.includes('tabindex="-1"'))).toHaveLength(4);
    });

    it('タブとパネルが aria-controls / aria-labelledby で相互参照する', () => {
        const html = render();
        expect(html).toContain('id="admin-tab-audit"');
        expect(html).toContain('aria-controls="admin-panel-audit"');
        expect(html).toContain('id="admin-panel-audit"');
        expect(html).toContain('aria-labelledby="admin-tab-audit"');
    });

    it('aria の参照先がすべて実在する（未選択タブの aria-controls が宙に浮かない）', () => {
        const html = render();
        expect(ariaReferenceCount(html), '参照が 0 本では実在検査にならない').toBeGreaterThan(0);
        const dangling = danglingAriaReferences(html);
        expect(dangling, `参照先が存在しない: ${dangling.join(', ')}`).toEqual([]);
    });

    it('描画されていないパネルを指す aria-controls は付けない', () => {
        const tabTags = [...render().matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map(m => m[0]);
        const withControls = tabTags.filter(tag => tag.includes('aria-controls='));
        // パネルは選択中の 1 枚だけを描画しているので、参照も 1 本だけ
        expect(withControls).toHaveLength(1);
        expect(withControls[0]).toContain('aria-selected="true"');
    });

    it('パネル自体は tab の停止点にしない（中に操作可能な要素がある）', () => {
        const panelTag = /<div\b[^>]*role="tabpanel"[^>]*>/.exec(render())?.[0] ?? '';
        expect(panelTag).not.toBe('');
        expect(panelTag).not.toContain('tabindex');
    });

    it('狭い画面で末尾のタブが切れないよう横スクロールさせる', () => {
        const html = render();
        expect(html).toContain('overflow-x-auto');
        expect(html).toContain('min-w-max');
    });

    it('タブは 44px 下限を満たす', () => {
        const tabTags = [...render().matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map(m => m[0]);
        expect(tabTags.every(tag => tag.includes('min-h-11'))).toBe(true);
    });
});

describe('管理者画面が checking / error / denied を区別する (E11)', () => {
    it('確認中は「確認しています」と伝える（無言の空画面にしない）', () => {
        state.adminStatus = 'checking';
        const html = render();
        expect(html).toContain('権限を確認しています');
        expect(html).not.toContain('role="tablist"');
    });

    it('権限確認が失敗したら、権限なし扱いにせず再試行の出口を出す', () => {
        state.adminStatus = 'error';
        const html = render();

        expect(html).toContain('権限を確認できませんでした');
        expect(html).toContain('権限がないと判定されたわけではありません');
        expect(html).toContain('再試行');
        expect(html).not.toContain('role="tablist"');
    });

    it('権限不足は 403 相当の説明を出す（無言でホームへ送り返さない）', () => {
        state.adminStatus = 'denied';
        const html = render();

        expect(html).toContain('この画面を表示する権限がありません');
        expect(html).not.toBe('');
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('未認証はログイン導線を出す（画面上にある操作だけを案内する）', () => {
        state.user = null;
        state.adminStatus = 'denied';
        const html = render();

        expect(html).toContain('ログインが必要です');
        // 自分で書いた文言ではなく、ヘッダーが実際に描画するボタン名と同じ定数を見る。
        // AppHeader.test の「未認証ヘッダーが SIGN_IN_LABEL を出す」錠と対で意味を持つ。
        expect(html).toContain(SIGN_IN_LABEL);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('案内は読み上げを中断しない / 失敗と拒否だけが alert (Y10)', () => {
        state.user = null;
        state.adminStatus = 'denied';
        expect(render()).toContain('role="status"');

        beforeEachState();
        state.adminStatus = 'error';
        expect(render()).toContain('role="alert"');

        beforeEachState();
        state.adminStatus = 'denied';
        expect(render()).toContain('role="alert"');
    });

    it('どの状態でも見出しを失わない (E4)', () => {
        for (const setup of [
            () => { state.adminStatus = 'checking'; },
            () => { state.adminStatus = 'error'; },
            () => { state.adminStatus = 'denied'; },
            () => { state.user = null; },
            () => { },
        ]) {
            beforeEachState();
            setup();
            const html = render();
            expect(html).toContain('<h1');
            expect(html).toContain('管理者画面');
        }
    });
});

function beforeEachState() {
    state.user = { uid: 'u1' };
    state.authLoading = false;
    state.adminStatus = 'allowed';
}

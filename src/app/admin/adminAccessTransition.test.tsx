import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getVisibleAdminStatus } from '@/hooks/useAdmin';

/**
 * Y2: 未ログイン→ログインの遷移で 403 が一瞬でも出てはならない。
 * 未ログイン時の判定は denied で確定しているため、ログイン直後に
 * 「前ユーザーの判定」をそのまま見せると正規の管理者に一瞬 403 が出る。
 */

const state = vi.hoisted(() => ({
    user: null as { uid: string } | null,
    authLoading: false,
    adminStatus: 'denied' as 'checking' | 'allowed' | 'denied' | 'error',
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: state.user, loading: state.authLoading }) }));
// 純関数 getVisibleAdminStatus は実物を使いたいので、モジュールごと差し替えず
// useAdmin だけ差し替える。そのために Firebase 側を先に無害化しておく。
vi.mock('@/lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDoc: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useAdmin', async importOriginal => {
    const actual = await importOriginal<typeof import('@/hooks/useAdmin')>();
    const { adminAccessResult } = await import('@/testUtils/hookResults');
    return { ...actual, useAdmin: () => adminAccessResult(state.adminStatus) };
});
vi.mock('@/components/admin/AuditLogPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/SettingsPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/UsersPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/AudioFilesPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/SystemNotificationPanel', () => ({ default: () => null }));

const AdminPage = (await import('./page')).default;
const render = () => renderToStaticMarkup(<AdminPage />);

const DENIED_TEXT = 'この画面を表示する権限がありません';
const CHECKING_TEXT = '権限を確認しています';

beforeEach(() => {
    state.user = null;
    state.authLoading = false;
    state.adminStatus = 'denied';
});

describe('判定の見せ方 (Y2 の機構)', () => {
    it('UID が判定済みの UID と食い違う間は checking を返す', () => {
        // 未ログインで denied が確定した直後にログインした瞬間の状態
        const staleCheck = { uid: null, status: 'denied' as const };
        expect(getVisibleAdminStatus(staleCheck, 'admin-1', false)).toBe('checking');
    });

    it('認証の読み込み中も checking を返す', () => {
        expect(getVisibleAdminStatus({ uid: 'admin-1', status: 'allowed' }, 'admin-1', true)).toBe('checking');
    });

    it('UID が一致して初めて判定を見せる', () => {
        expect(getVisibleAdminStatus({ uid: 'admin-1', status: 'allowed' }, 'admin-1', false)).toBe('allowed');
        expect(getVisibleAdminStatus({ uid: 'admin-1', status: 'denied' }, 'admin-1', false)).toBe('denied');
    });
});

describe('未ログイン→ログインで 403 が一瞬も出ない (Y2)', () => {
    it('未ログインの間はログイン導線であって 403 ではない', () => {
        const html = render();
        expect(html).toContain('ログインが必要です');
        expect(html).not.toContain(DENIED_TEXT);
    });

    it('ログイン直後(判定やり直し中)は 403 ではなく確認中を出す', () => {
        state.user = { uid: 'admin-1' };
        state.adminStatus = 'checking';
        const html = render();

        expect(html).toContain(CHECKING_TEXT);
        expect(html).not.toContain(DENIED_TEXT);
    });

    it('遷移の全段階を通して 403 が現れない（管理者として確定するまで）', () => {
        const timeline: { label: string; apply: () => void }[] = [
            { label: '未ログイン', apply: () => { state.user = null; state.adminStatus = 'denied'; } },
            { label: '認証読み込み中', apply: () => { state.user = null; state.authLoading = true; state.adminStatus = 'checking'; } },
            { label: 'ログイン直後', apply: () => { state.user = { uid: 'admin-1' }; state.authLoading = false; state.adminStatus = 'checking'; } },
            { label: '判定確定', apply: () => { state.user = { uid: 'admin-1' }; state.adminStatus = 'allowed'; } },
        ];

        for (const step of timeline) {
            state.authLoading = false;
            step.apply();
            expect(render(), `${step.label} で 403 が出ている`).not.toContain(DENIED_TEXT);
        }
    });

    it('陰性統制: 本当に権限が無いときは 403 を出す', () => {
        // 上の錠が「常に 403 が出ない」だけを見ていないことの確認
        state.user = { uid: 'user-1' };
        state.adminStatus = 'denied';
        expect(render()).toContain(DENIED_TEXT);
    });
});

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * 遷移先は描画された HTML に出てこないため、Button の onClick を捕まえて実際に呼ぶ。
 * 押した結果どこへ行くかを錠にしないと、遷移先の変更が全緑のまま通る。
 */

const routerPush = vi.hoisted(() => vi.fn());
const captured = vi.hoisted(() => ({ buttons: [] as { label: string; onClick?: () => void }[] }));

vi.mock('@/components/ui/Button', () => ({
    Button: (props: { children?: React.ReactNode; onClick?: () => void }) => {
        captured.buttons.push({ label: String(props.children ?? ''), onClick: props.onClick });
        return null;
    },
    buttonClassName: () => '',
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'u1' }, loading: false }) }));
vi.mock('@/hooks/useAdmin', async () => {
    const { adminAccessResult } = await import('@/testUtils/hookResults');
    return { useAdmin: () => adminAccessResult('allowed') };
});
vi.mock('@/components/admin/AuditLogPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/SettingsPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/UsersPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/AudioFilesPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/SystemNotificationPanel', () => ({ default: () => null }));

const AdminPage = (await import('./page')).default;

beforeEach(() => {
    routerPush.mockClear();
    captured.buttons.length = 0;
});

describe('管理者画面の遷移先 (Y18)', () => {
    it('「ホームに戻る」は /home へ遷移する（/ 経由のリダイレクトを挟まない）', () => {
        renderToStaticMarkup(<AdminPage />);
        const goHome = captured.buttons.find(button => button.label === 'ホームに戻る');
        expect(goHome, '「ホームに戻る」ボタンが見つからない').toBeDefined();

        goHome!.onClick?.();
        expect(routerPush).toHaveBeenCalledWith('/home');
        expect(routerPush).not.toHaveBeenCalledWith('/');
    });
});

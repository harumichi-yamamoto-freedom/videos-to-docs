// @vitest-environment jsdom

/**
 * 未保存の設定を守る移動ガードの錠。
 * window.confirm ではなくダイアログ内確認で完結すること、キャンセルが移動を
 * 止めること、承諾が実際に移動することを実マウントで検査する。
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const routerPush = vi.hoisted(() => vi.fn());
const settingsStub = vi.hoisted(() => ({ dirty: false }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: { uid: 'admin-1' }, loading: false }),
}));
vi.mock('@/hooks/useAdmin', async () => {
    const { adminAccessResult } = await import('@/testUtils/hookResults');
    return { useAdmin: () => adminAccessResult('allowed') };
});
vi.mock('@/components/admin/AuditLogPanel', () => ({ default: () => <div>監査ログパネル</div> }));
vi.mock('@/components/admin/SettingsPanel', async () => {
    const ReactModule = await import('react');
    return {
        default: ReactModule.forwardRef(function SettingsPanelStub(_props, ref) {
            ReactModule.useImperativeHandle(ref, () => ({
                hasUnsavedChanges: () => settingsStub.dirty,
            }));
            return <div>設定パネルスタブ</div>;
        }),
    };
});
vi.mock('@/components/admin/UsersPanel', () => ({ default: () => <div>ユーザーパネル</div> }));
vi.mock('@/components/admin/AudioFilesPanel', () => ({ default: () => <div>音声パネル</div> }));
vi.mock('@/components/admin/SystemNotificationPanel', () => ({ default: () => <div>通知パネル</div> }));

import AdminPage from './page';

const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
);
const originalClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
);

function findButton(container: HTMLElement, name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
        candidate => candidate.textContent?.trim() === name
            && !candidate.closest('[inert]'),
    );
    if (!button) throw new Error(`button not found: ${name}`);
    return button;
}

describe('管理者画面の未保存ガード付き移動', () => {
    let container: HTMLDivElement;
    let root: Root;
    let confirmSpy: MockInstance<(message?: string) => boolean>;
    let alertSpy: MockInstance<(message?: string) => void>;

    beforeAll(() => {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
            configurable: true,
            value(this: HTMLDialogElement) {
                this.setAttribute('open', '');
            },
        });
        Object.defineProperty(HTMLDialogElement.prototype, 'close', {
            configurable: true,
            value(this: HTMLDialogElement) {
                if (!this.open) return;
                this.removeAttribute('open');
                queueMicrotask(() => {
                    this.dispatchEvent(new Event('close'));
                });
            },
        });
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterAll(() => {
        if (originalShowModal) {
            Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
        } else {
            delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
        }
        if (originalClose) {
            Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose);
        } else {
            delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
        }
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    beforeEach(() => {
        routerPush.mockClear();
        settingsStub.dirty = false;
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
        // 確認はダイアログ内で完結する。ネイティブの confirm()/alert() へ
        // 退行したらどのテストでもここで落ちる。
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
        alertSpy.mockRestore();
    });

    async function renderPage(): Promise<void> {
        await act(async () => {
            root.render(<AdminPage />);
        });
    }

    async function openSettingsTab(): Promise<void> {
        await act(async () => {
            findButton(container, 'システム設定').click();
        });
        expect(container.textContent).toContain('設定パネルスタブ');
    }

    function guardDialog(): HTMLDialogElement | null {
        return container.querySelector('dialog');
    }

    it('未保存の変更が無ければ確認を出さずにタブを移動する', async () => {
        await renderPage();
        await openSettingsTab();

        await act(async () => {
            findButton(container, 'ユーザー一覧').click();
        });

        expect(guardDialog()).toBeNull();
        expect(container.textContent).toContain('ユーザーパネル');
    });

    it('未保存の変更があるタブ移動はダイアログ内で確認し、まだ移動しない', async () => {
        await renderPage();
        await openSettingsTab();
        settingsStub.dirty = true;

        await act(async () => {
            findButton(container, '監査ログ').click();
        });

        const dialog = guardDialog();
        expect(dialog?.open).toBe(true);
        expect(dialog?.getAttribute('role')).toBe('alertdialog');
        expect(container.textContent).toContain('保存されていない変更があります');
        expect(container.textContent).toContain('保存せずに移動すると、変更した設定は失われます。');
        // 設定タブに留まっている（パネルはまだ設定のまま）。
        expect(container.textContent).toContain('設定パネルスタブ');
        // 安全な選択肢へ初期フォーカス。
        expect(document.activeElement).toBe(findButton(container, '編集を続ける'));
    });

    it('「編集を続ける」で移動を取りやめ、設定タブに留まる', async () => {
        await renderPage();
        await openSettingsTab();
        settingsStub.dirty = true;
        await act(async () => {
            findButton(container, '監査ログ').click();
        });

        await act(async () => {
            findButton(container, '編集を続ける').click();
        });

        expect(guardDialog()).toBeNull();
        expect(container.textContent).toContain('設定パネルスタブ');
        expect(container.textContent).not.toContain('監査ログパネル');
    });

    it('「変更を破棄して移動する」で実際にタブが切り替わる', async () => {
        await renderPage();
        await openSettingsTab();
        settingsStub.dirty = true;
        await act(async () => {
            findButton(container, '監査ログ').click();
        });

        await act(async () => {
            findButton(container, '変更を破棄して移動する').click();
        });

        expect(guardDialog()).toBeNull();
        expect(container.textContent).toContain('監査ログパネル');
        expect(container.textContent).not.toContain('設定パネルスタブ');
    });

    it('未保存の変更があるホーム遷移も確認を経由し、承諾で遷移・拒否で留まる', async () => {
        await renderPage();
        await openSettingsTab();
        settingsStub.dirty = true;

        await act(async () => {
            findButton(container, 'ホームに戻る').click();
        });
        expect(routerPush).not.toHaveBeenCalled();
        expect(container.textContent).toContain('保存せずにホームへ戻ると、変更した設定は失われます。');

        await act(async () => {
            findButton(container, '編集を続ける').click();
        });
        expect(routerPush).not.toHaveBeenCalled();
        expect(guardDialog()).toBeNull();

        await act(async () => {
            findButton(container, 'ホームに戻る').click();
        });
        await act(async () => {
            findButton(container, '変更を破棄してホームへ戻る').click();
        });

        expect(routerPush).toHaveBeenCalledWith('/home');
    });

    it('未保存の変更が無いホーム遷移は確認なしで遷移する', async () => {
        await renderPage();
        await openSettingsTab();

        await act(async () => {
            findButton(container, 'ホームに戻る').click();
        });

        expect(guardDialog()).toBeNull();
        expect(routerPush).toHaveBeenCalledWith('/home');
    });
});

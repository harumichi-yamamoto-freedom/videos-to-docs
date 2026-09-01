// @vitest-environment jsdom

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AddDefaultPromptsModal } from './AddDefaultPromptsModal';
import AuthModal from './AuthModal';
import { ContentEditModal } from './ContentEditModal';
import DisplayNameModal from './DisplayNameModal';
import { NotificationDetailModal } from './NotificationDetailModal';
import PasswordChangeModal from './PasswordChangeModal';
import ReauthModal from './ReauthModal';
import { PromptCreateModal } from './PromptCreateModal';
import { PromptEditModal } from './PromptEditModal';
import { AdminNotificationCreateModal } from './admin/AdminNotificationCreateModal';
import { AdminNotificationEditModal } from './admin/AdminNotificationEditModal';
import DefaultPromptEditModal from './admin/DefaultPromptEditModal';

vi.mock('@/lib/auth', () => ({
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
    updateUserDisplayName: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
    EmailAuthProvider: { credential: vi.fn() },
    GoogleAuthProvider: vi.fn(),
    reauthenticateWithCredential: vi.fn(),
    reauthenticateWithPopup: vi.fn(),
    updatePassword: vi.fn(),
}));

// ReauthModal only renders for a signed-in user, and picks its form from the
// provider list.
vi.mock('@/lib/firebase', () => ({
    auth: {
        currentUser: {
            uid: 'user-1',
            email: 'user@example.com',
            providerData: [{ providerId: 'password' }],
        },
    },
}));

vi.mock('@/lib/auditLog', () => ({
    logAudit: vi.fn(),
}));

vi.mock('@/lib/prompts', () => ({
    createPrompt: vi.fn(),
    updatePrompt: vi.fn(),
    deletePrompt: vi.fn(),
}));

vi.mock('@/lib/adminSettings', () => ({
    getAdminSettings: vi.fn(),
    updateAdminSettings: vi.fn(),
}));

vi.mock('@/lib/systemNotifications', () => ({
    createSystemNotification: vi.fn(async () => undefined),
    // The detail modal chains .catch() on this, so it must be thenable.
    dismissNotification: vi.fn(async () => undefined),
    undismissNotification: vi.fn(async () => undefined),
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: { uid: 'admin-uid' } }),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/**
 * Approved button surfaces. A surface is `bg-token` -> the text colours allowed
 * on it, and every entry carries its measured WCAG contrast ratio against the
 * Tailwind palette hex. Adding a token here is a deliberate act: measure the
 * ratio first and keep it at 4.5:1 or better.
 *
 * Rejected on measurement (do not re-add):
 *   bg-blue-500/white 3.68 · bg-green-600/white 3.30 · bg-gray-400/white 2.54
 */
const APPROVED_BUTTON_SURFACES: Record<string, readonly string[]> = {
    'bg-blue-600': ['text-white'], // 5.17:1
    'bg-blue-700': ['text-white'], // 6.70:1
    'bg-green-700': ['text-white'], // 5.02:1
    'bg-red-600': ['text-white'], // 4.83:1
    'bg-red-700': ['text-white'], // 6.47:1
    'bg-gray-700': ['text-white'], // 10.31:1
    'bg-gray-800': ['text-white'], // 14.68:1
    // Neutral surfaces keep the page background and carry dark text.
    // gray-600 7.56:1 · gray-700 10.31:1 · gray-800 14.68:1
    // purple-600 5.38:1 · blue-600 5.17:1
    'bg-white': [
        'text-gray-700',
        'text-gray-800',
        'text-gray-900',
        'text-purple-600',
        'text-blue-600',
        'text-gray-600',
    ],
};

/** Backgrounds that only ever apply while the control is disabled. */
const DISABLED_ONLY_BACKGROUNDS = new Set(['bg-gray-100', 'bg-gray-500']);

/** Classes which would shrink a control below the 44px touch target. */
const SHRINKING_CLASSES = [
    'h-8', 'h-9', 'h-10', 'min-h-8', 'min-h-9', 'min-h-10',
    'w-8', 'w-9', 'w-10', 'min-w-8', 'min-w-9', 'min-w-10',
];

const TALL_ENOUGH = ['min-h-11', 'h-11', 'min-h-12', 'h-12'];
const WIDE_ENOUGH = ['min-w-11', 'w-11', 'min-w-12', 'w-12', 'w-full', 'flex-1'];

const notification = {
    id: 'notification-id',
    title: 'お知らせ',
    body: '本文',
    severity: 'info' as const,
    published: true,
    publishedAt: new Date(0),
    publishedBy: 'admin-uid',
};

const prompt = {
    id: 'prompt-id',
    name: 'プロンプト',
    content: '本文',
    model: 'default',
    thinkingLevel: 'default' as const,
    isDefault: false,
    ownerType: 'user' as const,
    ownerId: 'owner-id',
    createdBy: 'owner-id',
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

const defaultPromptTemplate = {
    name: 'テンプレート',
    content: 'テンプレート本文',
    model: 'default',
    thinkingLevel: 'default' as const,
};

/**
 * Every modal which adopts the shared Dialog. `Dialogを使う全モーダルが表に載る`
 * keeps this in step with the filesystem, so a new modal cannot skip the
 * contrast, touch target and initial focus locks by not being listed here.
 */
const MODALS: readonly [string, React.ReactElement][] = [
    ['AuthModal', <AuthModal key="auth" isOpen onClose={vi.fn()} />],
    ['PasswordChangeModal', <PasswordChangeModal key="password" isOpen onClose={vi.fn()} />],
    ['PromptCreateModal', <PromptCreateModal key="create" isOpen onClose={vi.fn()} onSave={vi.fn()} />],
    ['DisplayNameModal', <DisplayNameModal key="display" isOpen onClose={vi.fn()} />],
    [
        'ContentEditModal',
        <ContentEditModal
            key="content"
            isOpen
            onClose={vi.fn()}
            title="タイトル"
            content="本文"
            onSave={vi.fn()}
            onDelete={vi.fn()}
        />,
    ],
    [
        'PromptEditModal',
        <PromptEditModal
            key="prompt-edit"
            isOpen
            onClose={vi.fn()}
            prompt={prompt}
            onSave={vi.fn()}
            onDelete={vi.fn()}
        />,
    ],
    [
        'AddDefaultPromptsModal',
        <AddDefaultPromptsModal
            key="add-defaults"
            isOpen
            onClose={vi.fn()}
            onAdd={vi.fn()}
            templates={[defaultPromptTemplate]}
        />,
    ],
    [
        'NotificationDetailModal',
        <NotificationDetailModal
            key="detail"
            isOpen
            onClose={vi.fn()}
            notification={notification}
            isDismissed={false}
        />,
    ],
    [
        'AdminNotificationCreateModal',
        <AdminNotificationCreateModal key="admin-create" isOpen onClose={vi.fn()} />,
    ],
    [
        'AdminNotificationEditModal',
        <AdminNotificationEditModal
            key="admin-edit"
            isOpen
            onClose={vi.fn()}
            notification={notification}
        />,
    ],
    [
        'ReauthModal',
        <ReauthModal key="reauth" isOpen onClose={vi.fn()} onSuccess={vi.fn()} />,
    ],
    [
        'DefaultPromptEditModal',
        <DefaultPromptEditModal
            key="default-prompt"
            isOpen
            onClose={vi.fn()}
            prompt={defaultPromptTemplate}
            onSave={vi.fn()}
            onDelete={vi.fn()}
            mode="edit"
        />,
    ],
];

/**
 * Modals which deliberately do not use the shared Dialog yet. Each entry needs
 * a reason, and disappears as the modal migrates.
 */
const NOT_ON_SHARED_DIALOG: Record<string, string> = {};

function buttonsOf(element: React.ReactElement): HTMLButtonElement[] {
    const template = document.createElement('template');
    template.innerHTML = renderToStaticMarkup(element);
    const buttons = Array.from(
        template.content.querySelectorAll<HTMLButtonElement>('button'),
    );
    if (buttons.length === 0) throw new Error('no button rendered');
    return buttons;
}

function describeButton(button: HTMLButtonElement): string {
    const label = button.getAttribute('aria-label')
        ?? button.textContent?.trim()
        ?? '(no label)';
    return `${label || '(empty)'} [${button.className}]`;
}

function backgroundTokens(button: HTMLButtonElement): string[] {
    // Anything which paints the button surface counts, including tokens the
    // allowlist has never seen: bg-black, arbitrary values, opacity suffixes
    // and gradient stops all have to be measured before they may be used.
    return Array.from(button.classList).filter(token => (
        /^bg-/.test(token)
        || /^(from|via|to)-/.test(token)
    ) && !/^bg-(transparent|inherit|current|none)$/.test(token));
}

function textTokens(button: HTMLButtonElement): string[] {
    return Array.from(button.classList).filter(
        token => token === 'text-white' || /^text-[a-z]+-\d+$/.test(token),
    );
}

/**
 * True when nothing readable is left after dropping icons and decorative
 * glyphs, i.e. the control is only as wide as its icon and needs the width
 * check. A `<span aria-hidden>✕</span>` counts as an icon, not as a label.
 */
function isIconOnly(button: HTMLButtonElement): boolean {
    const clone = button.cloneNode(true) as HTMLButtonElement;
    for (const decorative of clone.querySelectorAll('svg, [aria-hidden="true"]')) {
        decorative.remove();
    }
    return !clone.textContent?.trim();
}

describe('モーダルCTAのコントラスト許可リスト', () => {
    it.each(MODALS)('%s の全ボタンが検証済みの配色トークンだけを使う', (_name, element) => {
        for (const button of buttonsOf(element)) {
            const backgrounds = backgroundTokens(button)
                .filter(token => !DISABLED_ONLY_BACKGROUNDS.has(token));
            // A button without its own background sits on the modal's white
            // surface, so its text colour is judged against that.
            const surfaces = backgrounds.length > 0 ? backgrounds : ['bg-white'];

            for (const background of surfaces) {
                const allowedText = APPROVED_BUTTON_SURFACES[background];
                expect(
                    allowedText,
                    `未検証の背景トークン ${background}: ${describeButton(button)}`,
                ).toBeDefined();

                for (const colour of textTokens(button)) {
                    expect(
                        allowedText,
                        `${background} に未許可の文字色 ${colour}: ${describeButton(button)}`,
                    ).toContain(colour);
                }
            }
        }
    });

    it('許可リストは測定で落ちた低コントラストのトークンを含まない', () => {
        for (const rejected of ['bg-blue-500', 'bg-green-600', 'bg-gray-400']) {
            expect(APPROVED_BUTTON_SURFACES).not.toHaveProperty(rejected);
        }
    });
});

describe('モーダル操作対象の44pxタップ標的', () => {
    it.each(MODALS)('%s の全ボタンが44px以上の高さを保つ', (_name, element) => {
        for (const button of buttonsOf(element)) {
            const classes = Array.from(button.classList);
            expect(
                TALL_ENOUGH.some(token => classes.includes(token)),
                `高さ44px未満の可能性: ${describeButton(button)}`,
            ).toBe(true);

            for (const shrinking of SHRINKING_CLASSES) {
                expect(
                    classes,
                    `縮小クラス ${shrinking} が付いています: ${describeButton(button)}`,
                ).not.toContain(shrinking);
            }
        }
    });

    it.each(MODALS)('%s のアイコンだけのボタンが44px以上の幅を保つ', (_name, element) => {
        for (const button of buttonsOf(element)) {
            if (!isIconOnly(button)) continue;

            const classes = Array.from(button.classList);
            expect(
                WIDE_ENOUGH.some(token => classes.includes(token)),
                `幅44px未満の可能性: ${describeButton(button)}`,
            ).toBe(true);
        }
    });
});

const COMPONENT_DIRECTORIES = ['.', 'admin'];

function modalFileNames(): string[] {
    const componentsDir = join(process.cwd(), 'src', 'components');
    return COMPONENT_DIRECTORIES.flatMap(directory => readdirSync(join(componentsDir, directory))
        .filter(name => name.endsWith('Modal.tsx')));
}

describe('モーダル一覧の網羅', () => {
    it('Dialogを使う全モーダルが表に載っている', () => {
        const listed = new Set(MODALS.map(([name]) => `${name}.tsx`));
        const missing = modalFileNames().filter(
            fileName => !listed.has(fileName) && !(fileName in NOT_ON_SHARED_DIALOG),
        );

        expect(
            missing,
            `MODALSにもNOT_ON_SHARED_DIALOGにも無いモーダル: ${missing.join(', ')}`,
        ).toEqual([]);
    });

    it('除外リストは実在のモーダルだけを理由付きで挙げる', () => {
        const existing = new Set(modalFileNames());
        for (const [fileName, reason] of Object.entries(NOT_ON_SHARED_DIALOG)) {
            expect(existing, `存在しないモーダルの除外: ${fileName}`).toContain(fileName);
            expect(reason.length, `${fileName} の除外理由が空`).toBeGreaterThan(0);
        }
    });

    it('表に載るモーダルは実在のファイルと対応する', () => {
        const existing = new Set(modalFileNames());
        for (const [name] of MODALS) {
            expect(existing, `MODALSの項目に対応するファイルが無い: ${name}`)
                .toContain(`${name}.tsx`);
        }
    });
});

describe('モーダルの初期フォーカス', () => {
    let container: HTMLDivElement;
    let root: Root;

    const originalShowModal = Object.getOwnPropertyDescriptor(
        HTMLDialogElement.prototype,
        'showModal',
    );
    const originalClose = Object.getOwnPropertyDescriptor(
        HTMLDialogElement.prototype,
        'close',
    );

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

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    afterAll(() => {
        if (originalShowModal) {
            Object.defineProperty(
                HTMLDialogElement.prototype,
                'showModal',
                originalShowModal,
            );
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

    it.each(MODALS)('%s は開いた直後のfocusをダイアログ内へ置く', async (_name, element) => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        const outsideButton = document.createElement('button');
        outsideButton.type = 'button';
        document.body.appendChild(outsideButton);
        outsideButton.focus();

        await act(async () => {
            root.render(element);
        });

        const dialog = container.querySelector('dialog');
        expect(dialog).not.toBeNull();
        expect(dialog?.open).toBe(true);
        expect(
            dialog?.contains(document.activeElement),
            `初期フォーカスがダイアログ外です: ${(document.activeElement as HTMLElement)?.tagName}`,
        ).toBe(true);

        outsideButton.remove();
    });
});

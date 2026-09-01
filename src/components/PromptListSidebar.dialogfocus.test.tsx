// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/prompts';
import { PromptListSidebar } from './PromptListSidebar';

const { getPrompts } = vi.hoisted(() => ({
    getPrompts: vi.fn(),
}));

vi.mock('@/lib/prompts', () => ({
    addDefaultPrompts: vi.fn(),
    deletePrompt: vi.fn(),
    getPrompts,
    initializeDefaultPrompts: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ user: { uid: 'owner-id' }, loading: false }),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/lib/adminSettings', () => ({
    getDefaultPrompts: vi.fn(),
}));

vi.mock('./AddDefaultPromptsModal', () => ({
    AddDefaultPromptsModal: () => null,
}));

const prompt: Prompt = {
    id: 'prompt-id',
    name: '削除対象プロンプト',
    content: '本文',
    model: 'default',
    isDefault: false,
    ownerType: 'user',
    ownerId: 'owner-id',
    createdBy: 'owner-id',
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

describe('PromptListSidebar', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        vi.useFakeTimers();
        getPrompts.mockReset();
        getPrompts.mockResolvedValue([prompt]);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.useRealTimers();
    });

    afterAll(() => {
        (
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    it('削除ボタンの実ヒット領域を44px以上にする', async () => {
        await act(async () => {
            root.render(
                <PromptListSidebar
                    onPromptClick={vi.fn()}
                    onCreateClick={vi.fn()}
                />,
            );
        });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const deleteButton = container.querySelector<HTMLButtonElement>(
            'button[title="削除"]',
        );

        expect(deleteButton).not.toBeNull();
        expect(deleteButton?.classList.contains('min-h-11')).toBe(true);
        expect(deleteButton?.classList.contains('min-w-11')).toBe(true);
        expect(deleteButton?.classList.contains('p-2')).toBe(false);
    });
});

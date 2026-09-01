import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/prompts';

const reactHarness = vi.hoisted(() => ({
    stateCursor: 0,
    stateValues: [] as unknown[],
}));

const serviceMocks = vi.hoisted(() => ({
    getPrompts: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock('react', () => ({
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: () => undefined,
    useRef: <T>(initialValue: T) => ({ current: initialValue }),
    useState: <T>(initialValue: T) => {
        const stateIndex = reactHarness.stateCursor;
        reactHarness.stateCursor += 1;
        reactHarness.stateValues[stateIndex] = initialValue;

        const setState = (nextValue: T | ((current: T) => T)) => {
            const currentValue = reactHarness.stateValues[stateIndex] as T;
            reactHarness.stateValues[stateIndex] = typeof nextValue === 'function'
                ? (nextValue as (current: T) => T)(currentValue)
                : nextValue;
        };

        return [reactHarness.stateValues[stateIndex] as T, setState] as const;
    },
}));

vi.mock('@/lib/prompts', () => ({ getPrompts: serviceMocks.getPrompts }));
vi.mock('./useAuth', () => ({ useAuth: serviceMocks.useAuth }));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { usePromptManagement } from './usePromptManagement';

const createPrompt = (id: string): Prompt => ({
    id,
    name: `プロンプト ${id}`,
    content: 'content',
    model: 'gemini-test',
    isDefault: false,
    ownerType: 'user',
    ownerId: 'user-1',
    createdBy: 'user-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
});

beforeEach(() => {
    reactHarness.stateCursor = 0;
    reactHarness.stateValues = [];
    vi.clearAllMocks();
    serviceMocks.useAuth.mockReturnValue({ user: { uid: 'user-1' }, loading: false });
    serviceMocks.getPrompts.mockResolvedValue([createPrompt('prompt-a')]);
});

describe('usePromptManagement auth gating (V5)', () => {
    it('reports loading while authentication is still resolving', () => {
        serviceMocks.useAuth.mockReturnValue({ user: null, loading: true });

        const hook = usePromptManagement();

        // 認証が未解決の間は「プロンプトが無い」と確定させない
        expect(hook.status).toBe('loading');
        expect(hook.availablePrompts).toEqual([]);
        expect(hook.error).toBeNull();
    });

    it('reports loading before the first fetch for a resolved user settles', () => {
        const hook = usePromptManagement();

        expect(hook.status).toBe('loading');
    });
});

describe('usePromptManagement failure handling (V5/H10)', () => {
    it('surfaces the error and keeps retry available instead of reporting an empty list', async () => {
        serviceMocks.getPrompts.mockRejectedValue(new Error('network down'));

        const hook = usePromptManagement();
        const result = await hook.retry();

        expect(result).toBeNull();
        // 取得失敗を空配列の成功として扱わない
        const stored = reactHarness.stateValues[0] as {
            status: string;
            error: string | null;
            prompts: Prompt[];
        };
        expect(stored.status).toBe('error');
        expect(stored.error).toBe('network down');
        expect(stored.prompts).toEqual([]);
    });

    it('does not throw out of retry so the caller can wire it to a button', async () => {
        serviceMocks.getPrompts.mockRejectedValue(new Error('network down'));

        const hook = usePromptManagement();

        await expect(hook.retry()).resolves.toBeNull();
    });

    it('returns the prompts on a successful retry', async () => {
        const hook = usePromptManagement();

        await expect(hook.retry()).resolves.toHaveLength(1);
        expect((reactHarness.stateValues[0] as { status: string }).status).toBe('success');
    });
});

// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from 'firebase/auth';

const mocks = vi.hoisted(() => ({
    fetchSubordinateRelationships: vi.fn(),
    fetchSupervisorRelationships: vi.fn(),
    requestSupervisorRelationship: vi.fn(),
    approveRelationship: vi.fn(),
    rejectRelationship: vi.fn(),
    removeSubordinate: vi.fn(),
    cancelRelationshipAsSubordinate: vi.fn(),
    getPromptsByOwnerId: vi.fn(),
    getTranscriptionsByOwnerId: vi.fn(),
}));

/* relationships は isLegacyRelationship / buildRelationshipId を実物のまま使いたいので
   importOriginal で実装を残し、Firestore へ触る関数だけ差し替える。
   実モジュールの評価が firebase 初期化へ届かないよう、依存側もスタブする。 */
vi.mock('firebase/firestore', () => ({
    collection: vi.fn(() => ({})),
    doc: vi.fn(() => ({})),
    query: vi.fn(() => ({})),
    where: vi.fn(() => ({})),
    getDocs: vi.fn(),
    getDoc: vi.fn(),
    setDoc: vi.fn(),
    updateDoc: vi.fn(),
    deleteDoc: vi.fn(),
    onSnapshot: vi.fn(),
    serverTimestamp: vi.fn(),
    Timestamp: class {},
}));
vi.mock('@/lib/firebase', () => ({ db: {} }));
vi.mock('@/lib/userManagement', () => ({
    getUserByEmail: vi.fn(),
    getUserProfile: vi.fn(),
}));

vi.mock('@/lib/relationships', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/relationships')>();
    return {
        ...actual,
        fetchSubordinateRelationships: mocks.fetchSubordinateRelationships,
        fetchSupervisorRelationships: mocks.fetchSupervisorRelationships,
        requestSupervisorRelationship: mocks.requestSupervisorRelationship,
        approveRelationship: mocks.approveRelationship,
        rejectRelationship: mocks.rejectRelationship,
        removeSubordinate: mocks.removeSubordinate,
        cancelRelationshipAsSubordinate: mocks.cancelRelationshipAsSubordinate,
    };
});

vi.mock('@/lib/prompts', () => ({
    getPromptsByOwnerId: mocks.getPromptsByOwnerId,
}));

vi.mock('@/lib/firestore', () => ({
    getTranscriptionsByOwnerId: mocks.getTranscriptionsByOwnerId,
}));

vi.mock('@/components/AuthModal', async () => {
    const ReactModule = await import('react');
    return {
        default: ({ isOpen }: { isOpen: boolean }) =>
            ReactModule.createElement('div', { 'data-testid': 'auth-modal', 'data-open': String(isOpen) }),
    };
});

vi.mock('@/components/ContentEditModal', () => ({
    ContentEditModal: () => null,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { TeamPanel } from './TeamPanel';
import { buildRelationshipId, type Relationship } from '@/lib/relationships';
import type { Prompt } from '@/lib/prompts';
import type { Transcription } from '@/lib/firestore';

const bossUser = { uid: 'boss-uid', email: 'boss@example.com' } as unknown as User;

function makeRelationship(overrides: Partial<Relationship> & { supervisorId: string; subordinateId: string }): Relationship {
    const base: Relationship = {
        id: buildRelationshipId(overrides.supervisorId, overrides.subordinateId),
        supervisorId: overrides.supervisorId,
        supervisorEmail: 'boss@example.com',
        supervisorName: '上司 太郎',
        subordinateId: overrides.subordinateId,
        subordinateEmail: `${overrides.subordinateId}@example.com`,
        subordinateName: `部下 ${overrides.subordinateId}`,
        status: 'approved',
        createdAt: null,
        updatedAt: null,
    };
    return { ...base, ...overrides };
}

function makePrompt(name: string, ownerId: string): Prompt {
    return {
        id: `prompt-${name}`,
        name,
        content: `${name} の内容`,
        model: 'gemini-test',
        isDefault: false,
        ownerType: 'user',
        ownerId,
        createdBy: ownerId,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T00:00:00Z'),
    };
}

function makeTranscription(title: string): Transcription {
    return {
        id: `doc-${title}`,
        title,
        fileName: `${title}.wav`,
        text: '本文',
        promptName: '議事録',
        createdAt: new Date('2026-09-01T00:00:00Z'),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`button not found: ${name}`);
    return button;
}

/** 見出しテキストからカード(bg-white の枠)を特定する。 */
function findCard(container: HTMLElement, heading: string): HTMLElement {
    const headingElement = Array.from(container.querySelectorAll('h3, h4')).find(
        (candidate) => candidate.textContent?.trim() === heading,
    );
    if (!headingElement) throw new Error(`card heading not found: ${heading}`);
    const card = headingElement.closest('.bg-white');
    if (!card) throw new Error(`card not found for heading: ${heading}`);
    return card as HTMLElement;
}

describe('TeamPanel', () => {
    let container: HTMLDivElement;
    let root: Root;
    let alertSpy: ReturnType<typeof vi.spyOn>;
    let scrollSpy: ReturnType<typeof vi.fn>;
    let mediaMatches: boolean;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.fetchSubordinateRelationships.mockResolvedValue([]);
        mocks.fetchSupervisorRelationships.mockResolvedValue([]);
        mocks.getPromptsByOwnerId.mockResolvedValue([]);
        mocks.getTranscriptionsByOwnerId.mockResolvedValue([]);

        mediaMatches = true;
        window.matchMedia = vi.fn((query: string) => ({
            matches: mediaMatches,
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(() => false),
        })) as unknown as typeof window.matchMedia;

        scrollSpy = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollSpy,
        });

        alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        vi.spyOn(window, 'confirm').mockImplementation(() => true);

        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.restoreAllMocks();
    });

    async function renderPanel(props: Partial<React.ComponentProps<typeof TeamPanel>> = {}) {
        await act(async () => {
            root.render(<TeamPanel user={bossUser} view="subordinates" {...props} />);
        });
    }

    describe('T3: レーン独立の取得と失敗表示', () => {
        it('1レーンの失敗が他レーンを道連れにせず、失敗は画面内に出る(alertなし)', async () => {
            const pendingRel = makeRelationship({
                supervisorId: 'boss-uid',
                subordinateId: 'member-1',
                status: 'pending',
            });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (_uid: string, status?: string) =>
                    status === 'approved'
                        ? Promise.reject(new Error('network down'))
                        : Promise.resolve([pendingRel]),
            );

            await renderPanel();

            const subordinatesCard = findCard(container, '部下一覧');
            expect(subordinatesCard.textContent).toContain('部下一覧の取得に失敗しました。');
            expect(findButton(subordinatesCard, '再試行')).toBeTruthy();

            const requestsCard = findCard(container, '申請一覧');
            expect(requestsCard.textContent).toContain('部下 member-1');

            expect(alertSpy).not.toHaveBeenCalled();
        });

        it('再試行は失敗したレーンだけを再取得する', async () => {
            let approvedShouldFail = true;
            const approvedRel = makeRelationship({ supervisorId: 'boss-uid', subordinateId: 'member-1' });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (_uid: string, status?: string) => {
                    if (status === 'approved') {
                        return approvedShouldFail
                            ? Promise.reject(new Error('network down'))
                            : Promise.resolve([approvedRel]);
                    }
                    return Promise.resolve([]);
                },
            );

            await renderPanel();
            const approvedCallsBefore = mocks.fetchSubordinateRelationships.mock.calls.filter(
                (call) => call[1] === 'approved',
            ).length;
            const pendingCallsBefore = mocks.fetchSubordinateRelationships.mock.calls.filter(
                (call) => call[1] === 'pending',
            ).length;

            approvedShouldFail = false;
            await act(async () => {
                findButton(findCard(container, '部下一覧'), '再試行').click();
            });

            const approvedCallsAfter = mocks.fetchSubordinateRelationships.mock.calls.filter(
                (call) => call[1] === 'approved',
            ).length;
            const pendingCallsAfter = mocks.fetchSubordinateRelationships.mock.calls.filter(
                (call) => call[1] === 'pending',
            ).length;

            expect(approvedCallsAfter).toBe(approvedCallsBefore + 1);
            expect(pendingCallsAfter).toBe(pendingCallsBefore);
            expect(findCard(container, '部下一覧').textContent).toContain('部下 member-1');
        });

        it('操作の失敗も画面内エラーで通知する(alertなし)', async () => {
            const pendingRel = makeRelationship({
                supervisorId: 'boss-uid',
                subordinateId: 'member-1',
                status: 'pending',
            });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (_uid: string, status?: string) =>
                    Promise.resolve(status === 'pending' ? [pendingRel] : []),
            );
            mocks.approveRelationship.mockRejectedValue(new Error('denied'));

            await renderPanel();
            await act(async () => {
                findButton(findCard(container, '申請一覧'), '追加').click();
            });

            expect(findCard(container, '申請一覧').textContent).toContain('申請の承認に失敗しました');
            expect(alertSpy).not.toHaveBeenCalled();
        });
    });

    describe('T3: 世代照合', () => {
        it('部下Aの遅い応答は、部下Bへ切替後の詳細に描画されない', async () => {
            const relA = makeRelationship({ supervisorId: 'boss-uid', subordinateId: 'member-a' });
            const relB = makeRelationship({ supervisorId: 'boss-uid', subordinateId: 'member-b' });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (_uid: string, status?: string) =>
                    Promise.resolve(status === 'approved' ? [relA, relB] : []),
            );

            const slowPromptsForA = deferred<Prompt[]>();
            mocks.getPromptsByOwnerId.mockImplementation((ownerId: string) =>
                ownerId === 'member-a'
                    ? slowPromptsForA.promise
                    : Promise.resolve([makePrompt('B専用プロンプト', 'member-b')]),
            );

            await renderPanel();

            const subordinatesCard = findCard(container, '部下一覧');
            const itemA = Array.from(subordinatesCard.querySelectorAll('p')).find(
                (p) => p.textContent === '部下 member-a',
            );
            const itemB = Array.from(subordinatesCard.querySelectorAll('p')).find(
                (p) => p.textContent === '部下 member-b',
            );
            if (!itemA || !itemB) throw new Error('subordinate items not found');

            await act(async () => {
                (itemA.closest('.group') as HTMLElement).click();
            });
            await act(async () => {
                (itemB.closest('.group') as HTMLElement).click();
            });

            await act(async () => {
                slowPromptsForA.resolve([makePrompt('A専用プロンプト', 'member-a')]);
            });

            const detailHeading = Array.from(container.querySelectorAll('h3')).find(
                (h) => h.textContent === '部下 member-b',
            );
            expect(detailHeading).toBeTruthy();
            expect(container.textContent).toContain('B専用プロンプト');
            expect(container.textContent).not.toContain('A専用プロンプト');
        });

        it('旧UIDの遅い応答は、UID切替後の一覧に描画されない', async () => {
            const oldUser = { uid: 'old-uid', email: 'old@example.com' } as unknown as User;
            const newUser = { uid: 'new-uid', email: 'new@example.com' } as unknown as User;
            const oldRel = makeRelationship({ supervisorId: 'old-uid', subordinateId: 'old-member' });
            const newRel = makeRelationship({ supervisorId: 'new-uid', subordinateId: 'new-member' });

            const slowApprovedForOld = deferred<Relationship[]>();
            mocks.fetchSubordinateRelationships.mockImplementation(
                (uid: string, status?: string) => {
                    if (status !== 'approved') return Promise.resolve([]);
                    return uid === 'old-uid' ? slowApprovedForOld.promise : Promise.resolve([newRel]);
                },
            );

            await renderPanel({ user: oldUser });
            await renderPanel({ user: newUser });

            await act(async () => {
                slowApprovedForOld.resolve([oldRel]);
            });

            const subordinatesCard = findCard(container, '部下一覧');
            expect(subordinatesCard.textContent).toContain('部下 new-member');
            expect(subordinatesCard.textContent).not.toContain('部下 old-member');
        });

        it('操作後の再取得もUID切替の世代照合を通す(旧closure経由で旧uidを再取得しない)', async () => {
            const oldUser = { uid: 'old-uid', email: 'old@example.com' } as unknown as User;
            const newUser = { uid: 'new-uid', email: 'new@example.com' } as unknown as User;
            const oldApproved = makeRelationship({ supervisorId: 'old-uid', subordinateId: 'old-member' });
            const oldPending = makeRelationship({
                supervisorId: 'old-uid',
                subordinateId: 'old-requester',
                status: 'pending',
            });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (uid: string, status?: string) => {
                    if (uid === 'old-uid') {
                        return Promise.resolve(status === 'approved' ? [oldApproved] : [oldPending]);
                    }
                    return Promise.resolve([]);
                },
            );
            const approveGate = deferred<void>();
            mocks.approveRelationship.mockReturnValue(approveGate.promise);

            await renderPanel({ user: oldUser });
            await act(async () => {
                findButton(findCard(container, '申請一覧'), '追加').click();
            });

            await renderPanel({ user: newUser });
            const oldUidCallsBefore = mocks.fetchSubordinateRelationships.mock.calls.filter(
                (call) => call[0] === 'old-uid',
            ).length;

            await act(async () => {
                approveGate.resolve();
            });

            const oldUidCallsAfter = mocks.fetchSubordinateRelationships.mock.calls.filter(
                (call) => call[0] === 'old-uid',
            ).length;
            expect(oldUidCallsAfter).toBe(oldUidCallsBefore);
            expect(findCard(container, '部下一覧').textContent).not.toContain('部下 old-member');
        });
    });

    describe('T4: 未ログインゲート', () => {
        it('ログインCTAからゲートカード内の AuthModal を開ける', async () => {
            await renderPanel({ user: null, authLoading: false });

            expect(container.textContent).toContain('チーム機能を利用するにはログインしてください。');
            const authModal = container.querySelector('[data-testid="auth-modal"]');
            expect(authModal?.getAttribute('data-open')).toBe('false');

            await act(async () => {
                findButton(container, 'ログイン / アカウント作成').click();
            });

            expect(
                container.querySelector('[data-testid="auth-modal"]')?.getAttribute('data-open'),
            ).toBe('true');
        });

        it('認証状態の確定前はログイン誘導を出さず待機表示にする', async () => {
            await renderPanel({ user: null, authLoading: true });

            expect(container.textContent).toContain('ログイン状態を確認しています');
            expect(container.textContent).not.toContain('チーム機能を利用するにはログインしてください。');
        });
    });

    describe('T5: モバイルの詳細誘導', () => {
        async function selectFirstSubordinate() {
            const rel = makeRelationship({ supervisorId: 'boss-uid', subordinateId: 'member-1' });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (_uid: string, status?: string) =>
                    Promise.resolve(status === 'approved' ? [rel] : []),
            );
            await renderPanel();
            const subordinatesCard = findCard(container, '部下一覧');
            const item = Array.from(subordinatesCard.querySelectorAll('p')).find(
                (p) => p.textContent === '部下 member-1',
            );
            if (!item) throw new Error('subordinate item not found');
            await act(async () => {
                (item.closest('.group') as HTMLElement).click();
            });
        }

        it('xl未満では部下選択で詳細見出しへスクロールしフォーカスを移す', async () => {
            mediaMatches = false;
            await selectFirstSubordinate();

            expect(scrollSpy).toHaveBeenCalledTimes(1);
            const detailHeading = Array.from(container.querySelectorAll('h3')).find(
                (h) => h.textContent === '部下 member-1',
            );
            expect(detailHeading).toBeTruthy();
            expect(document.activeElement).toBe(detailHeading);
        });

        it('xl以上(一覧と詳細が並ぶ)ではスクロールしない', async () => {
            mediaMatches = true;
            await selectFirstSubordinate();

            expect(scrollSpy).not.toHaveBeenCalled();
        });
    });

    describe('旧形式(ランダムID)の関係への誘導', () => {
        it('旧形式の部下には閲覧不可の説明を出す', async () => {
            const legacyRel = makeRelationship({
                supervisorId: 'boss-uid',
                subordinateId: 'member-1',
                id: 'legacyRandomId123',
            });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (_uid: string, status?: string) =>
                    Promise.resolve(status === 'approved' ? [legacyRel] : []),
            );

            await renderPanel();

            expect(findCard(container, '部下一覧').textContent).toContain('旧形式の登録のため');
        });

        it('旧形式の申請は承認ボタンを無効化する', async () => {
            const legacyPending = makeRelationship({
                supervisorId: 'boss-uid',
                subordinateId: 'member-1',
                id: 'legacyRandomId456',
                status: 'pending',
            });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (_uid: string, status?: string) =>
                    Promise.resolve(status === 'pending' ? [legacyPending] : []),
            );

            await renderPanel();

            const requestsCard = findCard(container, '申請一覧');
            expect(findButton(requestsCard, '追加').disabled).toBe(true);
            expect(requestsCard.textContent).toContain('旧形式の申請のため承認できません');
        });

        it('旧形式の部下を選択しても詳細取得を行わず、行き止まりの代わりに説明を出す', async () => {
            const legacyRel = makeRelationship({
                supervisorId: 'boss-uid',
                subordinateId: 'member-1',
                id: 'legacyRandomId789',
            });
            mocks.fetchSubordinateRelationships.mockImplementation(
                (_uid: string, status?: string) =>
                    Promise.resolve(status === 'approved' ? [legacyRel] : []),
            );

            await renderPanel();
            const subordinatesCard = findCard(container, '部下一覧');
            const item = Array.from(subordinatesCard.querySelectorAll('p')).find(
                (p) => p.textContent === '部下 member-1',
            );
            if (!item) throw new Error('subordinate item not found');
            await act(async () => {
                (item.closest('.group') as HTMLElement).click();
            });

            expect(mocks.getPromptsByOwnerId).not.toHaveBeenCalled();
            expect(mocks.getTranscriptionsByOwnerId).not.toHaveBeenCalled();
            expect(container.textContent).toContain(
                'この部下は旧形式で登録されているため、記録を閲覧できません',
            );
            expect(container.textContent).not.toContain('プロンプト一覧');
        });
    });
});

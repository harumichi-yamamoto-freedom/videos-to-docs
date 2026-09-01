import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StateAction<T> = T | ((previous: T) => T);
type Effect = () => void | (() => void);

interface HookAdapter {
    useEffect(effect: Effect, dependencies?: readonly unknown[]): void;
    useRef<T>(initialValue: T): { current: T };
    useState<T>(initialValue: T | (() => T)): [T, (action: StateAction<T>) => void];
}

const mountedHook = vi.hoisted(() => ({
    current: null as HookAdapter | null,
}));

const mocks = vi.hoisted(() => {
    interface FakeDocumentReference {
        readonly collectionName: string;
        readonly id: string;
        readonly path: string;
    }

    interface FakeDocument {
        readonly id: string;
        readonly ref: FakeDocumentReference;
        readonly data: Record<string, unknown>;
    }

    interface FakeCollection {
        readonly type: 'collection';
        readonly name: string;
    }

    interface FakeWhere {
        readonly type: 'where';
        readonly field: string;
        readonly value: unknown;
    }

    interface FakeQuery {
        readonly type: 'query';
        readonly collection: FakeCollection;
        readonly constraints: readonly FakeWhere[];
    }

    const database = { name: 'integration-firestore' };
    const auth = { currentUser: null as {
        uid: string;
        email: string | null;
        getIdToken: ReturnType<typeof vi.fn>;
        delete: ReturnType<typeof vi.fn>;
    } | null };
    const documents = new Map<string, Map<string, FakeDocument>>();
    const batches: Array<{
        readonly number: number;
        readonly refs: FakeDocumentReference[];
        readonly delete: ReturnType<typeof vi.fn>;
        readonly commit: ReturnType<typeof vi.fn>;
    }> = [];
    const events: string[] = [];
    let failedSecondBatch = false;

    function addDocument(
        collectionName: string,
        id: string,
        data: Record<string, unknown>,
    ) {
        let collectionDocuments = documents.get(collectionName);
        if (!collectionDocuments) {
            collectionDocuments = new Map();
            documents.set(collectionName, collectionDocuments);
        }
        const ref: FakeDocumentReference = {
            collectionName,
            id,
            path: `${collectionName}/${id}`,
        };
        collectionDocuments.set(id, { id, ref, data });
    }

    function resetData() {
        documents.clear();
        batches.length = 0;
        events.length = 0;
        failedSecondBatch = false;
        for (let index = 0; index < 450; index += 1) {
            addDocument('prompts', `prompt-${String(index).padStart(3, '0')}`, {
                ownerId: 'user-1',
            });
        }
        addDocument('users', 'user-1', { email: 'user@example.com' });
    }

    const collection = vi.fn((_: unknown, name: string): FakeCollection => ({
        type: 'collection',
        name,
    }));
    const where = vi.fn((field: string, _operator: string, value: unknown): FakeWhere => ({
        type: 'where',
        field,
        value,
    }));
    const query = vi.fn((
        collectionReference: FakeCollection,
        ...constraints: FakeWhere[]
    ): FakeQuery => ({
        type: 'query',
        collection: collectionReference,
        constraints,
    }));
    const doc = vi.fn((_: unknown, collectionName: string, id: string): FakeDocumentReference => ({
        collectionName,
        id,
        path: `${collectionName}/${id}`,
    }));
    const getDocs = vi.fn((source: FakeQuery | FakeCollection) => {
        const collectionReference = source.type === 'query' ? source.collection : source;
        const constraints = source.type === 'query' ? source.constraints : [];
        const matchingDocuments = [...(documents.get(collectionReference.name)?.values() ?? [])]
            .filter(documentSnapshot => constraints.every(constraint => (
                documentSnapshot.data[constraint.field] === constraint.value
            )));
        events.push(`scan:${collectionReference.name}:${matchingDocuments.length}`);
        return Promise.resolve({
            size: matchingDocuments.length,
            docs: matchingDocuments,
        });
    });
    const writeBatch = vi.fn(() => {
        const batchNumber = batches.length + 1;
        const refs: FakeDocumentReference[] = [];
        const batch = {
            number: batchNumber,
            refs,
            delete: vi.fn((reference: FakeDocumentReference) => {
                refs.push(reference);
            }),
            commit: vi.fn(async () => {
                if (batchNumber === 2 && !failedSecondBatch) {
                    failedSecondBatch = true;
                    events.push('commit:2:failed');
                    throw new Error('second batch failed');
                }
                for (const reference of refs) {
                    documents.get(reference.collectionName)?.delete(reference.id);
                }
                events.push(`commit:${batchNumber}:success`);
            }),
        };
        batches.push(batch);
        return batch;
    });

    return {
        auth,
        batches,
        collection,
        database,
        doc,
        events,
        getDocs,
        logAudit: vi.fn(),
        loggerError: vi.fn(),
        query,
        reauthModal: vi.fn(() => null),
        resetData,
        remainingCount: (collectionName: string) => documents.get(collectionName)?.size ?? 0,
        where,
        writeBatch,
    };
});

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();
    const adapter = () => {
        if (!mountedHook.current) throw new Error('Hook harness is not mounted');
        return mountedHook.current;
    };

    return {
        ...actual,
        useCallback: ((callback: unknown) => callback) as typeof actual.useCallback,
        useEffect: ((effect: Effect, dependencies?: readonly unknown[]) => (
            adapter().useEffect(effect, dependencies)
        )) as typeof actual.useEffect,
        useRef: ((initialValue: unknown) => (
            adapter().useRef(initialValue)
        )) as typeof actual.useRef,
        useState: ((initialValue: unknown) => (
            adapter().useState(initialValue)
        )) as typeof actual.useState,
    };
});

vi.mock('firebase/firestore', () => ({
    collection: mocks.collection,
    doc: mocks.doc,
    getDocs: mocks.getDocs,
    query: mocks.query,
    where: mocks.where,
    writeBatch: mocks.writeBatch,
}));

vi.mock('../lib/firebase', () => ({
    auth: mocks.auth,
    db: mocks.database,
}));

vi.mock('../lib/auditLog', () => ({
    logAudit: mocks.logAudit,
}));

vi.mock('../lib/logger', () => ({
    createLogger: vi.fn(() => ({
        error: mocks.loggerError,
        info: vi.fn(),
    })),
}));

vi.mock('./ReauthModal', () => ({
    default: mocks.reauthModal,
}));

import { deleteUserData } from '../lib/accountDeletion';
import { useAccountDeletionFlow } from './AccountDeletionFlow';

interface StateSlot {
    kind: 'state';
    value: unknown;
}

interface RefSlot {
    kind: 'ref';
    value: { current: unknown };
}

interface EffectSlot {
    kind: 'effect';
    cleanup?: () => void;
    dependencies?: readonly unknown[];
}

type HookSlot = StateSlot | RefSlot | EffectSlot;

function dependenciesMatch(
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
): boolean {
    if (!previous || !next || previous.length !== next.length) return false;
    return previous.every((value, index) => Object.is(value, next[index]));
}

class HookHarness<Result> implements HookAdapter {
    private readonly slots: HookSlot[] = [];
    private hookIndex = 0;
    private pendingEffects: Array<{
        index: number;
        effect: Effect;
        dependencies?: readonly unknown[];
    }> = [];
    private mounted = true;
    private latestResult!: Result;

    constructor(private readonly renderHook: () => Result) {
        this.render();
    }

    render(): Result {
        if (!this.mounted) throw new Error('Hook harness is unmounted');
        this.hookIndex = 0;
        this.pendingEffects = [];
        mountedHook.current = this;
        try {
            this.latestResult = this.renderHook();
        } finally {
            mountedHook.current = null;
        }
        for (const pending of this.pendingEffects) {
            const slot = this.slots[pending.index];
            if (!slot || slot.kind !== 'effect') throw new Error('Hook changed type');
            slot.cleanup?.();
            slot.dependencies = pending.dependencies;
            const cleanup = pending.effect();
            slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
        }
        return this.latestResult;
    }

    get result(): Result {
        return this.latestResult;
    }

    unmount() {
        if (!this.mounted) return;
        this.mounted = false;
        for (const slot of this.slots) {
            if (slot.kind === 'effect') slot.cleanup?.();
        }
    }

    useState<T>(initialValue: T | (() => T)): [T, (action: StateAction<T>) => void] {
        const index = this.hookIndex++;
        let slot = this.slots[index];
        if (!slot) {
            slot = {
                kind: 'state',
                value: typeof initialValue === 'function'
                    ? (initialValue as () => T)()
                    : initialValue,
            };
            this.slots[index] = slot;
        }
        if (slot.kind !== 'state') throw new Error('Hook changed type');
        const stateSlot = slot;
        return [stateSlot.value as T, action => {
            const previous = stateSlot.value as T;
            stateSlot.value = typeof action === 'function'
                ? (action as (value: T) => T)(previous)
                : action;
        }];
    }

    useRef<T>(initialValue: T): { current: T } {
        const index = this.hookIndex++;
        let slot = this.slots[index];
        if (!slot) {
            slot = { kind: 'ref', value: { current: initialValue } };
            this.slots[index] = slot;
        }
        if (slot.kind !== 'ref') throw new Error('Hook changed type');
        return slot.value as { current: T };
    }

    useEffect(effect: Effect, dependencies?: readonly unknown[]) {
        const index = this.hookIndex++;
        let slot = this.slots[index];
        if (!slot) {
            slot = { kind: 'effect' };
            this.slots[index] = slot;
        }
        if (slot.kind !== 'effect') throw new Error('Hook changed type');
        if (!dependenciesMatch(slot.dependencies, dependencies)) {
            this.pendingEffects.push({ index, effect, dependencies });
        }
    }
}

interface ElementProps {
    children?: ReactNode;
    [key: string]: unknown;
}

function isElement(node: ReactNode): node is ReactElement<ElementProps> {
    return typeof node === 'object' && node !== null && 'props' in node;
}

function findElement(
    node: ReactNode,
    predicate: (element: ReactElement<ElementProps>) => boolean,
): ReactElement<ElementProps> {
    if (Array.isArray(node)) {
        for (const child of node) {
            try {
                return findElement(child, predicate);
            } catch {
                // Search the next child.
            }
        }
    } else if (isElement(node)) {
        if (predicate(node)) return node;
        return findElement(node.props.children, predicate);
    }
    throw new Error('Expected element was not rendered');
}

function getText(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(getText).join('');
    if (isElement(node)) return getText(node.props.children);
    return '';
}

function findButton(node: ReactNode, label: string): ReactElement<ElementProps> {
    return findElement(
        node,
        element => element.type === 'button' && getText(element.props.children).includes(label),
    );
}

async function openReauthentication(
    harness: HookHarness<ReturnType<typeof useAccountDeletionFlow>>,
) {
    let dialog = harness.result.accountDeletionDialog;
    const input = findElement(
        dialog,
        element => element.props.id === 'account-deletion-confirmation',
    );
    (input.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: '削除' },
    });
    dialog = harness.render().accountDeletionDialog;
    (findButton(dialog, '再認証へ進む').props.onClick as () => void)();
    dialog = harness.render().accountDeletionDialog;
    return findElement(dialog, element => element.type === mocks.reauthModal);
}

async function flushAsyncWork() {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

const mountedHarnesses: HookHarness<unknown>[] = [];

describe('AccountDeletionFlow integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resetData();
        mocks.logAudit.mockResolvedValue(undefined);
    });

    afterEach(() => {
        while (mountedHarnesses.length > 0) mountedHarnesses.pop()?.unmount();
        mountedHook.current = null;
    });

    it('実deleteUserDataで第1chunk成功後の失敗を再確認し、残件再走査後にAuthを削除する', async () => {
        const user = {
            uid: 'user-1',
            email: 'user@example.com',
            getIdToken: vi.fn().mockResolvedValue('token'),
            delete: vi.fn(async () => {
                mocks.events.push('auth-delete');
            }),
        };
        mocks.auth.currentUser = user;
        const harness = new HookHarness(() => useAccountDeletionFlow(user as never));
        mountedHarnesses.push(harness as HookHarness<unknown>);

        expect(vi.isMockFunction(deleteUserData)).toBe(false);
        await harness.result.beginAccountDeletion();
        let dialog = harness.render().accountDeletionDialog;
        expect(getText(dialog)).toContain('所有しているプロンプト 450件');

        const firstReauthentication = await openReauthentication(harness);
        await (firstReauthentication.props.onSuccess as () => Promise<void>)();
        dialog = harness.render().accountDeletionDialog;

        expect(mocks.batches).toHaveLength(2);
        expect(mocks.batches[0].refs).toHaveLength(400);
        expect(mocks.batches[0].commit).toHaveBeenCalledOnce();
        expect(mocks.batches[1].commit).toHaveBeenCalledOnce();
        expect(mocks.remainingCount('prompts')).toBe(50);
        expect(mocks.remainingCount('users')).toBe(1);
        expect(user.delete).not.toHaveBeenCalled();
        expect(getText(dialog)).toContain('一部削除済み（1バッチ）');
        expect(getText(dialog)).toContain('第2バッチ（全2バッチ）で削除処理に失敗');

        const scanCountBeforeReconfirmation = mocks.getDocs.mock.calls.length;
        (findButton(dialog, '削除対象を再確認').props.onClick as () => void)();
        await flushAsyncWork();
        dialog = harness.render().accountDeletionDialog;

        expect(mocks.getDocs.mock.calls.length).toBeGreaterThan(scanCountBeforeReconfirmation);
        expect(getText(dialog)).toContain('所有しているプロンプト 50件');

        const secondReauthentication = await openReauthentication(harness);
        await (secondReauthentication.props.onSuccess as () => Promise<void>)();

        expect(mocks.batches).toHaveLength(3);
        expect(mocks.batches[2].refs).toHaveLength(51);
        expect(mocks.batches[2].commit).toHaveBeenCalledOnce();
        expect(mocks.remainingCount('prompts')).toBe(0);
        expect(mocks.remainingCount('users')).toBe(0);
        expect(user.delete).toHaveBeenCalledOnce();
        expect(mocks.logAudit).toHaveBeenCalledTimes(2);
        expect(mocks.events.indexOf('commit:3:success')).toBeLessThan(
            mocks.events.indexOf('auth-delete'),
        );
    });
});

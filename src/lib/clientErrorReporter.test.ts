// @vitest-environment jsdom

/**
 * 未捕捉エラー観測 (S2-8) の錠。
 *  - window の error / unhandledrejection が logger.error へ構造化引数で流れる
 *  - 二重登録しない
 *  - Firestore 送信の失敗 (Rules 未配備) がアプリへ伝播しない
 *  - 同一メッセージの送信は throttle される / ページあたり上限がある
 *  - ハンドラ自身は決して throw せず、再帰しない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    database: { name: 'mock-firestore' },
    addDoc: vi.fn(),
    collection: vi.fn((...segments: unknown[]) => ({ type: 'collection', segments })),
    serverTimestamp: vi.fn(() => ({ type: 'serverTimestamp' })),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
    identity: { userId: 'GUEST', ownerType: 'guest' as 'guest' | 'user' },
}));

vi.mock('firebase/firestore', () => ({
    addDoc: mocks.addDoc,
    collection: mocks.collection,
    serverTimestamp: mocks.serverTimestamp,
}));

vi.mock('./firebase', () => ({
    db: mocks.database,
}));

vi.mock('./auth', () => ({
    getCurrentUserId: () => mocks.identity.userId,
    getOwnerType: () => mocks.identity.ownerType,
}));

vi.mock('./logger', () => ({
    createLogger: vi.fn(() => ({
        error: mocks.loggerError,
        warn: mocks.loggerWarn,
        info: mocks.loggerInfo,
    })),
}));

import {
    CLIENT_ERRORS_COLLECTION,
    MAX_MESSAGE_LENGTH,
    MAX_STACK_LENGTH,
    isClientErrorReporterInstalled,
    setupClientErrorReporter,
    teardownClientErrorReporter,
} from './clientErrorReporter';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fireError(init: ErrorEventInit): void {
    window.dispatchEvent(new ErrorEvent('error', init));
}

// jsdom 26 には PromiseRejectionEvent が無いので、同名の素の Event に reason を載せる。
// ハンドラ側は event.reason しか読まないので実ブラウザと同じ経路を通る。
function fireRejection(reason: unknown): void {
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: reason });
    window.dispatchEvent(event);
}

/** addDoc は fire-and-forget なので、マイクロタスクを数回流して送信まで待つ */
async function flush(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
    }
}

function sentPayload(callIndex = 0): Record<string, unknown> {
    return mocks.addDoc.mock.calls[callIndex][1] as Record<string, unknown>;
}

describe('clientErrorReporter (S2-8)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.addDoc.mockResolvedValue({ id: 'doc-1' });
        mocks.identity.userId = 'GUEST';
        mocks.identity.ownerType = 'guest';
    });

    afterEach(() => {
        teardownClientErrorReporter();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    describe('logger.error への構造化出力', () => {
        it('window の error イベントを message/stack/source/url/timestamp 付きで流す', () => {
            setupClientErrorReporter();
            const error = new Error('boom');

            fireError({
                message: 'Uncaught Error: boom',
                error,
                filename: 'https://app.example/_next/static/chunks/page.js',
                lineno: 10,
                colno: 5,
            });

            expect(mocks.loggerError).toHaveBeenCalledTimes(1);
            const [message, rawError, metadata] = mocks.loggerError.mock.calls[0];
            expect(typeof message).toBe('string');
            expect(rawError).toBe(error);
            expect(metadata).toEqual(expect.objectContaining({
                source: 'window.error',
                message: 'boom',
                stack: expect.stringContaining('boom'),
                url: window.location.href,
                timestamp: expect.stringMatching(ISO_8601),
                filename: 'https://app.example/_next/static/chunks/page.js',
                lineno: 10,
                colno: 5,
                userId: 'GUEST',
                ownerType: 'guest',
            }));
        });

        it('Error オブジェクトが無い error イベント (クロスオリジンの "Script error.") でも message を作る', () => {
            setupClientErrorReporter();

            fireError({ message: 'Script error.' });

            expect(mocks.loggerError).toHaveBeenCalledTimes(1);
            const metadata = mocks.loggerError.mock.calls[0][2] as Record<string, unknown>;
            expect(metadata.message).toBe('Script error.');
            expect(metadata.source).toBe('window.error');
            expect(metadata.stack).toBeUndefined();
        });

        it('unhandledrejection (reason が Error) を source=unhandledrejection で流す', () => {
            setupClientErrorReporter();
            const reason = new Error('rejected');

            fireRejection(reason);

            expect(mocks.loggerError).toHaveBeenCalledTimes(1);
            const [, rawError, metadata] = mocks.loggerError.mock.calls[0];
            expect(rawError).toBe(reason);
            expect(metadata).toEqual(expect.objectContaining({
                source: 'unhandledrejection',
                message: 'rejected',
                stack: expect.stringContaining('rejected'),
                url: window.location.href,
                timestamp: expect.stringMatching(ISO_8601),
            }));
        });

        it.each([
            ['文字列', 'plain string', 'plain string', undefined],
            ['code 付きオブジェクト', { code: 'permission-denied', message: 'Missing or insufficient permissions.' }, 'Missing or insufficient permissions.', 'permission-denied'],
            ['message を持たないオブジェクト', { status: 500 }, '{"status":500}', undefined],
            ['undefined', undefined, '(no reason)', undefined],
            ['数値', 42, '42', undefined],
        ])('reason が %s でも message を作る', (_label, reason, expectedMessage, expectedCode) => {
            setupClientErrorReporter();

            fireRejection(reason);

            const metadata = mocks.loggerError.mock.calls[0][2] as Record<string, unknown>;
            expect(metadata.message).toBe(expectedMessage);
            expect(metadata.code).toBe(expectedCode);
        });

        it('message と stack を上限長で切り詰める', () => {
            setupClientErrorReporter();
            const error = new Error('x'.repeat(MAX_MESSAGE_LENGTH * 3));
            error.stack = 'y'.repeat(MAX_STACK_LENGTH * 3);

            fireError({ error });

            const metadata = mocks.loggerError.mock.calls[0][2] as { message: string; stack: string };
            expect(metadata.message.length).toBe(MAX_MESSAGE_LENGTH + 1);
            expect(metadata.message.endsWith('…')).toBe(true);
            expect(metadata.stack.length).toBe(MAX_STACK_LENGTH + 1);
        });
    });

    describe('登録の冪等性', () => {
        it('2回 setup しても購読は1つ (二重登録しない)', () => {
            const addListener = vi.spyOn(window, 'addEventListener');

            expect(setupClientErrorReporter()).toBe(true);
            expect(setupClientErrorReporter()).toBe(false);
            expect(isClientErrorReporterInstalled()).toBe(true);

            const registered = addListener.mock.calls.map(([type]) => type);
            expect(registered.filter(type => type === 'error')).toHaveLength(1);
            expect(registered.filter(type => type === 'unhandledrejection')).toHaveLength(1);

            fireError({ error: new Error('once') });
            expect(mocks.loggerError).toHaveBeenCalledTimes(1);

            addListener.mockRestore();
        });

        it('teardown 後は受け取らず、再 setup で再び受け取る', () => {
            setupClientErrorReporter();
            teardownClientErrorReporter();
            expect(isClientErrorReporterInstalled()).toBe(false);

            // vitest の jsdom 環境は「ユーザーの error リスナーが無い状態で error を持つ
            // ErrorEvent」を未捕捉例外として扱うので、ここは message だけで発火する。
            fireError({ message: 'after teardown' });
            expect(mocks.loggerError).not.toHaveBeenCalled();

            expect(setupClientErrorReporter()).toBe(true);
            fireError({ error: new Error('after re-setup') });
            expect(mocks.loggerError).toHaveBeenCalledTimes(1);
        });

        it('window が無い環境 (SSR) では何もせず false を返す', () => {
            vi.stubGlobal('window', undefined);

            expect(() => setupClientErrorReporter()).not.toThrow();
            expect(setupClientErrorReporter()).toBe(false);
            expect(isClientErrorReporterInstalled()).toBe(false);
        });
    });

    describe('Firestore への best-effort 送信', () => {
        it('clientErrors コレクションへ undefined を含まない本文 + createdAt=serverTimestamp で送る', async () => {
            mocks.identity.userId = 'uid-1';
            mocks.identity.ownerType = 'user';
            setupClientErrorReporter();

            // stack / filename / lineno / colno / code が無いケース: undefined のキーが混ざると
            // addDoc は "Unsupported field value: undefined" で落ちるので、キーごと落ちること。
            fireError({ message: 'Script error.' });
            await flush();

            expect(mocks.collection).toHaveBeenCalledWith(mocks.database, CLIENT_ERRORS_COLLECTION);
            expect(mocks.addDoc).toHaveBeenCalledTimes(1);
            const payload = sentPayload();
            expect(Object.values(payload).every(value => value !== undefined)).toBe(true);
            expect(payload).not.toHaveProperty('stack');
            expect(payload).not.toHaveProperty('filename');
            expect(payload).toEqual(expect.objectContaining({
                message: 'Script error.',
                source: 'window.error',
                url: window.location.href,
                timestamp: expect.stringMatching(ISO_8601),
                userId: 'uid-1',
                ownerType: 'user',
                userAgent: navigator.userAgent,
                createdAt: { type: 'serverTimestamp' },
            }));
        });

        it('addDoc が reject (permission-denied) してもアプリへ伝播せず、警告は1回だけ', async () => {
            const denied = Object.assign(new Error('Missing or insufficient permissions.'), {
                code: 'permission-denied',
            });
            mocks.addDoc.mockRejectedValue(denied);
            setupClientErrorReporter();

            expect(() => fireError({ error: new Error('first') })).not.toThrow();
            await flush();
            expect(() => fireError({ error: new Error('second') })).not.toThrow();
            await flush();

            // 未捕捉エラー自体は毎回 console (logger.error) へ出る
            expect(mocks.loggerError).toHaveBeenCalledTimes(2);
            expect(mocks.addDoc).toHaveBeenCalledTimes(2);
            // 送信失敗の警告は1ページ1回に抑制
            expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
            expect(mocks.loggerWarn.mock.calls[0][1]).toEqual(expect.objectContaining({
                code: 'permission-denied',
            }));
        });

        it('addDoc が同期 throw してもアプリへ伝播しない', async () => {
            mocks.addDoc.mockImplementation(() => {
                throw new Error('sync failure');
            });
            setupClientErrorReporter();

            expect(() => fireError({ error: new Error('boom') })).not.toThrow();
            await flush();

            expect(mocks.loggerError).toHaveBeenCalledTimes(1);
            expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
        });

        it('collection() が throw してもアプリへ伝播しない', async () => {
            mocks.collection.mockImplementationOnce(() => {
                throw new Error('firestore not ready');
            });
            setupClientErrorReporter();

            expect(() => fireError({ error: new Error('boom') })).not.toThrow();
            await flush();

            expect(mocks.addDoc).not.toHaveBeenCalled();
            expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
        });
    });

    describe('throttle と上限', () => {
        it('同一メッセージは一定時間に1回だけ送る (console には毎回出る)', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
            setupClientErrorReporter({ throttleMs: 60_000 });

            fireError({ error: new Error('same') });
            fireError({ error: new Error('same') });
            fireRejection(new Error('same'));
            await flush();
            expect(mocks.addDoc).toHaveBeenCalledTimes(1);
            expect(mocks.loggerError).toHaveBeenCalledTimes(3);

            fireError({ error: new Error('different') });
            await flush();
            expect(mocks.addDoc).toHaveBeenCalledTimes(2);

            vi.setSystemTime(new Date('2026-09-03T00:00:59.999Z'));
            fireError({ error: new Error('same') });
            await flush();
            expect(mocks.addDoc).toHaveBeenCalledTimes(2);

            vi.setSystemTime(new Date('2026-09-03T00:01:00.000Z'));
            fireError({ error: new Error('same') });
            await flush();
            expect(mocks.addDoc).toHaveBeenCalledTimes(3);
        });

        it('1ページあたりの送信上限を超えたら送らない (エラー嵐対策)', async () => {
            setupClientErrorReporter({ maxReportsPerPage: 3 });

            for (let i = 0; i < 5; i += 1) {
                fireError({ error: new Error(`distinct ${i}`) });
            }
            await flush();

            expect(mocks.loggerError).toHaveBeenCalledTimes(5);
            expect(mocks.addDoc).toHaveBeenCalledTimes(3);
        });
    });

    describe('ハンドラ自身の堅牢性', () => {
        it('logger が throw しても伝播しない', () => {
            mocks.loggerError.mockImplementationOnce(() => {
                throw new Error('logger broke');
            });
            setupClientErrorReporter();

            expect(() => fireError({ error: new Error('boom') })).not.toThrow();
        });

        it('ハンドラ処理中に発生した error イベントは捨てて再帰しない', () => {
            mocks.loggerError.mockImplementationOnce(() => {
                fireError({ error: new Error('nested') });
            });
            setupClientErrorReporter();

            fireError({ error: new Error('outer') });

            expect(mocks.loggerError).toHaveBeenCalledTimes(1);
            const metadata = mocks.loggerError.mock.calls[0][2] as Record<string, unknown>;
            expect(metadata.message).toBe('outer');
        });

        it('getCurrentUserId が throw しても伝播しない', () => {
            setupClientErrorReporter();
            vi.mocked(mocks.identity).userId = undefined as unknown as string;

            expect(() => fireError({ error: new Error('boom') })).not.toThrow();
        });
    });
});

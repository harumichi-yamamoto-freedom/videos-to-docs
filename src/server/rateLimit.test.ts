import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const doubles = vi.hoisted(() => ({
    configData: undefined as Record<string, unknown> | undefined,
    configThrows: false,
    rateDocs: new Map<string, Record<string, unknown>>(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => doubles.logger }));
vi.mock('firebase-admin/firestore', () => ({
    FieldValue: { serverTimestamp: () => 'SERVER_TS' },
}));
vi.mock('./firebaseAdmin', () => ({
    getAdminFirestore: () => ({
        doc: (path: string) => ({
            get: async () => {
                if (doubles.configThrows) throw new Error('firestore unavailable');
                expect(path).toBe('adminSettings/config');
                return { exists: doubles.configData !== undefined, data: () => doubles.configData };
            },
        }),
        collection: (name: string) => ({ doc: (id: string) => ({ id: `${name}/${id}` }) }),
        runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
            get: async (ref: { id: string }) => {
                const d = doubles.rateDocs.get(ref.id);
                return { exists: d !== undefined, data: () => d };
            },
            set: (ref: { id: string }, data: Record<string, unknown>) => { doubles.rateDocs.set(ref.id, data); },
        }),
    }),
}));

import {
    DEFAULT_DOCUMENTS_PER_HOUR,
    RATE_LIMIT_WINDOW_MS,
    clientIpFromHeaders,
    coerceDocumentsPerHour,
    consumeRateLimit,
    decideWindow,
    enforceRateLimit,
    rateLimitSubjectFor,
    readDocumentsPerHour,
} from './rateLimit';

beforeEach(() => {
    doubles.configData = undefined;
    doubles.configThrows = false;
    doubles.rateDocs.clear();
    vi.clearAllMocks();
});

describe('subject / ip', () => {
    it('x-forwarded-for の先頭を IP にする', () => {
        expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
        expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
        expect(clientIpFromHeaders(new Headers())).toBe('unknown');
    });
    it('uid はそのまま、guest は guest:<sha256 先頭16>', () => {
        expect(rateLimitSubjectFor({ kind: 'user', uid: 'uid-1' }, '1.1.1.1')).toBe('uid-1');
        const expected = createHash('sha256').update('1.1.1.1').digest('hex').slice(0, 16);
        expect(rateLimitSubjectFor({ kind: 'guest' }, '1.1.1.1')).toBe(`guest:${expected}`);
        expect(rateLimitSubjectFor({ kind: 'guest' }, '1.1.1.1')).not.toBe(rateLimitSubjectFor({ kind: 'guest' }, '1.1.1.2'));
    });
});

describe('readDocumentsPerHour', () => {
    it('設定値を読む', async () => {
        doubles.configData = { rateLimit: { documentsPerHour: 7 } };
        await expect(readDocumentsPerHour()).resolves.toBe(7);
        expect(doubles.logger.warn).not.toHaveBeenCalled();
    });
    it.each([
        ['doc 無し', undefined],
        ['rateLimit 無し', {}],
        ['文字列', { rateLimit: { documentsPerHour: '50' } }],
        ['負数', { rateLimit: { documentsPerHour: -1 } }],
        ['NaN', { rateLimit: { documentsPerHour: NaN } }],
    ])('不正値は既定 50 + warn: %s', async (_label, data) => {
        doubles.configData = data;
        await expect(readDocumentsPerHour()).resolves.toBe(DEFAULT_DOCUMENTS_PER_HOUR);
        expect(doubles.logger.warn).toHaveBeenCalledTimes(1);
    });
    it('読取失敗も既定 50 + warn', async () => {
        doubles.configThrows = true;
        await expect(readDocumentsPerHour()).resolves.toBe(DEFAULT_DOCUMENTS_PER_HOUR);
        expect(doubles.logger.warn).toHaveBeenCalledTimes(1);
    });
    it('小数は切り捨て、0 は 0 として尊重', () => {
        expect(coerceDocumentsPerHour(2.9)).toBe(2);
        expect(coerceDocumentsPerHour(0)).toBe(0);
    });
});

describe('decideWindow (純関数)', () => {
    const T0 = 1_700_000_000_000;
    it('doc 無しは新しい窓で count=1', () => {
        expect(decideWindow(null, T0, 3)).toEqual({ next: { windowStartMs: T0, count: 1 }, decision: { allowed: true, limit: 3, count: 1 } });
    });
    it('窓内は count を進める', () => {
        expect(decideWindow({ windowStartMs: T0, count: 1 }, T0 + 1000, 3).next).toEqual({ windowStartMs: T0, count: 2 });
    });
    it('上限到達で拒否・書かない・retryAfterSec は窓の残り', () => {
        const r = decideWindow({ windowStartMs: T0, count: 3 }, T0 + 10 * 60 * 1000, 3);
        expect(r.next).toBeNull();
        expect(r.decision).toEqual({ allowed: false, limit: 3, count: 3, retryAfterSec: 50 * 60 });
    });
    it('境界: 窓が丸 1 時間経過したら新しい窓', () => {
        const r = decideWindow({ windowStartMs: T0, count: 3 }, T0 + RATE_LIMIT_WINDOW_MS, 3);
        expect(r.next).toEqual({ windowStartMs: T0 + RATE_LIMIT_WINDOW_MS, count: 1 });
        const still = decideWindow({ windowStartMs: T0, count: 3 }, T0 + RATE_LIMIT_WINDOW_MS - 1, 3);
        expect(still.next).toBeNull();
        expect(still.decision.retryAfterSec).toBe(1);
    });
    it('limit 0 は常に拒否', () => {
        const r = decideWindow(null, T0, 0);
        expect(r.decision.allowed).toBe(false);
        expect(r.decision.retryAfterSec).toBe(3600);
    });
    it('未来の windowStart (時計ずれ) は新しい窓として扱う', () => {
        expect(decideWindow({ windowStartMs: T0 + 5000, count: 99 }, T0, 3).decision.allowed).toBe(true);
    });
});

describe('consumeRateLimit / enforceRateLimit (transaction)', () => {
    it('設定上限まで許可し、次で 429', async () => {
        doubles.configData = { rateLimit: { documentsPerHour: 2 } };
        const now = 1_700_000_000_000;
        await expect(consumeRateLimit('uid-1', { nowMs: now })).resolves.toMatchObject({ allowed: true, count: 1 });
        await expect(consumeRateLimit('uid-1', { nowMs: now + 1 })).resolves.toMatchObject({ allowed: true, count: 2 });
        expect(doubles.rateDocs.get('rateLimits/uid-1')).toEqual({ windowStartMs: now, count: 2, limit: 2, updatedAt: 'SERVER_TS' });
        await expect(enforceRateLimit({ kind: 'user', uid: 'uid-1' }, '1.1.1.1', { nowMs: now + 2 }))
            .rejects.toMatchObject({ code: 'rate_limited', status: 429, retryAfterSec: 3600 });
        // 拒否時は書かない
        expect(doubles.rateDocs.get('rateLimits/uid-1')?.count).toBe(2);
    });

    it('guest は IP ハッシュの subject で別々に数える', async () => {
        doubles.configData = { rateLimit: { documentsPerHour: 1 } };
        await enforceRateLimit({ kind: 'guest' }, '1.1.1.1');
        await expect(enforceRateLimit({ kind: 'guest' }, '1.1.1.1')).rejects.toMatchObject({ code: 'rate_limited' });
        await expect(enforceRateLimit({ kind: 'guest' }, '1.1.1.2')).resolves.toMatchObject({ allowed: true });
        expect([...doubles.rateDocs.keys()].every(k => k.startsWith('rateLimits/guest:'))).toBe(true);
    });

    it('壊れた doc は新しい窓として扱う', async () => {
        doubles.rateDocs.set('rateLimits/uid-1', { count: 'many' });
        await expect(consumeRateLimit('uid-1', { limit: 1 })).resolves.toMatchObject({ allowed: true, count: 1 });
    });
});

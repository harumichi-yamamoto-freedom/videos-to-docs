/**
 * 時間あたり上限のサーバ強制。
 *   - 上限値: Firestore `adminSettings/config` の `rateLimit.documentsPerHour` (読取失敗・不正値は既定 50 + warn)
 *   - 計数: `rateLimits/{subject}` に「固定 1 時間窓の開始時刻と件数」を admin SDK のトランザクションで更新
 *   - subject: uid、未ログインは `guest:<sha256(送信元 IP) 先頭 16 桁>`
 */
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { GUEST_RATE_LIMIT_SUBJECT_PREFIX } from '@/lib/generateApiContract';
import { createLogger } from '@/lib/logger';
import type { RequestSubject } from './auth';
import { GenerateApiError } from './errors';
import { getAdminFirestore } from './firebaseAdmin';

const logger = createLogger('server/rateLimit');

export const DEFAULT_DOCUMENTS_PER_HOUR = 50;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const RATE_LIMITS_COLLECTION = 'rateLimits';
export const ADMIN_SETTINGS_DOC_PATH = 'adminSettings/config';

export interface RateLimitDecision {
    allowed: boolean;
    subject: string;
    limit: number;
    /** 窓内で使った件数 (許可時は今回分を含む) */
    count: number;
    /** 拒否時: 窓が開くまでの秒数 (1 以上) */
    retryAfterSec?: number;
}

interface RateLimitDoc {
    windowStartMs: number;
    count: number;
}

/** 送信元 IP: `x-forwarded-for` の先頭 (Vercel が付ける)。無ければ x-real-ip、それも無ければ 'unknown' */
export function clientIpFromHeaders(headers: Headers): string {
    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
    }
    const real = headers.get('x-real-ip')?.trim();
    return real || 'unknown';
}

export const hashIpForSubject = (ip: string): string =>
    createHash('sha256').update(ip).digest('hex').slice(0, 16);

export function rateLimitSubjectFor(subject: RequestSubject, ip: string): string {
    return subject.kind === 'user'
        ? subject.uid
        : `${GUEST_RATE_LIMIT_SUBJECT_PREFIX}${hashIpForSubject(ip)}`;
}

/** 設定値の解釈: 0 以上の有限数だけ採用 (0 は「全停止」として尊重)。それ以外は既定値 */
export function coerceDocumentsPerHour(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
}

export async function readDocumentsPerHour(): Promise<number> {
    try {
        const snapshot = await getAdminFirestore().doc(ADMIN_SETTINGS_DOC_PATH).get();
        const data = snapshot.exists ? snapshot.data() : undefined;
        const rateLimit = data?.rateLimit as { documentsPerHour?: unknown } | undefined;
        const limit = coerceDocumentsPerHour(rateLimit?.documentsPerHour);
        if (limit === null) {
            logger.warn('adminSettings/config の rateLimit.documentsPerHour が無いか不正。既定値を使う', {
                raw: rateLimit?.documentsPerHour,
                fallback: DEFAULT_DOCUMENTS_PER_HOUR,
            });
            return DEFAULT_DOCUMENTS_PER_HOUR;
        }
        return limit;
    } catch (error) {
        logger.warn('adminSettings/config の読取に失敗。既定値を使う', {
            error: error instanceof Error ? error.message : String(error),
            fallback: DEFAULT_DOCUMENTS_PER_HOUR,
        });
        return DEFAULT_DOCUMENTS_PER_HOUR;
    }
}

const parseDoc = (raw: FirebaseFirestore.DocumentData | undefined): RateLimitDoc | null => {
    if (!raw) return null;
    const windowStartMs = typeof raw.windowStartMs === 'number' ? raw.windowStartMs : NaN;
    const count = typeof raw.count === 'number' ? raw.count : NaN;
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(count)) return null;
    return { windowStartMs, count };
};

/** 窓の純粋な判定 (トランザクション内から呼ぶ)。書き戻す新状態を返す。拒否時は null (書かない) */
export function decideWindow(
    current: RateLimitDoc | null,
    nowMs: number,
    limit: number,
): { next: RateLimitDoc | null; decision: Omit<RateLimitDecision, 'subject'> } {
    const inWindow = current !== null && nowMs - current.windowStartMs < RATE_LIMIT_WINDOW_MS && nowMs >= current.windowStartMs;
    const windowStartMs = inWindow ? current.windowStartMs : nowMs;
    const used = inWindow ? current.count : 0;
    if (used >= limit) {
        const retryAfterSec = Math.max(1, Math.ceil((windowStartMs + RATE_LIMIT_WINDOW_MS - nowMs) / 1000));
        return { next: null, decision: { allowed: false, limit, count: used, retryAfterSec } };
    }
    return {
        next: { windowStartMs, count: used + 1 },
        decision: { allowed: true, limit, count: used + 1 },
    };
}

export interface ConsumeRateLimitOptions {
    nowMs?: number;
    limit?: number;
}

/** 1 件分を消費する。上限内なら count を進めて allowed、超過なら書かずに retryAfterSec つきで拒否 */
export async function consumeRateLimit(
    subject: string,
    options: ConsumeRateLimitOptions = {},
): Promise<RateLimitDecision> {
    const nowMs = options.nowMs ?? Date.now();
    const limit = options.limit ?? await readDocumentsPerHour();
    const db = getAdminFirestore();
    const ref = db.collection(RATE_LIMITS_COLLECTION).doc(subject);

    const decision = await db.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        const current = parseDoc(snapshot.exists ? snapshot.data() : undefined);
        const { next, decision: partial } = decideWindow(current, nowMs, limit);
        if (next) {
            tx.set(ref, {
                windowStartMs: next.windowStartMs,
                count: next.count,
                limit,
                updatedAt: FieldValue.serverTimestamp(),
            });
        }
        return { ...partial, subject };
    });

    if (!decision.allowed) {
        logger.warn('時間あたり上限を超過', {
            subject, limit, count: decision.count, retryAfterSec: decision.retryAfterSec,
        });
    }
    return decision;
}

const rateLimitedMessage = (limit: number, retryAfterSec: number): string => {
    const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
    return `1 時間あたりの変換回数の上限 (${limit} 件) に達しました。約 ${minutes} 分後に再試行してください。`;
};

/** ルート用: 主体と IP から subject を作り、超過なら 429 の GenerateApiError を投げる */
export async function enforceRateLimit(
    subject: RequestSubject,
    ip: string,
    options: ConsumeRateLimitOptions = {},
): Promise<RateLimitDecision> {
    const decision = await consumeRateLimit(rateLimitSubjectFor(subject, ip), options);
    if (!decision.allowed) {
        const retryAfterSec = decision.retryAfterSec ?? Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
        throw new GenerateApiError('rate_limited', rateLimitedMessage(decision.limit, retryAfterSec), { retryAfterSec });
    }
    return decision;
}

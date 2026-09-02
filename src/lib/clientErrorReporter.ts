/**
 * クライアント側の未捕捉エラー観測 (S2-8 / issue #13)
 *
 * window の 'error' / 'unhandledrejection' を1回だけ購読し、
 *  1. 既存 logger.error へ構造化 (message/stack/source/url/timestamp) で流す (毎回)
 *  2. Firestore `clientErrors` へ best-effort で送る (失敗は無音・throttle 付き)
 *
 * 不変条件:
 *  - 観測層がアプリ挙動を変えることはない。ハンドラは決して throw しない
 *    (リスナー内の例外は再び 'error' イベントになり、自分自身へ再帰する)。
 *  - Firestore 送信の失敗 (Rules 未配備の permission-denied を含む) はアプリへ伝播しない。
 *  - 二重登録しない (React StrictMode の effect 二重実行・レイアウト再マウントに耐える)。
 *  - Firestore に undefined 値を渡さない (addDoc が "Unsupported field value" で落ちる)。
 *
 * window.onerror への代入ではなく addEventListener を使うのは、Next の dev overlay など
 * 他のハンドラを上書きしないため。受け取る ErrorEvent は同じ。
 */

import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { getCurrentUserId, getOwnerType } from './auth';
import { createLogger } from './logger';

const reporterLogger = createLogger('clientErrorReporter');

export const CLIENT_ERRORS_COLLECTION = 'clientErrors';

/** message の保存上限 (文字数)。超過分は切り詰めて末尾に … を付ける */
export const MAX_MESSAGE_LENGTH = 1000;
/** stack の保存上限 (文字数) */
export const MAX_STACK_LENGTH = 8000;

const DEFAULT_THROTTLE_MS = 60_000;
const DEFAULT_MAX_REPORTS_PER_PAGE = 20;

export type ClientErrorSource = 'window.error' | 'unhandledrejection';

/** logger.error のメタデータ兼 Firestore へ送る本文 (undefined のキーは送信前に落とす) */
export interface ClientErrorReport {
    message: string;
    stack?: string;
    source: ClientErrorSource;
    /** 発生ページ (location.href) */
    url: string;
    /** 発生時刻 (クライアント時計・ISO 8601)。Firestore 側には別途 createdAt=serverTimestamp も付く */
    timestamp: string;
    filename?: string;
    lineno?: number;
    colno?: number;
    /** FirebaseError.code など、例外が code を持っていれば載せる */
    code?: string;
    userAgent?: string;
    /** "GUEST" または Auth UID (auditLogs と同じ規約) */
    userId: string;
    ownerType: 'user' | 'guest';
}

export interface ClientErrorReporterOptions {
    /** 同一メッセージの Firestore 送信を抑制する時間 (ms)。既定 60 秒 */
    throttleMs?: number;
    /** 1ページ滞在あたりの Firestore 送信上限 (エラー嵐対策)。既定 20 件。console 出力は制限しない */
    maxReportsPerPage?: number;
}

interface ReporterState {
    throttleMs: number;
    maxReportsPerPage: number;
    /** 同一メッセージの最終送信時刻 (epoch ms) */
    lastSentAt: Map<string, number>;
    sentCount: number;
    /** 送信失敗の警告は1ページ1回だけ (Rules 未配備時に console が埋まらないように) */
    sendFailureWarned: boolean;
    /** 再入ガード: ハンドラ処理中に発生したイベントは捨てる */
    handling: boolean;
    onError: (event: ErrorEvent) => void;
    onRejection: (event: Event) => void;
}

let state: ReporterState | null = null;

/**
 * 未捕捉エラーの購読を開始する。冪等 (2回目以降は何もしない)。
 * @returns 新規に登録したら true。既に登録済み・window が無い (SSR) なら false。
 */
export function setupClientErrorReporter(options: ClientErrorReporterOptions = {}): boolean {
    if (typeof window === 'undefined') {
        return false;
    }
    if (state) {
        return false;
    }

    const current: ReporterState = {
        throttleMs: options.throttleMs ?? DEFAULT_THROTTLE_MS,
        maxReportsPerPage: options.maxReportsPerPage ?? DEFAULT_MAX_REPORTS_PER_PAGE,
        lastSentAt: new Map(),
        sentCount: 0,
        sendFailureWarned: false,
        handling: false,
        onError: (event) => {
            report(current, () => buildFromErrorEvent(event), event.error);
        },
        onRejection: (event) => {
            const reason = (event as Partial<PromiseRejectionEvent>).reason;
            report(current, () => buildFromRejection(reason), reason);
        },
    };

    window.addEventListener('error', current.onError);
    window.addEventListener('unhandledrejection', current.onRejection);
    state = current;
    return true;
}

/**
 * 購読を解除して状態を捨てる。アプリは呼ばない (リスナーはページ寿命で生かす)。テスト用。
 */
export function teardownClientErrorReporter(): void {
    if (!state) {
        return;
    }
    if (typeof window !== 'undefined') {
        window.removeEventListener('error', state.onError);
        window.removeEventListener('unhandledrejection', state.onRejection);
    }
    state = null;
}

export function isClientErrorReporterInstalled(): boolean {
    return state !== null;
}

// ---- 内部 ------------------------------------------------------------------

function report(current: ReporterState, build: () => ClientErrorReport, rawError: unknown): void {
    if (current.handling) {
        return;
    }
    current.handling = true;
    try {
        const entry = build();
        reporterLogger.error('未捕捉エラーを検知', rawError, { ...entry });
        void sendToFirestore(current, entry);
    } catch {
        // 観測層の失敗はアプリに伝播させない (ここで throw すると 'error' イベントへ再帰する)
    } finally {
        current.handling = false;
    }
}

async function sendToFirestore(current: ReporterState, entry: ClientErrorReport): Promise<void> {
    try {
        if (!shouldSend(current, entry)) {
            return;
        }
        await addDoc(collection(db, CLIENT_ERRORS_COLLECTION), {
            ...withoutUndefined(entry),
            createdAt: serverTimestamp(),
        });
    } catch (error) {
        // Rules 未配備 (permission-denied) やオフラインを含め、送信失敗は無音。
        // 警告は1ページ1回だけ出す。
        if (!current.sendFailureWarned) {
            current.sendFailureWarned = true;
            reporterLogger.warn('clientErrors への送信に失敗 (以後この警告は抑制)', {
                code: readCode(error),
                reason: describeThrown(error).message,
            });
        }
    }
}

function shouldSend(current: ReporterState, entry: ClientErrorReport): boolean {
    if (current.sentCount >= current.maxReportsPerPage) {
        return false;
    }
    const now = Date.now();
    const last = current.lastSentAt.get(entry.message);
    if (last !== undefined && now - last < current.throttleMs) {
        return false;
    }
    current.lastSentAt.set(entry.message, now);
    current.sentCount += 1;
    return true;
}

function buildFromErrorEvent(event: ErrorEvent): ClientErrorReport {
    const thrown = event.error === undefined || event.error === null ? null : describeThrown(event.error);
    return finalize({
        source: 'window.error',
        // Error オブジェクトがあれば素の message ("boom") を優先。無ければ
        // ErrorEvent.message ("Uncaught Error: boom" / クロスオリジンは "Script error.")
        message: thrown?.message || event.message || '(no message)',
        stack: thrown?.stack,
        code: thrown?.code,
        filename: event.filename || undefined,
        lineno: event.lineno || undefined,
        colno: event.colno || undefined,
    });
}

function buildFromRejection(reason: unknown): ClientErrorReport {
    const thrown = describeThrown(reason);
    return finalize({
        source: 'unhandledrejection',
        message: thrown.message,
        stack: thrown.stack,
        code: thrown.code,
    });
}

type ReportDraft = Pick<
    ClientErrorReport,
    'source' | 'message' | 'stack' | 'code' | 'filename' | 'lineno' | 'colno'
>;

function finalize(draft: ReportDraft): ClientErrorReport {
    return {
        message: truncate(draft.message, MAX_MESSAGE_LENGTH),
        stack: draft.stack === undefined ? undefined : truncate(draft.stack, MAX_STACK_LENGTH),
        source: draft.source,
        url: window.location.href,
        timestamp: new Date().toISOString(),
        filename: draft.filename,
        lineno: draft.lineno,
        colno: draft.colno,
        code: draft.code,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        userId: getCurrentUserId(),
        ownerType: getOwnerType(),
    };
}

interface ThrownDescription {
    message: string;
    stack?: string;
    code?: string;
}

/** 例外値 (Error / 文字列 / 任意オブジェクト / プリミティブ) を message/stack/code に正規化 */
function describeThrown(value: unknown): ThrownDescription {
    if (value === undefined || value === null) {
        return { message: '(no reason)' };
    }
    if (typeof value === 'string') {
        return { message: value };
    }
    if (typeof value === 'object') {
        // instanceof Error はクロスレルム (iframe 等) で外れるので、形で判定する
        const candidate = value as { message?: unknown; stack?: unknown };
        const message = typeof candidate.message === 'string' && candidate.message !== ''
            ? candidate.message
            : safeStringify(value);
        return {
            message,
            stack: typeof candidate.stack === 'string' ? candidate.stack : undefined,
            code: readCode(value),
        };
    }
    return { message: String(value) };
}

function readCode(value: unknown): string | undefined {
    if (value && typeof value === 'object') {
        const code = (value as { code?: unknown }).code;
        if (typeof code === 'string') {
            return code;
        }
    }
    return undefined;
}

function safeStringify(value: unknown): string {
    try {
        const json = JSON.stringify(value);
        return typeof json === 'string' ? json : Object.prototype.toString.call(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function withoutUndefined(entry: ClientErrorReport): Record<string, string | number> {
    const result: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(entry)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

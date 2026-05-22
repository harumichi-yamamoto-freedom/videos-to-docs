import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDoc,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    Timestamp,
    updateDoc,
    Unsubscribe,
    where,
} from 'firebase/firestore';
import { db } from './firebase';
import { createLogger } from './logger';

const notificationsLogger = createLogger('systemNotifications');

export type NotificationSeverity = 'info' | 'critical';

export interface SystemNotification {
    id: string;
    title: string;
    body: string;
    severity: NotificationSeverity;
    published: boolean;
    publishedAt: Date;
    publishedBy: string;
}

interface SystemNotificationDoc {
    title: string;
    body: string;
    severity: NotificationSeverity;
    published?: boolean;
    publishedAt: Timestamp | null;
    publishedBy: string;
}

interface DismissalsDoc {
    uid: string;
    dismissedIds: string[];
}

const NOTIFICATIONS_COLLECTION = 'systemNotifications';
const DISMISSALS_COLLECTION = 'notificationDismissals';

function mapDoc(id: string, data: SystemNotificationDoc): SystemNotification {
    return {
        id,
        title: data.title,
        body: data.body,
        severity: data.severity,
        // 旧データには published フィールドが無いため、欠落時は公開扱い（後方互換）
        published: data.published ?? true,
        publishedAt: data.publishedAt ? data.publishedAt.toDate() : new Date(0),
        publishedBy: data.publishedBy,
    };
}

/** 公開中の通知のみ購読（ユーザー画面用） */
export function subscribeToPublishedNotifications(
    onUpdate: (notifications: SystemNotification[]) => void,
    onError?: (error: Error) => void,
): Unsubscribe {
    const q = query(
        collection(db, NOTIFICATIONS_COLLECTION),
        where('published', '==', true),
        orderBy('publishedAt', 'desc'),
    );
    return onSnapshot(
        q,
        snapshot => {
            const list = snapshot.docs.map(d => mapDoc(d.id, d.data() as SystemNotificationDoc));
            onUpdate(list);
        },
        error => {
            notificationsLogger.error('公開中の systemNotifications 購読エラー', error);
            onError?.(error);
        },
    );
}

/** 全通知（下書き含む）を購読（管理画面用） */
export function subscribeToAllNotifications(
    onUpdate: (notifications: SystemNotification[]) => void,
    onError?: (error: Error) => void,
): Unsubscribe {
    const q = query(
        collection(db, NOTIFICATIONS_COLLECTION),
        orderBy('publishedAt', 'desc'),
    );
    return onSnapshot(
        q,
        snapshot => {
            const list = snapshot.docs.map(d => mapDoc(d.id, d.data() as SystemNotificationDoc));
            onUpdate(list);
        },
        error => {
            notificationsLogger.error('全 systemNotifications 購読エラー', error);
            onError?.(error);
        },
    );
}

export function subscribeToDismissals(
    uid: string,
    onUpdate: (dismissedIds: string[]) => void,
    onError?: (error: Error) => void,
): Unsubscribe {
    const ref = doc(db, DISMISSALS_COLLECTION, uid);
    return onSnapshot(
        ref,
        snapshot => {
            const data = snapshot.data() as DismissalsDoc | undefined;
            onUpdate(data?.dismissedIds ?? []);
        },
        error => {
            notificationsLogger.error('notificationDismissals 購読エラー', error, { uid });
            onError?.(error);
        },
    );
}

export async function dismissNotification(uid: string, notificationId: string): Promise<void> {
    const ref = doc(db, DISMISSALS_COLLECTION, uid);
    const snap = await getDoc(ref);
    const existing = (snap.data() as DismissalsDoc | undefined)?.dismissedIds ?? [];
    if (existing.includes(notificationId)) return;
    await setDoc(ref, { uid, dismissedIds: [...existing, notificationId] }, { merge: true });
}

export async function undismissNotification(uid: string, notificationId: string): Promise<void> {
    const ref = doc(db, DISMISSALS_COLLECTION, uid);
    const snap = await getDoc(ref);
    const existing = (snap.data() as DismissalsDoc | undefined)?.dismissedIds ?? [];
    if (!existing.includes(notificationId)) return;
    await setDoc(
        ref,
        { uid, dismissedIds: existing.filter(id => id !== notificationId) },
        { merge: true },
    );
}

export async function dismissAllNotifications(uid: string, notificationIds: string[]): Promise<void> {
    const ref = doc(db, DISMISSALS_COLLECTION, uid);
    const snap = await getDoc(ref);
    const existing = (snap.data() as DismissalsDoc | undefined)?.dismissedIds ?? [];
    const next = Array.from(new Set([...existing, ...notificationIds]));
    if (next.length === existing.length) return;
    await setDoc(ref, { uid, dismissedIds: next }, { merge: true });
}

export async function getSystemNotification(id: string): Promise<SystemNotification | null> {
    const ref = doc(db, NOTIFICATIONS_COLLECTION, id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return mapDoc(snap.id, snap.data() as SystemNotificationDoc);
}

export interface CreateSystemNotificationInput {
    title: string;
    body: string;
    severity: NotificationSeverity;
    publishedBy: string;
    published?: boolean;
}

export async function createSystemNotification(input: CreateSystemNotificationInput): Promise<string> {
    const docRef = await addDoc(collection(db, NOTIFICATIONS_COLLECTION), {
        title: input.title,
        body: input.body,
        severity: input.severity,
        published: input.published ?? true,
        publishedAt: serverTimestamp(),
        publishedBy: input.publishedBy,
    });
    return docRef.id;
}

export interface UpdateSystemNotificationInput {
    title?: string;
    body?: string;
    severity?: NotificationSeverity;
    published?: boolean;
}

export async function updateSystemNotification(id: string, input: UpdateSystemNotificationInput): Promise<void> {
    const ref = doc(db, NOTIFICATIONS_COLLECTION, id);
    const update: Record<string, unknown> = {};
    if (input.title !== undefined) update.title = input.title;
    if (input.body !== undefined) update.body = input.body;
    if (input.severity !== undefined) update.severity = input.severity;
    if (input.published !== undefined) update.published = input.published;
    if (Object.keys(update).length === 0) return;
    await updateDoc(ref, update);
}

export async function deleteSystemNotification(id: string): Promise<void> {
    await deleteDoc(doc(db, NOTIFICATIONS_COLLECTION, id));
}

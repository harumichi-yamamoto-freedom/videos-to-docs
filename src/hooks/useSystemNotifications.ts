'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './useAuth';
import {
    SystemNotification,
    subscribeToDismissals,
    subscribeToPublishedNotifications,
} from '@/lib/systemNotifications';

/** ホーム最上部バナーに出す「直近」の窓。最新 1 件はこの窓に関係なく必ず出す。 */
export const RECENT_BANNER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 直近 1 週間に大量投入された場合の表示上限（画面を埋め尽くさないための保険）。 */
export const MAX_BANNER_ITEMS = 10;

/**
 * バナーに出す通知 = 「一番新しいお知らせ 1 件」+「直近 1 週間のお知らせ全件」（閉じたものは除く・新しい順）。
 * 最新 1 件は公開日に関係なく出す（お知らせが久しく無くても最後の 1 件は残す）。
 * 純関数にして時刻を引数で受け、テストと hook の両方から同じ判定を使う。
 */
export function selectBannerNotifications(
    notifications: readonly SystemNotification[],
    dismissedIds: readonly string[],
    now: number,
): SystemNotification[] {
    const dismissed = new Set(dismissedIds);
    const visible = notifications
        .filter(n => !dismissed.has(n.id))
        .slice()
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    if (visible.length === 0) return [];

    const cutoff = now - RECENT_BANNER_WINDOW_MS;
    const recent = visible.filter(n => n.publishedAt.getTime() >= cutoff);
    const latest = visible[0];
    const picked = recent.some(n => n.id === latest.id) ? recent : [latest, ...recent];
    return picked.slice(0, MAX_BANNER_ITEMS);
}

export interface UseSystemNotificationsResult {
    notifications: SystemNotification[];
    dismissedIds: string[];
    loading: boolean;
    error: Error | null;
    stale: boolean;
    retrying: boolean;
    retry: () => void;
    /** ホーム最上部バナーに出す通知 = 最新 1 件 + 直近 1 週間（dismiss 済み除外・未認証は dismiss 無し） */
    bannerNotifications: SystemNotification[];
}

export function useSystemNotifications(): UseSystemNotificationsResult {
    const { user, loading: authLoading } = useAuth();
    const [notifications, setNotifications] = useState<SystemNotification[]>([]);
    const [dismissedIds, setDismissedIds] = useState<string[]>([]);
    const [notificationsLoaded, setNotificationsLoaded] = useState(false);
    const [dismissalsLoaded, setDismissalsLoaded] = useState(false);
    const [notificationsPending, setNotificationsPending] = useState(true);
    const [dismissalsPending, setDismissalsPending] = useState(Boolean(user?.uid));
    const [notificationsError, setNotificationsError] = useState<Error | null>(null);
    const [dismissalsError, setDismissalsError] = useState<Error | null>(null);
    const [notificationsAttempt, setNotificationsAttempt] = useState(0);
    const [dismissalsAttempt, setDismissalsAttempt] = useState(0);
    const notificationsAttemptRef = useRef(0);
    const dismissalsAttemptRef = useRef(0);
    // 「直近 1 週間」判定の基準時刻。マウント時に固定して useMemo 内で純粋に扱えるようにする。
    const [mountedAt] = useState(() => Date.now());

    // user 切替時に dismiss 状態をリセット（Adjusting state during render パターン）。
    // useEffect 内で setState すると React 19 の set-state-in-effect ルールに反するため
    // レンダー中の uid 比較で前ユーザーの値が残らないようにする。
    const currentUid = user?.uid ?? null;
    const [lastUid, setLastUid] = useState<string | null>(currentUid);
    if (currentUid !== lastUid) {
        setLastUid(currentUid);
        setDismissedIds([]);
        setDismissalsLoaded(false);
        setDismissalsPending(Boolean(currentUid));
        setDismissalsError(null);
    }

    useEffect(() => {
        const attempt = ++notificationsAttemptRef.current;
        const unsubscribe = subscribeToPublishedNotifications(
            list => {
                if (notificationsAttemptRef.current !== attempt) return;
                setNotifications(list);
                setNotificationsLoaded(true);
                setNotificationsPending(false);
                setNotificationsError(null);
            },
            error => {
                if (notificationsAttemptRef.current !== attempt) return;
                setNotificationsPending(false);
                setNotificationsError(error);
            },
        );
        return () => {
            if (notificationsAttemptRef.current === attempt) {
                notificationsAttemptRef.current += 1;
            }
            unsubscribe();
        };
    }, [notificationsAttempt]);

    useEffect(() => {
        if (!user?.uid) return;
        const attempt = ++dismissalsAttemptRef.current;
        const unsubscribe = subscribeToDismissals(
            user.uid,
            ids => {
                if (dismissalsAttemptRef.current !== attempt) return;
                setDismissedIds(ids);
                setDismissalsLoaded(true);
                setDismissalsPending(false);
                setDismissalsError(null);
            },
            error => {
                if (dismissalsAttemptRef.current !== attempt) return;
                setDismissalsPending(false);
                setDismissalsError(error);
            },
        );
        return () => {
            if (dismissalsAttemptRef.current === attempt) {
                dismissalsAttemptRef.current += 1;
            }
            unsubscribe();
        };
    }, [user?.uid, dismissalsAttempt]);

    const retry = useCallback(() => {
        if (notificationsError) {
            setNotificationsPending(true);
            setNotificationsAttempt(attempt => attempt + 1);
        }
        if (currentUid && dismissalsError) {
            setDismissalsPending(true);
            setDismissalsAttempt(attempt => attempt + 1);
        }
    }, [currentUid, dismissalsError, notificationsError]);

    const bannerNotifications = useMemo<SystemNotification[]>(
        // 未認証には dismiss の概念が無いので除外リストは空。
        () => selectBannerNotifications(notifications, user?.uid ? dismissedIds : [], mountedAt),
        [user?.uid, notifications, dismissedIds, mountedAt],
    );

    // 未認証時は dismiss の概念がないのでロード待ちにしない。
    const effectiveDismissalsLoaded = user?.uid ? dismissalsLoaded : true;
    const effectiveDismissalsPending = user?.uid ? dismissalsPending : false;
    const error = notificationsError ?? (user?.uid ? dismissalsError : null);
    const stale = Boolean(
        (notificationsError && notificationsLoaded)
        || (user?.uid && dismissalsError && dismissalsLoaded),
    );
    const retrying = Boolean(
        (notificationsError && notificationsPending)
        || (user?.uid && dismissalsError && dismissalsPending),
    );

    return {
        notifications,
        dismissedIds,
        loading: authLoading
            || (!notificationsLoaded && notificationsPending)
            || (!effectiveDismissalsLoaded && effectiveDismissalsPending),
        error,
        stale,
        retrying,
        retry,
        bannerNotifications,
    };
}

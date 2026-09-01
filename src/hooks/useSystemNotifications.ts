'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './useAuth';
import {
    SystemNotification,
    subscribeToDismissals,
    subscribeToPublishedNotifications,
} from '@/lib/systemNotifications';

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BANNER_ITEMS_AUTHED = 5;

export interface UseSystemNotificationsResult {
    notifications: SystemNotification[];
    dismissedIds: string[];
    loading: boolean;
    error: Error | null;
    stale: boolean;
    retrying: boolean;
    retry: () => void;
    /** ホーム最上部バナーに出す通知（dismiss 済み除外）。未認証時は1ヶ月以内最新1件のみ */
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
    // 1ヶ月以内判定の基準時刻。マウント時に固定して useMemo 内で純粋に扱えるようにする。
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

    const bannerNotifications = useMemo<SystemNotification[]>(() => {
        if (user?.uid) {
            const dismissed = new Set(dismissedIds);
            return notifications
                .filter(n => !dismissed.has(n.id))
                .slice(0, MAX_BANNER_ITEMS_AUTHED);
        }
        const cutoff = mountedAt - ONE_MONTH_MS;
        const latest = notifications.find(n => n.publishedAt.getTime() >= cutoff);
        return latest ? [latest] : [];
    }, [user?.uid, notifications, dismissedIds, mountedAt]);

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

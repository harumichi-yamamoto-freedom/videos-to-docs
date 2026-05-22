'use client';

import { useEffect, useMemo, useState } from 'react';
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
    /** ホーム最上部バナーに出す通知（dismiss 済み除外）。未認証時は1ヶ月以内最新1件のみ */
    bannerNotifications: SystemNotification[];
}

export function useSystemNotifications(): UseSystemNotificationsResult {
    const { user, loading: authLoading } = useAuth();
    const [notifications, setNotifications] = useState<SystemNotification[]>([]);
    const [dismissedIds, setDismissedIds] = useState<string[]>([]);
    const [notificationsLoaded, setNotificationsLoaded] = useState(false);
    const [dismissalsLoaded, setDismissalsLoaded] = useState(false);
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
    }

    useEffect(() => {
        const unsubscribe = subscribeToPublishedNotifications(list => {
            setNotifications(list);
            setNotificationsLoaded(true);
        });
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (!user?.uid) return;
        const unsubscribe = subscribeToDismissals(user.uid, ids => {
            setDismissedIds(ids);
            setDismissalsLoaded(true);
        });
        return () => unsubscribe();
    }, [user?.uid]);

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

    return {
        notifications,
        dismissedIds,
        loading: authLoading || !notificationsLoaded || !effectiveDismissalsLoaded,
        bannerNotifications,
    };
}

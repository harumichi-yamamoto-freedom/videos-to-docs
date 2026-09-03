import type { SystemNotification } from '@/lib/systemNotifications';

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

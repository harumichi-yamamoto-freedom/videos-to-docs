import type { useAdmin } from '@/hooks/useAdmin';
import type { useSystemNotifications } from '@/hooks/useSystemNotifications';

/*
 * フックのモックを 1 か所で組み立てる。
 * 戻り値の型を実物の ReturnType に縛ってあるので、フックの公開形が変わると
 * ここが tsc で赤くなる。各テストが独自に組み立てていると、実物が変わっても
 * モックだけが古い形を検定し続けて全緑のまま通ってしまう。
 */

type AdminAccessResult = ReturnType<typeof useAdmin>;
type SystemNotificationsResult = ReturnType<typeof useSystemNotifications>;

/**
 * status から他のフィールドを導出する。isAdmin や loading を独立に指定できると、
 * 実物では起こり得ない組合せ(denied なのに isAdmin=true など)をテストが作れてしまう。
 */
export function adminAccessResult(
    status: AdminAccessResult['status'],
    options: { uid?: string | null; retry?: () => void } = {},
): AdminAccessResult {
    const uid = options.uid ?? 'u1';
    return {
        status,
        checkedUid: status === 'checking' ? null : uid,
        isAdmin: status === 'allowed',
        loading: status === 'checking',
        retry: options.retry ?? (() => { }),
    };
}

export function systemNotificationsResult(
    overrides: Partial<SystemNotificationsResult> = {},
): SystemNotificationsResult {
    return {
        notifications: [],
        dismissedIds: [],
        loading: false,
        bannerNotifications: [],
        error: null,
        stale: false,
        retrying: false,
        retry: () => { },
        ...overrides,
    };
}

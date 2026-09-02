/**
 * 管理者機能フック
 */

import { useState, useEffect } from 'react';
import { useAuth } from './useAuth';
import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { createLogger } from '@/lib/logger';

const useAdminLogger = createLogger('useAdmin');

export type AdminAccessStatus = 'checking' | 'allowed' | 'denied' | 'error';

interface AdminAccessCheck {
    uid: string | null;
    status: AdminAccessStatus;
}

export function getVisibleAdminStatus(
    check: AdminAccessCheck,
    currentUid: string | null,
    authLoading: boolean,
): AdminAccessStatus {
    if (authLoading || check.uid !== currentUid) {
        return 'checking';
    }

    return check.status;
}

/**
 * 進行中の管理者判定。AppHeader と管理者ページのようにフックが同時に複数
 * マウントされても、users の読取は uid ごとに 1 回へ束ねる。確定したら
 * エントリを破棄し、次のマウントでは判定し直す（キャッシュにはしない:
 * セッション中の権限変更が再訪で反映されなくなるため）。
 */
const inFlightAdminChecks = new Map<string, Promise<AdminAccessStatus>>();

function checkAdminAccess(uid: string): Promise<AdminAccessStatus> {
    const inFlight = inFlightAdminChecks.get(uid);
    if (inFlight) return inFlight;

    const check: Promise<AdminAccessStatus> = getDoc(doc(db, 'users', uid))
        .then(userSnapshot =>
            userSnapshot.exists() && userSnapshot.data().superuser === true
                ? ('allowed' as const)
                : ('denied' as const))
        .catch((error: unknown) => {
            useAdminLogger.error('管理者権限チェックに失敗', error, { userId: uid });
            return 'error' as const;
        })
        .finally(() => {
            // retry() が先にエントリを無効化して新しい判定を張った場合、
            // 古い判定の完了で新しいエントリを消さない。
            if (inFlightAdminChecks.get(uid) === check) {
                inFlightAdminChecks.delete(uid);
            }
        });

    inFlightAdminChecks.set(uid, check);
    return check;
}

/**
 * retry の意味論は「再取得」。滞留中の古い判定が残っていても掴み直さず、
 * 次の判定で新しい読取を張れるようエントリを無効化する。
 */
function invalidateAdminCheck(uid: string): void {
    inFlightAdminChecks.delete(uid);
}

/**
 * 進行中の判定をすべて破棄する。モジュール状態を持つため、テストが
 * ケース間の暗黙結合を切る用途で呼ぶ（本体コードからは使わない）。
 */
export function clearInFlightAdminChecks(): void {
    inFlightAdminChecks.clear();
}

interface AdminAccessState {
    check: AdminAccessCheck;
    /** 再試行のたびに増やし、判定の useEffect を再入させるカウンタ。 */
    attempt: number;
}

export function useAdmin() {
    const { user, loading: authLoading } = useAuth();
    const currentUid = user?.uid ?? null;
    const [state, setState] = useState<AdminAccessState>({
        check: { uid: null, status: 'checking' },
        attempt: 0,
    });
    const { check, attempt } = state;

    useEffect(() => {
        let active = true;

        const checkAdmin = async () => {
            if (authLoading) return;

            if (!currentUid) {
                setState(previous => ({ ...previous, check: { uid: null, status: 'denied' } }));
                return;
            }

            const checkedUid = currentUid;
            setState(previous => ({ ...previous, check: { uid: checkedUid, status: 'checking' } }));

            const status = await checkAdminAccess(checkedUid);
            if (active) {
                setState(previous => ({ ...previous, check: { uid: checkedUid, status } }));
            }
        };

        void checkAdmin();

        return () => {
            active = false;
        };
    }, [currentUid, authLoading, attempt]);

    const status = getVisibleAdminStatus(check, currentUid, authLoading);

    /* error のまま出口が無いと、正規の管理者が一時障害で行き止まりに残る。
       attempt を進めて判定をやり直す。attempt は effect の依存にだけ効き、
       check を据え置くので再入しても表示中の判定は壊れない。
       滞留中の古い判定は無効化し、必ず新しい読取を張る（再取得の意味論）。

       設計トレードオフ（裁定済み）: retry はこのフックのインスタンスだけを
       再判定する。並行マウント中の別インスタンス（AppHeader など）は自分の
       結果を保持し続けるため、復旧までの間だけ判定が併存し得る。全消費者へ
       伝播させるには購読レジストリ（外部ストア化）が要るが、AppHeader 側の
       実害は「管理者リンクが次のマウントまで出ない」に限られ、ページ遷移で
       自然回復するので、配線を増やさないこの形を選んでいる。 */
    const retry = () => {
        if (currentUid) invalidateAdminCheck(currentUid);
        setState(previous => ({ ...previous, attempt: previous.attempt + 1 }));
    };

    return {
        status,
        checkedUid: status === 'checking' ? null : check.uid,
        isAdmin: status === 'allowed',
        loading: status === 'checking',
        retry,
    };
}

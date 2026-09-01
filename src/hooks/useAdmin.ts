/**
 * 管理者機能フック
 *
 * ⚠️ useAdmin.test.ts のハーネスは useState を「単一スロット」でモックし、useRef と
 * useCallback はモックしていない。このフックに useState を 2 本目として足すと 2 つの
 * 状態が同じスロットを共有して静かに壊れ、useRef / useCallback を足すと描画外呼び出しで
 * 例外になる。状態を増やすときは既存の state オブジェクトへ畳むこと（B波でハーネス側を
 * 直すまでの制約）。
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

interface AdminAccessState {
    check: AdminAccessCheck;
    /** 再試行のたびに増やし、判定の useEffect を再入させるカウンタ。 */
    attempt: number;
}

export function useAdmin() {
    const { user, loading: authLoading } = useAuth();
    const currentUid = user?.uid ?? null;
    // 判定と再試行カウンタは 1 つの state にまとめる。
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

            try {
                const userSnapshot = await getDoc(doc(db, 'users', checkedUid));

                if (!active) return;

                setState(previous => ({
                    ...previous,
                    check: {
                        uid: checkedUid,
                        status: userSnapshot.exists() && userSnapshot.data().superuser === true
                            ? 'allowed'
                            : 'denied',
                    },
                }));
            } catch (error) {
                useAdminLogger.error('管理者権限チェックに失敗', error, { userId: checkedUid });

                if (active) {
                    setState(previous => ({ ...previous, check: { uid: checkedUid, status: 'error' } }));
                }
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
       check を据え置くので再入しても表示中の判定は壊れない。 */
    const retry = () => {
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

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

export function useAdmin() {
    const { user, loading: authLoading } = useAuth();
    const currentUid = user?.uid ?? null;
    const [check, setCheck] = useState<AdminAccessCheck>({
        uid: null,
        status: 'checking',
    });

    useEffect(() => {
        let active = true;

        const checkAdmin = async () => {
            if (authLoading) return;

            if (!currentUid) {
                setCheck({ uid: null, status: 'denied' });
                return;
            }

            const checkedUid = currentUid;
            setCheck({ uid: checkedUid, status: 'checking' });

            try {
                const userSnapshot = await getDoc(doc(db, 'users', checkedUid));

                if (!active) return;

                setCheck({
                    uid: checkedUid,
                    status: userSnapshot.exists() && userSnapshot.data().superuser === true
                        ? 'allowed'
                        : 'denied',
                });
            } catch (error) {
                useAdminLogger.error('管理者権限チェックに失敗', error, { userId: checkedUid });

                if (active) {
                    setCheck({ uid: checkedUid, status: 'error' });
                }
            }
        };

        void checkAdmin();

        return () => {
            active = false;
        };
    }, [currentUid, authLoading]);

    const status = getVisibleAdminStatus(check, currentUid, authLoading);

    return {
        status,
        checkedUid: status === 'checking' ? null : check.uid,
        isAdmin: status === 'allowed',
        loading: status === 'checking',
    };
}

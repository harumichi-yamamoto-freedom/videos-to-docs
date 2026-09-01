/**
 * 管理者機能フック
 */

import { useCallback, useState, useEffect } from 'react';
import { useAuth } from './useAuth';
import { isSuperuser } from '@/lib/userManagement';
import { createLogger } from '@/lib/logger';

const useAdminLogger = createLogger('useAdmin');

export interface UseAdminResult {
    isAdmin: boolean;
    loading: boolean;
    /** 権限の判定自体が失敗した状態。isAdmin=false（権限なし）と区別すること。 */
    error: Error | null;
    retry: () => void;
}

export function useAdmin(): UseAdminResult {
    const { user, loading: authLoading } = useAuth();
    const [isAdmin, setIsAdmin] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;

        const checkAdmin = async () => {
            if (authLoading) return;

            if (!user) {
                if (cancelled) return;
                setIsAdmin(false);
                setError(null);
                setLoading(false);
                return;
            }

            try {
                const adminStatus = await isSuperuser(user.uid);
                if (cancelled) return;
                setIsAdmin(adminStatus);
                setError(null);
            } catch (caught) {
                useAdminLogger.error('管理者権限チェックに失敗', caught, { userId: user.uid });
                if (cancelled) return;
                setIsAdmin(false);
                setError(caught instanceof Error ? caught : new Error(String(caught)));
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        checkAdmin();

        return () => {
            cancelled = true;
        };
    }, [user, authLoading, attempt]);

    const retry = useCallback(() => {
        setLoading(true);
        setError(null);
        setAttempt(previous => previous + 1);
    }, []);

    return { isAdmin, loading, error, retry };
}

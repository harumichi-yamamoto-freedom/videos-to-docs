/**
 * 管理者機能フック
 */

import { useState, useEffect } from 'react';
import { useAuth } from './useAuth';
import { isSuperuser } from '@/lib/userManagement';

export function useAdmin() {
    const { user, loading: authLoading } = useAuth();
    const [isAdmin, setIsAdmin] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const checkAdmin = async () => {
            if (authLoading) return;

            if (!user) {
                setIsAdmin(false);
                setLoading(false);
                return;
            }

            try {
                const adminStatus = await isSuperuser(user.uid);
                setIsAdmin(adminStatus);
            } catch (error) {
                console.error('管理者チェックエラー:', error);
                setIsAdmin(false);
            } finally {
                setLoading(false);
            }
        };

        checkAdmin();
    }, [user, authLoading]);

    return { isAdmin, loading };
}


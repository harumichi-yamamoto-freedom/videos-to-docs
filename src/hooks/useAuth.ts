import { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import { subscribeAuth } from '@/lib/auth';

/**
 * 認証状態を管理するカスタムフック
 */
export function useAuth() {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const unsubscribe = subscribeAuth((user) => {
            setUser(user);
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    return { user, loading };
}


import { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import { subscribeAuth } from '@/lib/auth';
import { createOrUpdateUserProfile } from '@/lib/userManagement';
import { createLogger } from '@/lib/logger';

const useAuthLogger = createLogger('useAuth');

/**
 * 認証状態を管理するカスタムフック
 * ログイン時に自動的にFirestoreプロファイルを作成/更新
 */
export function useAuth() {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const unsubscribe = subscribeAuth(async (authUser) => {
            setUser(authUser);

            // ユーザーがログインしている場合、Firestoreプロファイルを確認・作成
            if (authUser) {
                try {
                    useAuthLogger.info('Firestoreユーザープロファイルを同期', { userId: authUser.uid });
                    await createOrUpdateUserProfile(
                        authUser.uid,
                        authUser.email || '',
                        authUser.displayName || undefined
                    );
                    useAuthLogger.info('Firestoreユーザープロファイルの同期完了', { userId: authUser.uid });
                } catch (error) {
                    useAuthLogger.error('Firestoreユーザープロファイルの同期に失敗', error, {
                        userId: authUser.uid,
                    });
                    // エラーがあってもログインは継続（認証は成功している）
                }
            }

            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    return { user, loading };
}


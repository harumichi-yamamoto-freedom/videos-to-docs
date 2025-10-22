import { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import { subscribeAuth } from '@/lib/auth';
import { createOrUpdateUserProfile } from '@/lib/userManagement';

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
                    console.log('🔄 Firestoreユーザープロファイルを同期中...');
                    await createOrUpdateUserProfile(
                        authUser.uid,
                        authUser.email || '',
                        authUser.displayName || undefined
                    );
                    console.log('✅ Firestoreユーザープロファイルの同期完了');
                } catch (error) {
                    console.error('❌ Firestoreプロファイル同期エラー:', error);
                    // エラーがあってもログインは継続（認証は成功している）
                }
            }

            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    return { user, loading };
}


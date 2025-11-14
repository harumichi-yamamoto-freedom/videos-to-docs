/**
 * ユーザー管理
 */

import { db } from './firebase';
import { collection, doc, getDoc, setDoc, getDocs, query, orderBy, serverTimestamp, Timestamp, where, limit } from 'firebase/firestore';
import { createLogger } from './logger';

const userManagementLogger = createLogger('userManagement');

export interface UserProfile {
    uid: string;
    email: string;
    displayName?: string;
    superuser: boolean;
    createdAt: Date | Timestamp;
    lastLoginAt?: Date | Timestamp;
    promptCount?: number;
    documentCount?: number;
}

/**
 * ユーザープロファイルを作成または更新
 */
export async function createOrUpdateUserProfile(
    uid: string,
    email: string,
    displayName?: string,
    superuser: boolean = false
): Promise<void> {
    try {
        const userRef = doc(db, 'users', uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
            // 既存ユーザーの場合、最終ログイン日時のみ更新
            const updateData: Record<string, string | object> = {
                lastLoginAt: serverTimestamp(),
            };

            // displayNameがある場合のみ更新
            if (displayName) {
                updateData.displayName = displayName;
            } else if (!userSnap.data().displayName && displayName !== undefined) {
                // 既存データにもなく、新しい値もない場合は何もしない
            }

            await setDoc(userRef, updateData, { merge: true });
        } else {
            // 新規ユーザーの場合
            const userData: Record<string, string | number | boolean | object> = {
                uid,
                email,
                superuser,
                createdAt: serverTimestamp(),
                lastLoginAt: serverTimestamp(),
                promptCount: 0,
                documentCount: 0,
            };

            // displayNameがある場合のみ追加
            if (displayName) {
                userData.displayName = displayName;
            }

            await setDoc(userRef, userData);

            // 新規ユーザーのデフォルトプロンプトを作成
            try {
                const { createDefaultPromptsForUser } = await import('./prompts');
                await createDefaultPromptsForUser(uid, 'user');
            } catch (error) {
                userManagementLogger.error('デフォルトプロンプトの作成に失敗（ユーザー作成は成功）', error, {
                    uid,
                });
                // エラーが発生してもユーザー作成は成功扱い
            }
        }
    } catch (error) {
        userManagementLogger.error('ユーザープロファイルの作成または更新に失敗', error, { uid, email });
        throw new Error('ユーザープロファイルの作成に失敗しました');
    }
}

/**
 * ユーザープロファイルを取得
 */
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
    try {
        const userRef = doc(db, 'users', uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
            const data = userSnap.data();
            return {
                uid: data.uid,
                email: data.email,
                displayName: data.displayName,
                superuser: data.superuser || false,
                createdAt: data.createdAt.toDate(),
                lastLoginAt: data.lastLoginAt?.toDate(),
                promptCount: data.promptCount,
                documentCount: data.documentCount,
            };
        }

        return null;
    } catch (error) {
        userManagementLogger.error('ユーザープロファイルの取得に失敗', error, { uid });
        return null;
    }
}

/**
 * すべてのユーザーを取得（管理者用）
 */
export async function getAllUsers(): Promise<UserProfile[]> {
    try {
        const q = query(
            collection(db, 'users'),
            orderBy('createdAt', 'desc')
        );

        const snapshot = await getDocs(q);
        const users: UserProfile[] = [];

        snapshot.forEach((doc) => {
            const data = doc.data();
            users.push({
                uid: data.uid,
                email: data.email,
                displayName: data.displayName,
                superuser: data.superuser || false,
                createdAt: data.createdAt.toDate(),
                lastLoginAt: data.lastLoginAt?.toDate(),
                promptCount: data.promptCount,
                documentCount: data.documentCount,
            });
        });

        return users;
    } catch (error) {
        userManagementLogger.error('ユーザー一覧の取得に失敗', error);
        throw new Error('ユーザー一覧の取得に失敗しました');
    }
}

/**
 * メールアドレスからユーザープロファイルを取得
 */
export async function getUserByEmail(email: string): Promise<UserProfile | null> {
    try {
        userManagementLogger.info('メールアドレスによるユーザー検索を開始', { email });
        const q = query(
            collection(db, 'users'),
            where('email', '==', email),
            limit(1)
        );

        const snapshot = await getDocs(q);
        if (snapshot.empty) {
            userManagementLogger.warn('メールアドレスによるユーザー検索に一致なし', { email });
            return null;
        }

        const docSnap = snapshot.docs[0];
        const data = docSnap.data();

        const userProfile: UserProfile = {
            uid: data.uid,
            email: data.email,
            displayName: data.displayName,
            superuser: data.superuser || false,
            createdAt: data.createdAt?.toDate?.() ?? data.createdAt,
            lastLoginAt: data.lastLoginAt?.toDate?.(),
            promptCount: data.promptCount,
            documentCount: data.documentCount,
        };
        userManagementLogger.info('メールアドレスによるユーザー検索が完了', {
            email,
            uid: userProfile.uid,
        });
        return userProfile;
    } catch (error) {
        userManagementLogger.error('メールアドレスによるユーザー検索に失敗', error, { email });
        return null;
    }
}

/**
 * ユーザーが管理者かどうかをチェック
 */
export async function isSuperuser(uid: string): Promise<boolean> {
    try {
        const profile = await getUserProfile(uid);
        return profile?.superuser || false;
    } catch (error) {
        userManagementLogger.error('管理者権限チェックに失敗', error, { uid });
        return false;
    }
}

/**
 * ユーザーの統計情報を更新
 */
export async function updateUserStats(uid: string, incrementPrompts: number = 0, incrementDocuments: number = 0): Promise<void> {
    try {
        const userRef = doc(db, 'users', uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
            const data = userSnap.data();
            await setDoc(
                userRef,
                {
                    promptCount: (data.promptCount || 0) + incrementPrompts,
                    documentCount: (data.documentCount || 0) + incrementDocuments,
                },
                { merge: true }
            );
        }
    } catch (error) {
        userManagementLogger.error('ユーザー統計情報の更新に失敗', error, {
            uid,
            incrementPrompts,
            incrementDocuments,
        });
    }
}


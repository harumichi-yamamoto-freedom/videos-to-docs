import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInWithPopup,
    GoogleAuthProvider,
    signOut,
    onAuthStateChanged,
    User,
} from 'firebase/auth';
import { auth } from './firebase';
import { createOrUpdateUserProfile } from './userManagement';
import { logAudit } from './auditLog';

/**
 * メールアドレスとパスワードでサインアップ
 */
export async function signUp(email: string, password: string): Promise<User> {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // ユーザープロファイルを作成（エラーがあってもサインアップは成功）
    try {
        await createOrUpdateUserProfile(user.uid, user.email || email, user.displayName || undefined);
        await logAudit('user_signup', 'user', user.uid, { userEmail: user.email || email });
    } catch (error) {
        console.error('⚠️ プロファイル作成エラー（認証は成功）:', error);
        // useAuth フックが後で再試行するため、ここでは無視
    }

    return user;
}

/**
 * メールアドレスとパスワードでサインイン
 */
export async function signIn(email: string, password: string): Promise<User> {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // ユーザープロファイルを更新（エラーがあってもログインは成功）
    try {
        await createOrUpdateUserProfile(user.uid, user.email || email, user.displayName || undefined);
        await logAudit('user_login', 'user', user.uid, { userEmail: user.email || email });
    } catch (error) {
        console.error('⚠️ プロファイル更新エラー（認証は成功）:', error);
        // useAuth フックが後で再試行するため、ここでは無視
    }

    return user;
}

/**
 * Googleアカウントでサインイン
 */
export async function signInWithGoogle(): Promise<User> {
    const provider = new GoogleAuthProvider();
    const userCredential = await signInWithPopup(auth, provider);
    const user = userCredential.user;

    // ユーザープロファイルを作成または更新（エラーがあってもログインは成功）
    try {
        await createOrUpdateUserProfile(user.uid, user.email || '', user.displayName || undefined);
        await logAudit('user_login', 'user', user.uid, { userEmail: user.email || '', provider: 'google' });
    } catch (error) {
        console.error('⚠️ プロファイル作成エラー（認証は成功）:', error);
        // useAuth フックが後で再試行するため、ここでは無視
    }

    return user;
}

/**
 * サインアウト
 */
export async function signOutNow(): Promise<void> {
    const user = auth.currentUser;

    // 監査ログを記録（ログアウト前に記録）
    if (user) {
        await logAudit('user_logout', 'user', user.uid, { userEmail: user.email || undefined });
    }

    await signOut(auth);
}

/**
 * 認証状態の変更を購読
 */
export function subscribeAuth(callback: (user: User | null) => Promise<void> | void): () => void {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
        await callback(user);
    });
    return unsubscribe;
}

/**
 * 現在のユーザーを取得
 */
export function getCurrentUser(): User | null {
    return auth.currentUser;
}

/**
 * ログイン中かどうかを確認
 */
export function isSignedIn(): boolean {
    return auth.currentUser !== null;
}

/**
 * 現在のユーザーIDを取得（ゲストの場合は "GUEST"）
 */
export function getCurrentUserId(): string {
    return auth.currentUser?.uid ?? 'GUEST';
}

/**
 * 所有者タイプを取得（"user" または "guest"）
 */
export function getOwnerType(): 'user' | 'guest' {
    return auth.currentUser ? 'user' : 'guest';
}

/**
 * アカウントを削除（ユーザー本人のみ）
 * 重要: Firestoreデータを先に削除してから、Authenticationアカウントを削除
 * （順序を逆にすると、認証が切れてFirestoreデータを削除できなくなる）
 */
export async function deleteAccount(): Promise<void> {
    // 最新のユーザーオブジェクトを取得（再認証後の状態を確実に反映）
    const user = auth.currentUser;
    if (!user) {
        throw new Error('ログインしていません');
    }

    const uid = user.uid;
    const email = user.email || undefined;

    try {
        console.log('🔐 認証状態を確認中...');
        // 最新の認証トークンを取得
        const token = await user.getIdToken(true);
        console.log('✅ 認証トークン取得完了:', token ? 'OK' : 'NG');

        // ステップ1: Firestoreの関連データを削除（認証が有効なうちに）
        console.log('🗑️ Firestoreデータ削除中...');
        const { deleteUserData } = await import('./accountDeletion');
        await deleteUserData(uid, email);
        console.log('✅ Firestoreデータ削除完了');

        // ステップ2: Firebase Authentication のアカウントを削除
        // （Firestoreデータを削除した後なので、認証が切れても問題ない）
        console.log('🗑️ Authenticationアカウント削除中...');

        // auth.currentUser を再取得（最新の認証状態を確実に使用）
        const currentUser = auth.currentUser;
        if (!currentUser) {
            throw new Error('ユーザーが見つかりません');
        }

        await currentUser.delete();

        console.log('✅ Authenticationアカウント削除完了');
    } catch (error: any) {
        console.error('❌ アカウント削除エラー:', error);

        // Firestoreデータは削除済みだが、Authenticationの削除に失敗した場合
        if (error.code === 'auth/requires-recent-login') {
            console.error('⚠️ Firestoreデータは削除されましたが、Authenticationアカウントの削除に失敗しました');
            console.error('💡 再度ログインして、もう一度アカウント削除を実行してください');
        }

        throw error;
    }
}


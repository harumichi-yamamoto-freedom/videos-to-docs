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
 * Firebase Authentication のアカウントと Firestore の関連データをすべて削除
 */
export async function deleteAccount(): Promise<void> {
    const user = auth.currentUser;
    if (!user) {
        throw new Error('ログインしていません');
    }

    try {
        console.log('🔐 認証トークンをリフレッシュ中...');
        // 認証トークンを強制リフレッシュ（再認証後のトークン更新を確実にする）
        await user.getIdToken(true);
        console.log('✅ トークンリフレッシュ完了');

        // Firestoreの関連データを削除
        console.log('🗑️ Firestoreデータ削除中...');
        const { deleteUserData } = await import('./accountDeletion');
        await deleteUserData(user.uid, user.email || undefined);
        console.log('✅ Firestoreデータ削除完了');

        // Firebase Authentication のアカウントを削除
        console.log('🗑️ Authenticationアカウント削除中...');
        await user.delete();
        console.log('✅ Authenticationアカウント削除完了');
    } catch (error) {
        console.error('アカウント削除エラー:', error);
        throw error;
    }
}


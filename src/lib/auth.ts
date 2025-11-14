import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInWithPopup,
    GoogleAuthProvider,
    signOut,
    onAuthStateChanged,
    updateProfile,
    User,
} from 'firebase/auth';
import { auth } from './firebase';
import { createOrUpdateUserProfile } from './userManagement';
import { logAudit } from './auditLog';
import { createLogger } from './logger';

const authLogger = createLogger('auth');

/**
 * メールアドレスとパスワードでサインアップ
 */
export async function signUp(email: string, password: string, displayName?: string): Promise<User> {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    const trimmedDisplayName = displayName?.trim();

    if (trimmedDisplayName) {
        await updateProfile(user, { displayName: trimmedDisplayName });
    }

    // ユーザープロファイルを作成（エラーがあってもサインアップは成功）
    try {
        await createOrUpdateUserProfile(
            user.uid,
            user.email || email,
            user.displayName || trimmedDisplayName || undefined
        );
        await logAudit('user_signup', 'user', user.uid, {
            userEmail: user.email || email,
            displayName: user.displayName || trimmedDisplayName || '',
        });
    } catch (error) {
        authLogger.error('サインアップ後のプロファイル作成に失敗', error);
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
        authLogger.error('サインイン後のプロファイル更新に失敗', error);
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
        authLogger.error('Googleサインイン後のプロファイル作成に失敗', error);
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
        await logAudit('user_logout', 'user', user.uid, { userEmail: user.email || '' });
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
        authLogger.info('アカウント削除を開始', { uid });

        // 最新の認証トークンを取得
        await user.getIdToken(true);

        // ステップ1: Firestoreの関連データを削除（認証が有効なうちに）
        authLogger.info('関連Firestoreデータの削除を開始', { uid });
        const { deleteUserData } = await import('./accountDeletion');
        await deleteUserData(uid, email);
        authLogger.info('関連Firestoreデータの削除が完了', { uid });

        // ステップ2: Firebase Authentication のアカウントを削除
        // （Firestoreデータを削除した後なので、認証が切れても問題ない）
        authLogger.info('Authenticationアカウントの削除を実行', { uid });

        // auth.currentUser を再取得（最新の認証状態を確実に使用）
        const currentUser = auth.currentUser;
        if (!currentUser) {
            throw new Error('ユーザーが見つかりません');
        }

        await currentUser.delete();

        authLogger.info('アカウント削除が完了', { uid });
    } catch (error) {
        const firebaseError = error as { code?: string; message?: string };
        authLogger.error('アカウント削除でエラーが発生', error, { uid });

        // Firestoreデータは削除済みだが、Authenticationの削除に失敗した場合
        if (firebaseError.code === 'auth/requires-recent-login') {
            authLogger.warn('再認証が必要なためAuthenticationの削除に失敗', { uid });
        }

        throw error;
    }
}

/**
 * 表示名を更新
 */
export async function updateUserDisplayName(newDisplayName: string): Promise<void> {
    const user = auth.currentUser;
    if (!user) {
        throw new Error('ログインしていません');
    }

    const trimmed = newDisplayName.trim();
    if (!trimmed) {
        throw new Error('表示名を入力してください');
    }

    await updateProfile(user, { displayName: trimmed });
    await user.reload();

    await createOrUpdateUserProfile(user.uid, user.email || '', trimmed);
    await logAudit('user_display_name_update', 'user', user.uid, {
        userEmail: user.email || '',
        displayName: trimmed,
    });
}


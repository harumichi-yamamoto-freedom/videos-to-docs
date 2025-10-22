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

/**
 * メールアドレスとパスワードでサインアップ
 */
export async function signUp(email: string, password: string): Promise<User> {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    return userCredential.user;
}

/**
 * メールアドレスとパスワードでサインイン
 */
export async function signIn(email: string, password: string): Promise<User> {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return userCredential.user;
}

/**
 * Googleアカウントでサインイン
 */
export async function signInWithGoogle(): Promise<User> {
    const provider = new GoogleAuthProvider();
    const userCredential = await signInWithPopup(auth, provider);
    return userCredential.user;
}

/**
 * サインアウト
 */
export async function signOutNow(): Promise<void> {
    await signOut(auth);
}

/**
 * 認証状態の変更を購読
 */
export function subscribeAuth(callback: (user: User | null) => void): () => void {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
        callback(user);
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


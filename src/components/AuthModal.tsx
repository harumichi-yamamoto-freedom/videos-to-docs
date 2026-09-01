'use client';

import {
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type FormEvent,
} from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { signIn, signUp, signInWithGoogle } from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const authModalLogger = createLogger('AuthModal');

interface AuthModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess?: () => void;
}

type AuthErrorField = 'displayName' | 'email' | 'password' | 'credentials' | 'form';

interface AuthError {
    field: AuthErrorField;
    message: string;
}

function getAuthError(error: unknown, source: 'email' | 'google'): AuthError {
    const code = (error as { code?: string }).code;
    if (code === 'auth/network-request-failed') {
        return {
            field: 'form',
            message: '通信に失敗しました。ネットワーク接続をご確認ください。',
        };
    }
    if (code === 'auth/too-many-requests') {
        return {
            field: 'form',
            message: '試行回数が多すぎます。しばらく待ってからもう一度お試しください。',
        };
    }

    if (source === 'google') {
        if (code === 'auth/popup-closed-by-user') {
            return { field: 'form', message: 'Google認証がキャンセルされました。' };
        }
        if (code === 'auth/popup-blocked') {
            return {
                field: 'form',
                message: 'Google認証画面を開けませんでした。ブラウザの設定をご確認ください。',
            };
        }
        if (code === 'auth/account-exists-with-different-credential') {
            return {
                field: 'form',
                message: '同じメールアドレスのアカウントが別の方法で登録されています。',
            };
        }
        return { field: 'form', message: 'Google認証に失敗しました。もう一度お試しください。' };
    }

    if (code === 'auth/invalid-email') {
        return { field: 'email', message: 'メールアドレスの形式が正しくありません。' };
    }
    if (code === 'auth/email-already-in-use') {
        return { field: 'email', message: 'このメールアドレスは既に使用されています。' };
    }
    if (code === 'auth/weak-password') {
        return { field: 'password', message: 'パスワードは6文字以上で入力してください。' };
    }
    if (
        code === 'auth/invalid-credential'
        || code === 'auth/wrong-password'
        || code === 'auth/user-not-found'
    ) {
        return {
            field: 'credentials',
            message: 'メールアドレスまたはパスワードが正しくありません。',
        };
    }
    return { field: 'form', message: '認証に失敗しました。もう一度お試しください。' };
}

export default function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [error, setError] = useState<AuthError | null>(null);
    const [loading, setLoading] = useState(false);
    const firstInputRef = useRef<HTMLInputElement>(null);
    const titleId = useId();
    const displayNameId = useId();
    const emailId = useId();
    const passwordId = useId();
    const errorId = useId();

    const resetAuthState = useCallback(() => {
        setMode('signin');
        setEmail('');
        setPassword('');
        setDisplayName('');
        setError(null);
        setLoading(false);
    }, []);

    useEffect(() => {
        if (!isOpen) resetAuthState();
    }, [isOpen, resetAuthState]);

    const handleClose = () => {
        resetAuthState();
        onClose();
    };

    const switchMode = (nextMode: 'signin' | 'signup') => {
        // The two modes reuse the same fields; carrying a value over would send
        // the sign-in password to signUp as the new password.
        setEmail('');
        setPassword('');
        setDisplayName('');
        setError(null);
        setMode(nextMode);
    };

    // Authentication already succeeded once we get here, so no step after it may
    // reach the caller's catch and be reported as an auth failure.
    const runPostAuthStep = (description: string, step: () => void) => {
        try {
            step();
        } catch (error) {
            authModalLogger.error(description, error);
        }
    };

    const handleAuthSuccess = () => {
        runPostAuthStep('認証成功後の処理に失敗', () => onSuccess?.());
        runPostAuthStep('認証成功後の閉鎖処理に失敗', handleClose);
    };

    const handleEmailAuth = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);

        const trimmedDisplayName = displayName.trim();
        if (mode === 'signup' && !trimmedDisplayName) {
            setError({
                field: 'displayName',
                message: '表示名を入力してください。',
            });
            return;
        }
        if (!email.trim()) {
            setError({
                field: 'email',
                message: 'メールアドレスを入力してください。',
            });
            return;
        }
        if (!password) {
            setError({
                field: 'password',
                message: 'パスワードを入力してください。',
            });
            return;
        }
        if (password.length < 6) {
            setError({
                field: 'password',
                message: 'パスワードは6文字以上で入力してください。',
            });
            return;
        }

        setLoading(true);
        try {
            if (mode === 'signin') {
                await signIn(email, password);
            } else {
                await signUp(email, password, trimmedDisplayName);
            }
            handleAuthSuccess();
        } catch (caughtError) {
            setError(getAuthError(caughtError, 'email'));
        } finally {
            setLoading(false);
        }
    };

    const handleGoogleSignIn = async () => {
        setError(null);
        setLoading(true);

        try {
            await signInWithGoogle();
            handleAuthSuccess();
        } catch (caughtError) {
            setError(getAuthError(caughtError, 'google'));
        } finally {
            setLoading(false);
        }
    };

    const displayNameInvalid = error?.field === 'displayName';
    const emailInvalid = error?.field === 'email' || error?.field === 'credentials';
    const passwordInvalid = error?.field === 'password' || error?.field === 'credentials';

    return (
        <Dialog
            isOpen={isOpen}
            onClose={handleClose}
            initialFocusRef={firstInputRef}
            dismissible={!loading}
            aria-labelledby={titleId}
            className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-lg border-0 bg-white shadow-xl"
        >
            <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
                    <h2 id={titleId} className="text-xl font-bold text-gray-900">
                        {mode === 'signin' ? 'ログイン' : 'アカウント作成'}
                    </h2>
                    <button
                        type="button"
                        onClick={handleClose}
                        disabled={loading}
                        aria-label="閉じる"
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-xl text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <span aria-hidden="true">✕</span>
                    </button>
                </div>

                <form
                    onSubmit={handleEmailAuth}
                    className="flex min-h-0 flex-1 flex-col"
                    noValidate
                >
                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
                        {error && (
                            <div
                                id={errorId}
                                role="alert"
                                className="rounded-lg bg-red-100 p-3 text-sm text-red-700"
                            >
                                {error.message}
                            </div>
                        )}

                        {mode === 'signup' && (
                            <div>
                                <label htmlFor={displayNameId} className="mb-1 block text-sm font-medium text-gray-800">
                                    表示名
                                </label>
                                <input
                                    ref={firstInputRef}
                                    id={displayNameId}
                                    type="text"
                                    value={displayName}
                                    onChange={(event) => setDisplayName(event.target.value)}
                                    aria-invalid={displayNameInvalid || undefined}
                                    aria-describedby={displayNameInvalid ? errorId : undefined}
                                    className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    maxLength={50}
                                    placeholder="例: 山田 太郎"
                                    required
                                    disabled={loading}
                                    autoComplete="name"
                                />
                            </div>
                        )}

                        <div>
                            <label htmlFor={emailId} className="mb-1 block text-sm font-medium text-gray-800">
                                メールアドレス
                            </label>
                            <input
                                ref={mode === 'signin' ? firstInputRef : undefined}
                                id={emailId}
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                aria-invalid={emailInvalid || undefined}
                                aria-describedby={emailInvalid ? errorId : undefined}
                                className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                                required
                                disabled={loading}
                                autoComplete="email"
                            />
                        </div>

                        <div>
                            <label htmlFor={passwordId} className="mb-1 block text-sm font-medium text-gray-800">
                                パスワード
                            </label>
                            <input
                                id={passwordId}
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                aria-invalid={passwordInvalid || undefined}
                                aria-describedby={passwordInvalid ? errorId : undefined}
                                className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                                required
                                minLength={6}
                                disabled={loading}
                                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                            />
                        </div>

                        <div className="text-center text-sm text-gray-500">または</div>

                        <button
                            type="button"
                            onClick={handleGoogleSignIn}
                            disabled={loading}
                            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-gray-300 py-2 text-gray-800 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:opacity-60"
                        >
                            <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24">
                                <path
                                    fill="#4285F4"
                                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                />
                                <path
                                    fill="#34A853"
                                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                />
                                <path
                                    fill="#FBBC05"
                                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                />
                                <path
                                    fill="#EA4335"
                                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                />
                            </svg>
                            Googleでログイン
                        </button>

                        <div className="text-center text-sm text-gray-700">
                            {mode === 'signin' ? (
                                <p>
                                    アカウントをお持ちでない方は{' '}
                                    <button
                                        type="button"
                                        onClick={() => switchMode('signup')}
                                        disabled={loading}
                                        className="min-h-11 rounded px-1 text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                    >
                                        アカウント作成
                                    </button>
                                </p>
                            ) : (
                                <p>
                                    既にアカウントをお持ちの方は{' '}
                                    <button
                                        type="button"
                                        onClick={() => switchMode('signin')}
                                        disabled={loading}
                                        className="min-h-11 rounded px-1 text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                    >
                                        ログイン
                                    </button>
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="sticky bottom-0 z-10 shrink-0 border-t border-gray-200 bg-white px-6 py-4">
                        <button
                            type="submit"
                            disabled={loading}
                            className="min-h-11 w-full rounded-lg bg-blue-700 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-500"
                        >
                            {loading ? '処理中...' : mode === 'signin' ? 'ログイン' : 'アカウント作成'}
                        </button>
                    </div>
                </form>
            </div>
        </Dialog>
    );
}

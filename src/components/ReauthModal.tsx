'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { reauthenticateWithCredential, EmailAuthProvider, reauthenticateWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { createLogger } from '@/lib/logger';
import { Dialog } from './ui/Dialog';

const reauthModalLogger = createLogger('ReauthModal');

export type ReauthenticationCloseReason = 'dismiss' | 'complete';

interface ReauthModalProps {
    isOpen: boolean;
    onClose: (reason: ReauthenticationCloseReason) => void;
    onSuccess: () => Promise<void>;
}

export class ReauthenticationAttemptGuard {
    private attemptToken = 0;
    private open = false;

    activate() {
        this.open = true;
    }

    begin(): number {
        this.attemptToken += 1;
        return this.attemptToken;
    }

    invalidate() {
        this.open = false;
        this.attemptToken += 1;
    }

    isActive(attemptToken: number): boolean {
        return this.open && this.attemptToken === attemptToken;
    }
}

export function canDismissReauthentication(loading: boolean): boolean {
    return !loading;
}

export async function continueAfterSuccessfulReauthentication(
    attemptGuard: ReauthenticationAttemptGuard,
    attemptToken: number,
    onSuccess: () => Promise<void>,
): Promise<boolean> {
    if (!attemptGuard.isActive(attemptToken)) return false;

    await onSuccess();
    return attemptGuard.isActive(attemptToken);
}

function getReauthenticationErrorMessage(error: unknown, provider: 'email' | 'google'): string {
    const errorCode = (error as { code?: string }).code;

    if (errorCode === 'auth/wrong-password' || errorCode === 'auth/invalid-credential') {
        return 'パスワードが正しくありません。';
    }
    if (errorCode === 'auth/too-many-requests') {
        return '試行回数が多すぎます。時間をおいてからもう一度お試しください。';
    }
    if (errorCode === 'auth/popup-closed-by-user' || errorCode === 'auth/cancelled-popup-request') {
        return 'Googleでの再認証がキャンセルされました。';
    }

    return provider === 'google'
        ? 'Googleで再認証できませんでした。もう一度お試しください。'
        : '再認証できませんでした。もう一度お試しください。';
}

export default function ReauthModal({ isOpen, onClose, onSuccess }: ReauthModalProps) {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [attemptGuard] = useState(() => new ReauthenticationAttemptGuard());
    // このモーダルはパスワード変更とアカウント削除の両方から同時にマウントされ得る。
    // 静的な id 文字列は DOM 内で重複するため useId で採番する。
    const titleId = useId();
    const passwordInputRef = useRef<HTMLInputElement>(null);
    const googleButtonRef = useRef<HTMLButtonElement>(null);
    const unknownProviderCloseRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (isOpen) {
            attemptGuard.activate();
            setPassword('');
            setError('');
        } else {
            attemptGuard.invalidate();
            setLoading(false);
            // The dialog stays mounted while closed, so a parent which only
            // flips isOpen would otherwise leave the password in its DOM.
            setPassword('');
            setError('');
        }

        return () => {
            attemptGuard.invalidate();
        };
    }, [attemptGuard, isOpen]);

    const user = auth.currentUser;

    // メール認証ユーザーかどうか
    const isEmailProvider = Boolean(
        user?.providerData.some(p => p.providerId === 'password'),
    );
    const isGoogleProvider = Boolean(
        user?.providerData.some(p => p.providerId === 'google.com'),
    );

    // 認証方法ごとに描かれる分岐は1つだけなので、初期フォーカス先もその分岐の
    // 主操作へ切り替える（Dialog は最新の ref を開いた時点で読む）。
    const initialFocusRef = isEmailProvider
        ? passwordInputRef
        : isGoogleProvider
            ? googleButtonRef
            : unknownProviderCloseRef;

    const handleDismiss = () => {
        if (!canDismissReauthentication(loading)) return;

        attemptGuard.invalidate();
        setPassword('');
        setError('');
        onClose('dismiss');
    };

    const runReauthentication = async (
        provider: 'email' | 'google',
        reauthenticate: () => Promise<unknown>,
    ) => {
        if (!user) return;

        const attemptToken = attemptGuard.begin();
        let reauthenticationCompleted = false;

        setError('');
        setLoading(true);

        try {
            await reauthenticate();
            if (!attemptGuard.isActive(attemptToken)) return;

            reauthenticationCompleted = true;
            reauthModalLogger.info(`${provider === 'email' ? 'メール' : 'Google'}による再認証に成功`, {
                userId: user.uid,
            });

            const actionCompleted = await continueAfterSuccessfulReauthentication(
                attemptGuard,
                attemptToken,
                onSuccess,
            );
            if (!actionCompleted) return;

            attemptGuard.invalidate();
            setLoading(false);
            setPassword('');
            onClose('complete');
        } catch (err) {
            if (!attemptGuard.isActive(attemptToken)) return;

            reauthModalLogger.error(
                reauthenticationCompleted ? '再認証後の処理に失敗' : '再認証に失敗',
                err,
                { userId: user.uid, provider },
            );
            // The attempt is over either way: a credential which failed, or one
            // which already did its job, must not stay in the DOM.
            setPassword('');
            setError(
                reauthenticationCompleted
                    ? '認証後の処理を完了できませんでした。もう一度お試しください。'
                    : getReauthenticationErrorMessage(err, provider),
            );
        } finally {
            if (attemptGuard.isActive(attemptToken)) {
                setLoading(false);
            }
        }
    };

    const handleEmailReauth = async (event: React.FormEvent) => {
        event.preventDefault();

        await runReauthentication('email', async () => {
            if (!user?.email) {
                throw new Error('auth/email-unavailable');
            }

            const credential = EmailAuthProvider.credential(user.email, password);
            await reauthenticateWithCredential(user, credential);
        });
    };

    const handleGoogleReauth = async () => {
        if (!user) return;

        await runReauthentication('google', () =>
            reauthenticateWithPopup(user, new GoogleAuthProvider()),
        );
    };

    return (
        <Dialog
            isOpen={isOpen && Boolean(user)}
            onClose={handleDismiss}
            initialFocusRef={initialFocusRef}
            dismissible={canDismissReauthentication(loading)}
            aria-labelledby={titleId}
            aria-busy={loading}
            className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-lg border-0 bg-white shadow-xl"
        >
            <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col p-6">
                <div className="mb-4 flex items-center justify-between">
                    <h2 id={titleId} className="text-xl font-bold text-red-600">
                        セキュリティ確認
                    </h2>
                    <button
                        type="button"
                        onClick={handleDismiss}
                        disabled={loading}
                        aria-label="再認証画面を閉じる"
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-xl text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <span aria-hidden="true">✕</span>
                    </button>
                </div>

                <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3">
                    <p className="text-sm text-amber-900">
                        アカウント削除などの重要な操作を行うには、再認証が必要です。
                    </p>
                </div>

                {error && (
                    <div role="alert" className="mb-4 rounded bg-red-100 p-3 text-red-700">
                        {error}
                    </div>
                )}

                {isEmailProvider ? (
                    <form onSubmit={handleEmailReauth} className="space-y-4">
                        <div>
                            <label htmlFor={`${titleId}-password`} className="mb-1 block text-sm font-medium text-gray-800">
                                現在のパスワードを入力してください
                            </label>
                            <input
                                ref={passwordInputRef}
                                id={`${titleId}-password`}
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={loading}
                                className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-700"
                                placeholder="現在のパスワード"
                                autoComplete="current-password"
                                required
                            />
                        </div>

                        <div className="flex gap-3">
                            <button
                                type="button"
                                onClick={handleDismiss}
                                disabled={loading}
                                className="min-h-11 flex-1 rounded-lg border border-gray-400 px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                キャンセル
                            </button>
                            <button
                                type="submit"
                                disabled={loading}
                                className="min-h-11 flex-1 rounded-lg bg-blue-700 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-500"
                            >
                                {loading ? '処理中...' : '確認'}
                            </button>
                        </div>
                    </form>
                ) : isGoogleProvider ? (
                    <div className="space-y-4">
                        <p className="mb-4 text-sm text-gray-600">
                            Googleアカウントで再度ログインして確認してください。
                        </p>

                        <button
                            ref={googleButtonRef}
                            type="button"
                            onClick={handleGoogleReauth}
                            disabled={loading}
                            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-gray-300 py-2 text-gray-800 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:opacity-60"
                        >
                            <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24">
                                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                            </svg>
                            {loading ? '処理中...' : 'Googleで再認証'}
                        </button>

                        <button
                            type="button"
                            onClick={handleDismiss}
                            disabled={loading}
                            className="min-h-11 w-full rounded-lg border border-gray-400 px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            キャンセル
                        </button>
                    </div>
                ) : (
                    <div>
                        <p className="mb-4 text-sm text-gray-600">
                            このアカウントの認証方法が不明です。
                        </p>
                        <button
                            ref={unknownProviderCloseRef}
                            type="button"
                            onClick={handleDismiss}
                            className="min-h-11 w-full rounded-lg bg-gray-700 px-4 py-2 font-medium text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2"
                        >
                            閉じる
                        </button>
                    </div>
                )}
            </div>
        </Dialog>
    );
}

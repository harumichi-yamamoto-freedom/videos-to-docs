'use client';

import { useEffect, useState } from 'react';
import { reauthenticateWithCredential, EmailAuthProvider, reauthenticateWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { createLogger } from '@/lib/logger';

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

    useEffect(() => {
        if (isOpen) {
            attemptGuard.activate();
            setPassword('');
            setError('');
        } else {
            attemptGuard.invalidate();
            setLoading(false);
        }

        return () => {
            attemptGuard.invalidate();
        };
    }, [attemptGuard, isOpen]);

    if (!isOpen) return null;

    const user = auth.currentUser;
    if (!user) return null;

    // メール認証ユーザーかどうか
    const isEmailProvider = user.providerData.some(p => p.providerId === 'password');
    const isGoogleProvider = user.providerData.some(p => p.providerId === 'google.com');

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
            if (!user.email) {
                throw new Error('auth/email-unavailable');
            }

            const credential = EmailAuthProvider.credential(user.email, password);
            await reauthenticateWithCredential(user, credential);
        });
    };

    const handleGoogleReauth = async () => {
        await runReauthentication('google', () =>
            reauthenticateWithPopup(user, new GoogleAuthProvider()),
        );
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="reauth-modal-title"
                aria-busy={loading}
                className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            >
                <div className="flex justify-between items-center mb-4">
                    <h2 id="reauth-modal-title" className="text-xl font-bold text-red-600">
                        セキュリティ確認
                    </h2>
                    <button
                        type="button"
                        onClick={handleDismiss}
                        disabled={loading}
                        aria-label="再認証画面を閉じる"
                        className="text-gray-500 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        ✕
                    </button>
                </div>

                <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded">
                    <p className="text-sm text-amber-900">
                        アカウント削除などの重要な操作を行うには、再認証が必要です。
                    </p>
                </div>

                {error && (
                    <div className="mb-4 p-3 bg-red-100 text-red-700 rounded">
                        {error}
                    </div>
                )}

                {isEmailProvider ? (
                    <form onSubmit={handleEmailReauth} className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium mb-1">
                                現在のパスワードを入力してください
                            </label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={loading}
                                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="現在のパスワード"
                                required
                            />
                        </div>

                        <div className="flex gap-3">
                            <button
                                type="button"
                                onClick={handleDismiss}
                                disabled={loading}
                                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                キャンセル
                            </button>
                            <button
                                type="submit"
                                disabled={loading}
                                className="flex-1 bg-blue-500 text-white py-2 rounded-lg hover:bg-blue-600 disabled:bg-gray-400"
                            >
                                {loading ? '処理中...' : '確認'}
                            </button>
                        </div>
                    </form>
                ) : isGoogleProvider ? (
                    <div className="space-y-4">
                        <p className="text-sm text-gray-600 mb-4">
                            Googleアカウントで再度ログインして確認してください。
                        </p>

                        <button
                            onClick={handleGoogleReauth}
                            disabled={loading}
                            className="w-full border border-gray-300 py-2 rounded-lg hover:bg-gray-50 disabled:bg-gray-100 flex items-center justify-center gap-2"
                        >
                            <svg className="w-5 h-5" viewBox="0 0 24 24">
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
                            className="w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            キャンセル
                        </button>
                    </div>
                ) : (
                    <div>
                        <p className="text-sm text-gray-600 mb-4">
                            このアカウントの認証方法が不明です。
                        </p>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            className="w-full px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
                        >
                            閉じる
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

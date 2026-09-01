'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { updatePassword, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth';
import { Dialog } from '@/components/ui/Dialog';
import { auth } from '@/lib/firebase';
import { logAudit } from '@/lib/auditLog';
import { createLogger } from '@/lib/logger';

const passwordChangeLogger = createLogger('PasswordChangeModal');

const PASSWORD_CHANGED_STATUS = 'パスワードを変更しました。';
const AUDIT_LOG_FAILED_NOTICE = '変更履歴の記録には失敗しました。次回のログインからは新しいパスワードをご利用ください。';

interface PasswordChangeModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type PasswordErrorField = 'currentPassword' | 'newPassword' | 'confirmPassword' | 'form';

interface PasswordError {
    field: PasswordErrorField;
    message: string;
}

function getPasswordError(error: unknown): PasswordError {
    const firebaseError = error as { code?: string };
    if (
        firebaseError.code === 'auth/wrong-password'
        || firebaseError.code === 'auth/invalid-credential'
    ) {
        return {
            field: 'currentPassword',
            message: '現在のパスワードが正しくありません。',
        };
    }
    if (firebaseError.code === 'auth/weak-password') {
        return {
            field: 'newPassword',
            message: '新しいパスワードが弱すぎます。',
        };
    }
    if (firebaseError.code === 'auth/too-many-requests') {
        return {
            field: 'form',
            message: '試行回数が多すぎます。しばらく待ってからもう一度お試しください。',
        };
    }
    if (error instanceof Error && error.message === 'ユーザー情報が取得できません。') {
        return { field: 'form', message: error.message };
    }
    return {
        field: 'form',
        message: 'パスワードの変更に失敗しました。もう一度お試しください。',
    };
}

export default function PasswordChangeModal({ isOpen, onClose }: PasswordChangeModalProps) {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState<PasswordError | null>(null);
    const [status, setStatus] = useState('');
    const [statusNotice, setStatusNotice] = useState('');
    const [loading, setLoading] = useState(false);
    const firstInputRef = useRef<HTMLInputElement>(null);
    const statusRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const currentPasswordId = useId();
    const newPasswordId = useId();
    const confirmPasswordId = useId();
    const errorId = useId();

    useEffect(() => {
        if (status) statusRef.current?.focus({ preventScroll: true });
    }, [status]);

    const clearPasswords = useCallback(() => {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
    }, []);

    const clearForm = useCallback(() => {
        clearPasswords();
        setError(null);
        setStatus('');
        setStatusNotice('');
    }, [clearPasswords]);

    // A parent which only flips isOpen would otherwise leave the typed
    // passwords in the closed dialog's DOM.
    useEffect(() => {
        if (!isOpen) clearForm();
    }, [clearForm, isOpen]);

    const handleClose = () => {
        if (loading) return;
        clearForm();
        onClose();
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);

        if (!currentPassword) {
            setError({
                field: 'currentPassword',
                message: '現在のパスワードを入力してください。',
            });
            return;
        }

        if (!newPassword) {
            setError({
                field: 'newPassword',
                message: '新しいパスワードを入力してください。',
            });
            return;
        }

        if (!confirmPassword) {
            setError({
                field: 'confirmPassword',
                message: '確認用のパスワードを入力してください。',
            });
            return;
        }

        if (newPassword !== confirmPassword) {
            setError({
                field: 'confirmPassword',
                message: '新しいパスワードが一致しません。',
            });
            return;
        }

        if (newPassword.length < 6) {
            setError({
                field: 'newPassword',
                message: 'パスワードは6文字以上で入力してください。',
            });
            return;
        }

        setLoading(true);
        let passwordChanged = false;
        try {
            const user = auth.currentUser;
            if (!user || !user.email) {
                throw new Error('ユーザー情報が取得できません。');
            }

            const credential = EmailAuthProvider.credential(user.email, currentPassword);
            await reauthenticateWithCredential(user, credential);
            await updatePassword(user, newPassword);
            passwordChanged = true;
            clearPasswords();

            await logAudit('user_password_change', 'user', user.uid, {
                userEmail: user.email,
            });
            setStatus(PASSWORD_CHANGED_STATUS);
        } catch (caughtError) {
            if (passwordChanged) {
                // The password is already the new one; reporting a failure here
                // would push the user into changing it a second time.
                passwordChangeLogger.error('パスワード変更後の記録に失敗', caughtError);
                clearPasswords();
                setStatus(PASSWORD_CHANGED_STATUS);
                setStatusNotice(AUDIT_LOG_FAILED_NOTICE);
            } else {
                setError(getPasswordError(caughtError));
            }
        } finally {
            setLoading(false);
        }
    };

    const currentPasswordInvalid = error?.field === 'currentPassword';
    const newPasswordInvalid = error?.field === 'newPassword';
    const confirmPasswordInvalid = error?.field === 'confirmPassword';

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
                        パスワード変更
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

                {status ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
                            <div
                                ref={statusRef}
                                role="status"
                                tabIndex={-1}
                                className="focus:outline-none"
                            >
                                <p className="rounded-lg bg-green-50 p-4 text-center font-medium text-green-800">
                                    {status}
                                </p>
                                {statusNotice && (
                                    <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
                                        {statusNotice}
                                    </p>
                                )}
                            </div>
                        </div>
                        <div className="sticky bottom-0 z-10 shrink-0 border-t border-gray-200 bg-white px-6 py-4">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="min-h-11 w-full rounded-lg bg-blue-700 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2"
                            >
                                閉じる
                            </button>
                        </div>
                    </div>
                ) : (
                    <form
                        onSubmit={handleSubmit}
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

                            <div>
                                <label htmlFor={currentPasswordId} className="mb-1 block text-sm font-medium text-gray-800">
                                    現在のパスワード
                                </label>
                                <input
                                    ref={firstInputRef}
                                    id={currentPasswordId}
                                    type="password"
                                    value={currentPassword}
                                    onChange={(event) => setCurrentPassword(event.target.value)}
                                    aria-invalid={currentPasswordInvalid || undefined}
                                    aria-describedby={currentPasswordInvalid ? errorId : undefined}
                                    className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    required
                                    disabled={loading}
                                    autoComplete="current-password"
                                />
                            </div>

                            <div>
                                <label htmlFor={newPasswordId} className="mb-1 block text-sm font-medium text-gray-800">
                                    新しいパスワード
                                </label>
                                <input
                                    id={newPasswordId}
                                    type="password"
                                    value={newPassword}
                                    onChange={(event) => setNewPassword(event.target.value)}
                                    aria-invalid={newPasswordInvalid || undefined}
                                    aria-describedby={newPasswordInvalid ? errorId : undefined}
                                    className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    required
                                    minLength={6}
                                    disabled={loading}
                                    autoComplete="new-password"
                                />
                            </div>

                            <div>
                                <label htmlFor={confirmPasswordId} className="mb-1 block text-sm font-medium text-gray-800">
                                    新しいパスワード（確認）
                                </label>
                                <input
                                    id={confirmPasswordId}
                                    type="password"
                                    value={confirmPassword}
                                    onChange={(event) => setConfirmPassword(event.target.value)}
                                    aria-invalid={confirmPasswordInvalid || undefined}
                                    aria-describedby={confirmPasswordInvalid ? errorId : undefined}
                                    className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    required
                                    minLength={6}
                                    disabled={loading}
                                    autoComplete="new-password"
                                />
                            </div>
                        </div>

                        <div className="sticky bottom-0 z-10 flex shrink-0 gap-3 border-t border-gray-200 bg-white px-6 py-4">
                            <button
                                type="button"
                                onClick={handleClose}
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
                                {loading ? '変更中...' : '変更する'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </Dialog>
    );
}

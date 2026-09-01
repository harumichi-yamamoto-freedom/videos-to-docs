'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { auth } from '@/lib/firebase';
import { updateUserDisplayName } from '@/lib/auth';

const DISPLAY_NAME_UPDATED_STATUS = '表示名を更新しました。';

interface DisplayNameModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function DisplayNameModal({ isOpen, onClose }: DisplayNameModalProps) {
    const [displayName, setDisplayName] = useState('');
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');
    const [loading, setLoading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const statusRef = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const displayNameId = useId();
    const errorId = useId();
    const hintId = useId();

    useEffect(() => {
        if (!isOpen) return;
        setDisplayName(auth.currentUser?.displayName || '');
        setError('');
        setStatus('');
    }, [isOpen]);

    useEffect(() => {
        if (status) statusRef.current?.focus({ preventScroll: true });
    }, [status]);

    // Every dismissal path (close button, cancel, Esc, backdrop) lands here, so
    // the closed dialog never keeps a stale name in its still-mounted DOM.
    const handleClose = () => {
        setDisplayName('');
        setError('');
        setStatus('');
        onClose();
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError('');

        const trimmed = displayName.trim();
        if (!trimmed) {
            setError('表示名を入力してください');
            return;
        }

        if (trimmed.length > 50) {
            setError('表示名は50文字以内で入力してください');
            return;
        }

        setLoading(true);
        try {
            await updateUserDisplayName(trimmed);
            // The update already landed; the success panel replaces the form so
            // the same rename cannot be submitted a second time.
            setStatus(DISPLAY_NAME_UPDATED_STATUS);
        } catch (err) {
            const firebaseError = err as { message?: string };
            setError(firebaseError.message || '表示名の更新に失敗しました');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            isOpen={isOpen}
            onClose={handleClose}
            initialFocusRef={inputRef}
            dismissible={!loading}
            aria-labelledby={titleId}
            className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-lg border-0 bg-white shadow-xl"
        >
            <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
                    <h2 id={titleId} className="text-xl font-bold text-gray-900">
                        表示名を編集
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
                                    {error}
                                </div>
                            )}

                            <div>
                                <label
                                    htmlFor={displayNameId}
                                    className="mb-1 block text-sm font-medium text-gray-800"
                                >
                                    表示名
                                </label>
                                <input
                                    ref={inputRef}
                                    id={displayNameId}
                                    type="text"
                                    value={displayName}
                                    onChange={(event) => setDisplayName(event.target.value)}
                                    maxLength={50}
                                    aria-invalid={Boolean(error) || undefined}
                                    aria-describedby={error ? `${errorId} ${hintId}` : hintId}
                                    className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="例: 田中 太郎"
                                    required
                                    disabled={loading}
                                />
                                <p id={hintId} className="mt-1 text-xs text-gray-600">
                                    チーム内に表示される名前です（50文字以内）
                                </p>
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
                                {loading ? '更新中...' : '更新する'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </Dialog>
    );
}

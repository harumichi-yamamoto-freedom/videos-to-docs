'use client';

import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import { updateUserDisplayName } from '@/lib/auth';

interface DisplayNameModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function DisplayNameModal({ isOpen, onClose }: DisplayNameModalProps) {
    const [displayName, setDisplayName] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setDisplayName(auth.currentUser?.displayName || '');
            setError('');
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
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
            alert('表示名を更新しました');
            onClose();
        } catch (err) {
            const firebaseError = err as { message?: string };
            setError(firebaseError.message || '表示名の更新に失敗しました');
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        setDisplayName('');
        setError('');
        onClose();
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold">表示名を編集</h2>
                    <button
                        onClick={handleClose}
                        className="text-gray-500 hover:text-gray-700"
                    >
                        ✕
                    </button>
                </div>

                {error && (
                    <div className="mb-4 p-3 bg-red-100 text-red-700 rounded">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">
                            表示名
                        </label>
                        <input
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            maxLength={50}
                            className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="例: 田中 太郎"
                            required
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            チーム内に表示される名前です（50文字以内）
                        </p>
                    </div>

                    <div className="flex gap-3 pt-4">
                        <button
                            type="button"
                            onClick={handleClose}
                            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                            キャンセル
                        </button>
                        <button
                            type="submit"
                            disabled={loading}
                            className="flex-1 bg-blue-500 text-white py-2 rounded-lg hover:bg-blue-600 disabled:bg-gray-400 transition-colors"
                        >
                            {loading ? '更新中...' : '更新する'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}


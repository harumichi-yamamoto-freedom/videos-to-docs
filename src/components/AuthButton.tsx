'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { signOutNow } from '@/lib/auth';
import AuthModal from './AuthModal';

export default function AuthButton() {
    const { user, loading } = useAuth();
    const [showAuthModal, setShowAuthModal] = useState(false);

    if (loading) {
        return (
            <div className="px-4 py-2 text-gray-500">
                読み込み中...
            </div>
        );
    }

    if (user) {
        return (
            <div className="flex items-center gap-4">
                <span className="text-sm text-gray-700">
                    {user.email || 'ログイン中'}
                </span>
                <button
                    onClick={() => signOutNow()}
                    className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg text-sm"
                >
                    ログアウト
                </button>
            </div>
        );
    }

    return (
        <>
            <button
                onClick={() => setShowAuthModal(true)}
                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm"
            >
                ログイン / アカウント作成
            </button>
            <AuthModal
                isOpen={showAuthModal}
                onClose={() => setShowAuthModal(false)}
            />
        </>
    );
}


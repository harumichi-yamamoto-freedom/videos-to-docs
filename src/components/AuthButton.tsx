'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { signOutNow, deleteAccount } from '@/lib/auth';
import { getUserDeletionInfo } from '@/lib/accountDeletion';
import AuthModal from './AuthModal';
import PasswordChangeModal from './PasswordChangeModal';
import ReauthModal from './ReauthModal';
import { ChevronDown, LogOut, Key, Trash2, User } from 'lucide-react';

export default function AuthButton() {
    const { user, loading } = useAuth();
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [showPasswordModal, setShowPasswordModal] = useState(false);
    const [showReauthModal, setShowReauthModal] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const [pendingDeletion, setPendingDeletion] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // ドロップダウンの外側クリックで閉じる
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setShowDropdown(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    if (loading) {
        return (
            <div className="px-4 py-2 text-gray-500">
                読み込み中...
            </div>
        );
    }

    if (user) {
        // メール認証ユーザーかどうか
        const isEmailProvider = user.providerData.some(p => p.providerId === 'password');

        const handleLogout = async () => {
            setShowDropdown(false);
            await signOutNow();
        };

        const handlePasswordChange = () => {
            setShowDropdown(false);
            setShowPasswordModal(true);
        };

        const handleDeleteAccount = async () => {
            setShowDropdown(false);

            try {
                // 削除されるデータ数を取得
                const deletionInfo = await getUserDeletionInfo(user.uid);

                const confirmMessage = `本当にアカウントを削除しますか？

⚠️ 警告:
- この操作は取り消せません
- プロンプト: ${deletionInfo.promptCount}件
- 文書: ${deletionInfo.documentCount}件
- 合計 ${deletionInfo.promptCount + deletionInfo.documentCount}件のデータがすべて削除されます

削除を続けるには「削除」と入力してください`;

                const confirmation = prompt(confirmMessage);

                if (confirmation !== '削除') {
                    return;
                }

                // 削除を試みる
                setPendingDeletion(true);
                await performDeletion();
            } catch (error: any) {
                if (error.code === 'auth/requires-recent-login') {
                    // 再認証が必要な場合、再認証モーダルを表示
                    setShowReauthModal(true);
                } else {
                    alert('アカウントの削除に失敗しました:\n' + error.message);
                    console.error('アカウント削除エラー:', error);
                    setPendingDeletion(false);
                }
            }
        };

        const performDeletion = async () => {
            try {
                console.log('🗑️ アカウント削除を実行中...');
                await deleteAccount();
                console.log('✅ アカウント削除成功');
                alert('アカウントとすべてのデータを削除しました');
                setPendingDeletion(false);
            } catch (error: any) {
                console.error('❌ アカウント削除エラー:', error);
                if (error.code === 'auth/requires-recent-login') {
                    console.log('⚠️ 再認証が必要です');
                    throw error; // 再認証が必要なエラーは上位に伝播
                }
                alert('アカウントの削除に失敗しました:\n' + error.message);
                setPendingDeletion(false);
                throw error;
            }
        };

        const handleReauthSuccess = async () => {
            // 再認証成功後、すぐに削除を実行
            console.log('✅ 再認証成功。削除を実行します...');

            try {
                // 再認証直後なので、すぐに削除を実行
                await performDeletion();
            } catch (error: any) {
                console.error('❌ 再認証後も削除エラー:', error);
                if (error.code === 'auth/requires-recent-login') {
                    alert('再認証後もエラーが発生しました。\n\n申し訳ございませんが、以下の手順をお試しください：\n1. 一度ログアウト\n2. 再度ログイン\n3. ログイン直後にアカウント削除を実行');
                }
                setPendingDeletion(false);
            }
        };

        return (
            <div className="relative" ref={dropdownRef}>
                <button
                    onClick={() => setShowDropdown(!showDropdown)}
                    className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-gray-50 rounded-lg border border-gray-300 transition-colors text-sm"
                >
                    <User className="w-4 h-4 text-gray-600" />
                    <span className="text-gray-700">
                        {user.email || 'ログイン中'}
                    </span>
                    <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
                </button>

                {showDropdown && (
                    <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50">
                        {isEmailProvider && (
                            <button
                                onClick={handlePasswordChange}
                                className="w-full px-4 py-2 text-left hover:bg-gray-50 transition-colors flex items-center gap-3 text-sm text-gray-700"
                            >
                                <Key className="w-4 h-4 text-blue-600" />
                                パスワードを変更
                            </button>
                        )}

                        <button
                            onClick={handleLogout}
                            className="w-full px-4 py-2 text-left hover:bg-gray-50 transition-colors flex items-center gap-3 text-sm text-gray-700"
                        >
                            <LogOut className="w-4 h-4 text-gray-600" />
                            ログアウト
                        </button>

                        <div className="border-t border-gray-200 my-1"></div>

                        <button
                            onClick={handleDeleteAccount}
                            className="w-full px-4 py-2 text-left hover:bg-red-50 transition-colors flex items-center gap-3 text-sm text-red-600"
                        >
                            <Trash2 className="w-4 h-4" />
                            アカウントを削除
                        </button>
                    </div>
                )}

                <PasswordChangeModal
                    isOpen={showPasswordModal}
                    onClose={() => setShowPasswordModal(false)}
                />

                <ReauthModal
                    isOpen={showReauthModal}
                    onClose={() => {
                        setShowReauthModal(false);
                        setPendingDeletion(false);
                    }}
                    onSuccess={handleReauthSuccess}
                />
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


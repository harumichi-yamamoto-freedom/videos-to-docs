'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useAdmin } from '@/hooks/useAdmin';
import { Music, Shield, Home, FileText, Users, ChevronDown, LogOut, Key, Trash2, User, Edit3 } from 'lucide-react';
import { signOutNow, deleteAccount } from '@/lib/auth';
import { getUserDeletionInfo } from '@/lib/accountDeletion';
import AuthModal from './AuthModal';
import PasswordChangeModal from './PasswordChangeModal';
import ReauthModal from './ReauthModal';
import DisplayNameModal from './DisplayNameModal';
import { fetchSubordinateRelationships } from '@/lib/relationships';

type Tab = 'home' | 'documents' | 'team' | 'admin';
type TeamView = 'subordinates' | 'supervisors';
const isValidTeamView = (view: string | null): view is TeamView =>
    view === 'subordinates' || view === 'supervisors';

export const AppHeader: React.FC = () => {
    const { user, loading: authLoading } = useAuth();
    const { isAdmin } = useAdmin();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [showDropdown, setShowDropdown] = useState(false);
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [showPasswordModal, setShowPasswordModal] = useState(false);
    const [showReauthModal, setShowReauthModal] = useState(false);
    const [showDisplayNameModal, setShowDisplayNameModal] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const [showTeamMenu, setShowTeamMenu] = useState(false);
    const teamMenuRef = useRef<HTMLDivElement>(null);
    const [pendingSubordinateCount, setPendingSubordinateCount] = useState(0);

    // ドロップダウンの外側クリックで閉じる
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setShowDropdown(false);
            }
            if (teamMenuRef.current && !teamMenuRef.current.contains(event.target as Node)) {
                setShowTeamMenu(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const currentTeamView = isValidTeamView(searchParams.get('view')) ? (searchParams.get('view') as TeamView) : 'subordinates';
    const pendingBadgeDisplay = pendingSubordinateCount > 99 ? '99+' : pendingSubordinateCount;

    useEffect(() => {
        let isMounted = true;
        const loadPending = async () => {
            if (!user?.uid) {
                if (isMounted) setPendingSubordinateCount(0);
                return;
            }
            try {
                const pending = await fetchSubordinateRelationships(user.uid, 'pending');
                if (isMounted) {
                    setPendingSubordinateCount(pending.length);
                }
            } catch (error) {
                console.error('未処理の部下申請取得エラー:', error);
            }
        };
        loadPending();
        return () => {
            isMounted = false;
        };
    }, [user?.uid]);

    const activeTab: Tab = (() => {
        if (pathname?.startsWith('/documents')) return 'documents';
        if (pathname?.startsWith('/team')) return 'team';
        if (pathname?.startsWith('/admin')) return 'admin';
        return 'home';
    })();

    const navigateToTab = (tab: Tab, view?: TeamView) => {
        switch (tab) {
            case 'home':
                router.push('/home');
                return;
            case 'documents':
                router.push('/documents');
                return;
            case 'team': {
                const params = new URLSearchParams(searchParams.toString());
                params.set('view', (view || currentTeamView) ?? 'subordinates');
                router.push(`/team?${params.toString()}`);
                return;
            }
            case 'admin':
                router.push('/admin');
                return;
        }
    };

    const handleTeamMenuSelect = (view: TeamView) => {
        navigateToTab('team', view);
        setShowTeamMenu(false);
    };

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

        if (!user) return;

        try {
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

            setShowReauthModal(true);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'アカウント削除の準備中にエラーが発生しました';
            alert('アカウント削除の準備中にエラーが発生しました:\n' + message);
            console.error('削除準備エラー:', error);
        }
    };

    const performDeletion = async () => {
        try {
            await deleteAccount();
            alert('アカウントとすべてのデータを削除しました');
        } catch (error) {
            console.error('アカウント削除エラー:', error);
            const firebaseError = error as { code?: string; message?: string };
            if (firebaseError.code === 'auth/requires-recent-login') {
                throw error;
            }
            const message = firebaseError.message || 'アカウントの削除に失敗しました';
            alert('アカウントの削除に失敗しました:\n' + message);
            throw error;
        }
    };

    const handleReauthSuccess = async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
            await performDeletion();
        } catch (error) {
            console.error('削除エラー:', error);
            const firebaseError = error as { code?: string; message?: string };
            if (firebaseError.code === 'auth/requires-recent-login') {
                alert('⚠️ データは削除されましたが、アカウント削除で問題が発生しました。\n\nアカウントを完全に削除するには：\n1. ページをリロード\n2. 再度ログイン（データは既に削除済み）\n3. すぐにアカウント削除を実行');
            } else {
                const message = firebaseError.message || 'エラーが発生しました';
                alert('エラーが発生しました:\n' + message);
            }
        }
    };

    const isEmailProvider = user?.providerData.some(p => p.providerId === 'password') || false;

    return (
        <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
            <div className="container mx-auto px-4 max-w-7xl">
                <div className="flex items-center justify-between h-20 py-2">
                    {/* 左側: ロゴとタイトル */}
                    <div className="flex items-center space-x-3">
                        <div className="p-2 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl shadow-lg">
                            <Music className="w-6 h-6 text-white" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                                商談くんミニ（簡易版）
                            </h1>
                        </div>
                    </div>

                    {/* 中央: タブ */}
                    <nav className="flex items-center space-x-1">
                        <button
                            onClick={() => navigateToTab('home')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${activeTab === 'home'
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <Home className="w-4 h-4" />
                            ホーム
                        </button>
                        <button
                            onClick={() => navigateToTab('documents')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${activeTab === 'documents'
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <FileText className="w-4 h-4" />
                            文書
                        </button>
                        <div className="relative" ref={teamMenuRef}>
                            <button
                                onClick={() => {
                                    setShowTeamMenu((prev) => !prev);
                                }}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 relative ${activeTab === 'team'
                                    ? 'bg-blue-100 text-blue-700'
                                    : 'text-gray-600 hover:bg-gray-100'
                                    }`}
                            >
                                <Users className="w-4 h-4" />
                                チーム
                                {pendingSubordinateCount > 0 && (
                                    <span className="absolute -top-1 -right-1 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold min-w-[18px] h-[18px] px-1 shadow">
                                        {pendingBadgeDisplay}
                                    </span>
                                )}
                                <ChevronDown
                                    className={`w-4 h-4 transition-transform ${showTeamMenu ? 'rotate-180' : ''}`}
                                />
                            </button>
                            {showTeamMenu && (
                                <div className="absolute left-0 mt-2 w-40 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-40">
                                    <button
                                        onClick={() => handleTeamMenuSelect('subordinates')}
                                        className={`w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-gray-50 ${currentTeamView === 'subordinates' ? 'text-blue-600 font-semibold' : 'text-gray-700'
                                            }`}
                                    >
                                        <span>部下</span>
                                        {pendingSubordinateCount > 0 && (
                                            <span className="inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold min-w-[18px] h-[18px] px-1">
                                                {pendingBadgeDisplay}
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => handleTeamMenuSelect('supervisors')}
                                        className={`w-full text-left px-4 py-2 text-sm hover:bg-gray-50 ${currentTeamView === 'supervisors' ? 'text-blue-600 font-semibold' : 'text-gray-700'
                                            }`}
                                    >
                                        上司
                                    </button>
                                </div>
                            )}
                        </div>
                        {isAdmin && (
                            <button
                                onClick={() => navigateToTab('admin')}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${activeTab === 'admin'
                                    ? 'bg-blue-100 text-blue-700'
                                    : 'text-gray-600 hover:bg-gray-100'
                                    }`}
                            >
                                <Shield className="w-4 h-4" />
                                管理者画面
                            </button>
                        )}
                    </nav>

                    {/* 右側: ユーザーメニュー */}
                    <div className="flex items-center">
                        {authLoading ? (
                            <div className="px-4 py-2 text-gray-500 text-sm">読み込み中...</div>
                        ) : user ? (
                            <div className="relative" ref={dropdownRef}>
                                <button
                                    onClick={() => setShowDropdown(!showDropdown)}
                                    className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-gray-50 rounded-lg border border-gray-300 transition-colors text-sm"
                                >
                                    <User className="w-4 h-4 text-gray-600" />
                                    <span className="text-gray-700">
                                        {user.displayName || user.email || 'ログイン中'}
                                    </span>
                                    <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
                                </button>

                                {showDropdown && (
                                    <div className="absolute right-0 mt-2 w-60 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50">
                                        <div className="px-4 py-3 border-b border-gray-100">
                                            <p className="text-xs text-gray-500">表示名</p>
                                            <p className="text-sm font-semibold text-gray-900">
                                                {user.displayName || '未設定'}
                                            </p>
                                            <p className="text-xs text-gray-500 mt-1 break-all">{user.email}</p>
                                        </div>
                                        <button
                                            onClick={() => {
                                                setShowDropdown(false);
                                                setShowDisplayNameModal(true);
                                            }}
                                            className="w-full px-4 py-2 text-left hover:bg-gray-50 transition-colors flex items-center gap-3 text-sm text-gray-700"
                                        >
                                            <Edit3 className="w-4 h-4 text-gray-600" />
                                            表示名を編集
                                        </button>
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
                                    onClose={() => setShowReauthModal(false)}
                                    onSuccess={handleReauthSuccess}
                                />
                                <DisplayNameModal
                                    isOpen={showDisplayNameModal}
                                    onClose={() => setShowDisplayNameModal(false)}
                                />
                            </div>
                        ) : (
                            <button
                                onClick={() => setShowAuthModal(true)}
                                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm"
                            >
                                ログイン / アカウント作成
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <AuthModal
                isOpen={showAuthModal}
                onClose={() => setShowAuthModal(false)}
            />
        </header>
    );
};


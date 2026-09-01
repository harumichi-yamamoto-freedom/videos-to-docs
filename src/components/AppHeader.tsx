'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useAdmin } from '@/hooks/useAdmin';
import { Music, Shield, Home, FileText, Users, ChevronDown, LogOut, Key, Trash2, User, Edit3, Bell, Menu, X } from 'lucide-react';
import { signOutNow } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import AuthModal from './AuthModal';
import PasswordChangeModal from './PasswordChangeModal';
import DisplayNameModal from './DisplayNameModal';
import { useAccountDeletionFlow } from './AccountDeletionFlow';
import { subscribeToPendingSubordinateRelationships } from '@/lib/relationships';
import { useSystemNotifications } from '@/hooks/useSystemNotifications';

type Tab = 'home' | 'documents' | 'team' | 'notifications' | 'admin';
type TeamView = 'subordinates' | 'supervisors';
const isValidTeamView = (view: string | null): view is TeamView =>
    view === 'subordinates' || view === 'supervisors';

const appHeaderLogger = createLogger('AppHeader');

export const AppHeader: React.FC = () => {
    const { user, loading: authLoading } = useAuth();
    const { isAdmin } = useAdmin();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [showDropdown, setShowDropdown] = useState(false);
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [showPasswordModal, setShowPasswordModal] = useState(false);
    const [showDisplayNameModal, setShowDisplayNameModal] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const [showTeamMenu, setShowTeamMenu] = useState(false);
    const teamMenuRef = useRef<HTMLDivElement>(null);
    const [showMobileMenu, setShowMobileMenu] = useState(false);
    const [showMobileTeamMenu, setShowMobileTeamMenu] = useState(false);
    const mobileMenuRef = useRef<HTMLDivElement>(null);
    const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
    const desktopNavRef = useRef<HTMLElement>(null);
    const [pendingSubordinateCount, setPendingSubordinateCount] = useState(0);
    const { beginAccountDeletion, accountDeletionDialog } = useAccountDeletionFlow(user);

    // ドロップダウンの外側クリック、または Esc キーで閉じる
    useEffect(() => {
        const handleClickOutside = (event: PointerEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setShowDropdown(false);
            }
            if (teamMenuRef.current && !teamMenuRef.current.contains(event.target as Node)) {
                setShowTeamMenu(false);
            }
            if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
                const shouldRestoreFocus = showMobileMenu && mobileMenuRef.current.contains(document.activeElement);
                if (shouldRestoreFocus) {
                    // pointerdown の既定動作(クリック先へのフォーカス移動)は
                    // ハンドラ実行後に走るため、同期 focus() は上書きされて効かない。
                    // rAF で既定動作の後ろへ逃がし、フォーカスが body に落ちた場合
                    // (=クリック先がフォーカス不可)だけ復帰させる。クリック先が
                    // フォーカス可能ならそちらを尊重する。
                    window.requestAnimationFrame(() => {
                        if (document.activeElement === document.body) {
                            mobileMenuButtonRef.current?.focus();
                        }
                    });
                }
                setShowMobileMenu(false);
                setShowMobileTeamMenu(false);
            }
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;

            setShowDropdown(false);
            setShowTeamMenu(false);

            if (showMobileMenu) {
                setShowMobileMenu(false);
                setShowMobileTeamMenu(false);
                window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
            }
        };

        document.addEventListener('pointerdown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [showMobileMenu]);

    // デスクトップ幅へ切り替えた後に、非表示のモバイルメニュー状態を残さない
    useEffect(() => {
        const desktopMediaQuery = window.matchMedia('(min-width: 1024px)');
        const handleBreakpointChange = (event: MediaQueryListEvent) => {
            if (event.matches) {
                setShowMobileMenu(false);
                setShowMobileTeamMenu(false);
                if (showMobileMenu) {
                    window.requestAnimationFrame(() => {
                        desktopNavRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
                    });
                }
                return;
            }

            setShowDropdown(false);
            setShowTeamMenu(false);
            if (showDropdown || showTeamMenu) {
                window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
            }
        };

        desktopMediaQuery.addEventListener('change', handleBreakpointChange);
        return () => desktopMediaQuery.removeEventListener('change', handleBreakpointChange);
    }, [showDropdown, showMobileMenu, showTeamMenu]);

    const currentTeamView = isValidTeamView(searchParams.get('view')) ? (searchParams.get('view') as TeamView) : 'subordinates';
    const effectivePendingCount = user?.uid ? pendingSubordinateCount : 0;
    const pendingBadgeDisplay = effectivePendingCount > 99 ? '99+' : effectivePendingCount;

    // お知らせの未読数（dismiss されていない通知の件数）。未認証時は常に0。
    const { notifications: systemNotifications, dismissedIds } = useSystemNotifications();
    const unreadNotificationCount = user?.uid
        ? systemNotifications.filter(n => !dismissedIds.includes(n.id)).length
        : 0;
    const unreadNotificationBadge = unreadNotificationCount > 99 ? '99+' : unreadNotificationCount;

    useEffect(() => {
        if (!user?.uid) return;
        const unsubscribe = subscribeToPendingSubordinateRelationships(
            user.uid,
            (relationships) => {
                setPendingSubordinateCount(relationships.length);
            },
            (error) => {
                appHeaderLogger.error('未処理の部下申請購読に失敗', error, { userId: user.uid });
            }
        );
        return () => {
            unsubscribe();
            setPendingSubordinateCount(0);
        };
    }, [user?.uid]);

    const activeTab: Tab = (() => {
        if (pathname?.startsWith('/documents')) return 'documents';
        if (pathname?.startsWith('/team')) return 'team';
        if (pathname?.startsWith('/notifications')) return 'notifications';
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
            case 'notifications':
                router.push('/notifications');
                return;
            case 'admin':
                router.push('/admin');
                return;
        }
    };

    const closeMobileMenu = () => {
        setShowMobileMenu(false);
        setShowMobileTeamMenu(false);
    };

    const handleMobileNavigate = (tab: Tab, view?: TeamView) => {
        closeMobileMenu();
        navigateToTab(tab, view);
    };

    const handleTeamMenuSelect = (view: TeamView) => {
        navigateToTab('team', view);
        setShowTeamMenu(false);
    };

    const handleLogout = async () => {
        setShowDropdown(false);
        closeMobileMenu();
        await signOutNow();
    };

    const handlePasswordChange = () => {
        setShowDropdown(false);
        closeMobileMenu();
        setShowPasswordModal(true);
    };

    const handleDeleteAccount = () => {
        setShowDropdown(false);
        closeMobileMenu();
        void beginAccountDeletion();
    };

    const isEmailProvider = user?.providerData.some(p => p.providerId === 'password') || false;

    return (
        <header className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
            <div className="container mx-auto px-4 max-w-7xl">
                <div className="flex items-center justify-between h-20 py-2">
                    {/* 左側: ロゴとタイトル */}
                    <div className="mr-3 flex min-w-0 flex-1 items-center space-x-3 lg:mr-0 lg:flex-initial">
                        <div className="shrink-0 p-2 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl shadow-lg">
                            <Music className="w-6 h-6 text-white" />
                        </div>
                        <div className="min-w-0">
                            <h1
                                aria-label="商談くんミニ（簡易版）"
                                className="flex min-w-0 items-center gap-2 text-xl font-bold text-gray-900 sm:text-2xl"
                            >
                                <span className="block truncate lg:hidden" aria-hidden="true">商談くんミニ</span>
                                <span className="hidden truncate lg:block" aria-hidden="true">商談くんミニ（簡易版）</span>
                            </h1>
                        </div>
                    </div>

                    {/* 中央: タブ */}
                    <nav ref={desktopNavRef} className="hidden items-center space-x-1 lg:flex lg:shrink-0">
                        <button
                            onClick={() => navigateToTab('home')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ${activeTab === 'home'
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <Home className="w-4 h-4" />
                            ホーム
                        </button>
                        <button
                            onClick={() => navigateToTab('documents')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ${activeTab === 'documents'
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <FileText className="w-4 h-4" />
                            文書
                        </button>
                        <div className="relative" ref={teamMenuRef}>
                            <button
                                type="button"
                                onClick={() => {
                                    setShowTeamMenu((prev) => !prev);
                                }}
                                aria-expanded={showTeamMenu}
                                aria-controls={showTeamMenu ? 'app-header-team-menu' : undefined}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 relative whitespace-nowrap ${activeTab === 'team'
                                    ? 'bg-blue-100 text-blue-700'
                                    : 'text-gray-600 hover:bg-gray-100'
                                    }`}
                            >
                                <Users className="w-4 h-4" />
                                チーム
                                {effectivePendingCount > 0 && (
                                    <span className="absolute -top-1 -right-1 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold min-w-[18px] h-[18px] px-1 shadow">
                                        {pendingBadgeDisplay}
                                    </span>
                                )}
                                <ChevronDown
                                    className={`w-4 h-4 transition-transform ${showTeamMenu ? 'rotate-180' : ''}`}
                                />
                            </button>
                            {showTeamMenu && (
                                <div id="app-header-team-menu" className="absolute left-0 mt-2 w-40 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-40">
                                    <button
                                        onClick={() => handleTeamMenuSelect('subordinates')}
                                        className={`w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-gray-50 ${currentTeamView === 'subordinates' ? 'text-blue-600 font-semibold' : 'text-gray-700'
                                            }`}
                                    >
                                        <span>部下</span>
                                        {effectivePendingCount > 0 && (
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
                        <button
                            onClick={() => navigateToTab('notifications')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 relative whitespace-nowrap ${activeTab === 'notifications'
                                ? 'bg-blue-100 text-blue-700'
                                : 'text-gray-600 hover:bg-gray-100'
                                }`}
                        >
                            <Bell className="w-4 h-4" />
                            お知らせ
                            {unreadNotificationCount > 0 && (
                                <span className="absolute -top-1 -right-1 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold min-w-[18px] h-[18px] px-1 shadow">
                                    {unreadNotificationBadge}
                                </span>
                            )}
                        </button>
                        {isAdmin && (
                            <button
                                onClick={() => navigateToTab('admin')}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ${activeTab === 'admin'
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
                    <div className="hidden min-w-0 items-center lg:flex lg:shrink-0">
                        {authLoading ? (
                            <div className="px-4 py-2 text-gray-500 text-sm">読み込み中...</div>
                        ) : user ? (
                            <div className="relative" ref={dropdownRef}>
                                <button
                                    type="button"
                                    onClick={() => setShowDropdown(!showDropdown)}
                                    aria-expanded={showDropdown}
                                    aria-controls={showDropdown ? 'app-header-account-menu' : undefined}
                                    className="flex min-w-0 items-center gap-2 px-4 py-2 bg-white hover:bg-gray-50 rounded-lg border border-gray-300 transition-colors text-sm"
                                >
                                    <User className="w-4 h-4 shrink-0 text-gray-600" />
                                    <span
                                        className="max-w-24 truncate text-gray-700 lg:max-w-48 xl:max-w-56"
                                        title={user.displayName || user.email || 'ログイン中'}
                                    >
                                        {user.displayName || user.email || 'ログイン中'}
                                    </span>
                                    <ChevronDown className={`w-4 h-4 shrink-0 text-gray-500 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
                                </button>

                                {showDropdown && (
                                    <div id="app-header-account-menu" className="absolute right-0 mt-2 w-60 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50">
                                        <div className="px-4 py-3 border-b border-gray-100">
                                            <p className="text-xs text-gray-500">表示名</p>
                                            <p className="truncate text-sm font-semibold text-gray-900" title={user.displayName || '未設定'}>
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

                    {/* モバイル: ナビゲーションとアカウント操作を集約 */}
                    <div className="shrink-0 lg:hidden" ref={mobileMenuRef}>
                        <button
                            ref={mobileMenuButtonRef}
                            type="button"
                            onClick={() => {
                                if (showMobileMenu) setShowMobileTeamMenu(false);
                                setShowMobileMenu(!showMobileMenu);
                                setShowDropdown(false);
                                setShowTeamMenu(false);
                            }}
                            aria-label={showMobileMenu ? 'メニューを閉じる' : 'メニューを開く'}
                            aria-expanded={showMobileMenu}
                            aria-controls="app-header-mobile-menu"
                            className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${showMobileMenu
                                ? 'border-blue-200 bg-blue-50 text-blue-700'
                                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                                }`}
                        >
                            {showMobileMenu ? (
                                <X className="h-5 w-5" aria-hidden="true" />
                            ) : (
                                <Menu className="h-5 w-5" aria-hidden="true" />
                            )}
                        </button>

                        <div
                            id="app-header-mobile-menu"
                            aria-hidden={!showMobileMenu}
                            inert={!showMobileMenu}
                            className={`absolute inset-x-0 top-full z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain border-y border-gray-200 bg-white shadow-lg transition-all duration-150 ease-out motion-reduce:transition-none ${showMobileMenu
                                ? 'visible translate-y-0 opacity-100'
                                : 'invisible pointer-events-none -translate-y-1 opacity-0'
                                }`}
                        >
                            <div className="container mx-auto max-w-7xl px-4 py-2">
                                <nav aria-label="モバイルメインナビゲーション" className="space-y-1">
                                    <button
                                        type="button"
                                        onClick={() => handleMobileNavigate('home')}
                                        aria-current={activeTab === 'home' ? 'page' : undefined}
                                        className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${activeTab === 'home'
                                            ? 'bg-blue-100 text-blue-700'
                                            : 'text-gray-700 hover:bg-gray-100'
                                            }`}
                                    >
                                        <Home className="h-5 w-5 shrink-0" aria-hidden="true" />
                                        ホーム
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => handleMobileNavigate('documents')}
                                        aria-current={activeTab === 'documents' ? 'page' : undefined}
                                        className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${activeTab === 'documents'
                                            ? 'bg-blue-100 text-blue-700'
                                            : 'text-gray-700 hover:bg-gray-100'
                                            }`}
                                    >
                                        <FileText className="h-5 w-5 shrink-0" aria-hidden="true" />
                                        文書
                                    </button>

                                    <div>
                                        <button
                                            type="button"
                                            onClick={() => setShowMobileTeamMenu((previous) => !previous)}
                                            aria-expanded={showMobileTeamMenu}
                                            aria-controls={showMobileTeamMenu ? 'app-header-mobile-team-menu' : undefined}
                                            className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${activeTab === 'team'
                                                ? 'bg-blue-100 text-blue-700'
                                                : 'text-gray-700 hover:bg-gray-100'
                                                }`}
                                        >
                                            <span className="flex min-w-0 items-center gap-3">
                                                <Users className="h-5 w-5 shrink-0" aria-hidden="true" />
                                                <span>チーム</span>
                                            </span>
                                            <span className="flex shrink-0 items-center gap-2">
                                                {effectivePendingCount > 0 && (
                                                    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white shadow">
                                                        {pendingBadgeDisplay}
                                                    </span>
                                                )}
                                                <ChevronDown
                                                    className={`h-4 w-4 transition-transform ${showMobileTeamMenu ? 'rotate-180' : ''}`}
                                                    aria-hidden="true"
                                                />
                                            </span>
                                        </button>

                                        {showMobileTeamMenu && (
                                            <div id="app-header-mobile-team-menu" className="ml-5 mt-1 space-y-1 border-l-2 border-blue-100 pl-3">
                                                <button
                                                    type="button"
                                                    onClick={() => handleMobileNavigate('team', 'subordinates')}
                                                    aria-current={activeTab === 'team' && currentTeamView === 'subordinates' ? 'page' : undefined}
                                                    className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${activeTab === 'team' && currentTeamView === 'subordinates'
                                                        ? 'bg-blue-50 font-semibold text-blue-700'
                                                        : 'text-gray-700 hover:bg-gray-100'
                                                        }`}
                                                >
                                                    <span>部下</span>
                                                    {effectivePendingCount > 0 && (
                                                        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                                                            {pendingBadgeDisplay}
                                                        </span>
                                                    )}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleMobileNavigate('team', 'supervisors')}
                                                    aria-current={activeTab === 'team' && currentTeamView === 'supervisors' ? 'page' : undefined}
                                                    className={`flex min-h-11 w-full items-center rounded-xl px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${activeTab === 'team' && currentTeamView === 'supervisors'
                                                        ? 'bg-blue-50 font-semibold text-blue-700'
                                                        : 'text-gray-700 hover:bg-gray-100'
                                                        }`}
                                                >
                                                    上司
                                                </button>
                                            </div>
                                        )}
                                    </div>

                                    <button
                                        type="button"
                                        onClick={() => handleMobileNavigate('notifications')}
                                        aria-current={activeTab === 'notifications' ? 'page' : undefined}
                                        className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${activeTab === 'notifications'
                                            ? 'bg-blue-100 text-blue-700'
                                            : 'text-gray-700 hover:bg-gray-100'
                                            }`}
                                    >
                                        <span className="flex min-w-0 items-center gap-3">
                                            <Bell className="h-5 w-5 shrink-0" aria-hidden="true" />
                                            <span>お知らせ</span>
                                        </span>
                                        {unreadNotificationCount > 0 && (
                                            <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white shadow">
                                                {unreadNotificationBadge}
                                            </span>
                                        )}
                                    </button>

                                    {isAdmin && (
                                        <button
                                            type="button"
                                            onClick={() => handleMobileNavigate('admin')}
                                            aria-current={activeTab === 'admin' ? 'page' : undefined}
                                            className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${activeTab === 'admin'
                                                ? 'bg-blue-100 text-blue-700'
                                                : 'text-gray-700 hover:bg-gray-100'
                                                }`}
                                        >
                                            <Shield className="h-5 w-5 shrink-0" aria-hidden="true" />
                                            管理者画面
                                        </button>
                                    )}
                                </nav>

                                <div className="mt-2 border-t border-gray-200 pt-2">
                                    {authLoading ? (
                                        <div role="status" className="flex min-h-11 items-center px-3 text-sm text-gray-500">
                                            読み込み中...
                                        </div>
                                    ) : user ? (
                                        <>
                                            <div className="mb-1 flex min-w-0 items-center gap-3 rounded-xl bg-gray-50 px-3 py-3">
                                                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-gray-600 shadow-sm ring-1 ring-gray-200">
                                                    <User className="h-4 w-4" aria-hidden="true" />
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <p
                                                        className="max-w-full truncate text-sm font-semibold text-gray-900"
                                                        title={user.displayName || '未設定'}
                                                    >
                                                        {user.displayName || '未設定'}
                                                    </p>
                                                    {user.email && (
                                                        <p className="max-w-full truncate text-xs text-gray-500" title={user.email}>
                                                            {user.email}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>

                                            <button
                                                type="button"
                                                onClick={() => {
                                                    closeMobileMenu();
                                                    setShowDisplayNameModal(true);
                                                }}
                                                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
                                            >
                                                <Edit3 className="h-5 w-5 shrink-0 text-gray-600" aria-hidden="true" />
                                                表示名を編集
                                            </button>
                                            {isEmailProvider && (
                                                <button
                                                    type="button"
                                                    onClick={handlePasswordChange}
                                                    className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
                                                >
                                                    <Key className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
                                                    パスワードを変更
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={handleLogout}
                                                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1"
                                            >
                                                <LogOut className="h-5 w-5 shrink-0 text-gray-600" aria-hidden="true" />
                                                ログアウト
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleDeleteAccount}
                                                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1"
                                            >
                                                <Trash2 className="h-5 w-5 shrink-0" aria-hidden="true" />
                                                アカウントを削除
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                closeMobileMenu();
                                                setShowAuthModal(true);
                                            }}
                                            className="flex min-h-11 w-full items-center justify-center rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                                        >
                                            ログイン / アカウント作成
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <AuthModal
                isOpen={showAuthModal}
                onClose={() => setShowAuthModal(false)}
            />
            {!authLoading && user && (
                <>
                    <PasswordChangeModal
                        isOpen={showPasswordModal}
                        onClose={() => setShowPasswordModal(false)}
                    />
                    <DisplayNameModal
                        isOpen={showDisplayNameModal}
                        onClose={() => setShowDisplayNameModal(false)}
                    />
                </>
            )}
            {accountDeletionDialog}
        </header>
    );
};

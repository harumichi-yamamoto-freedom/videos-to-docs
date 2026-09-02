'use client';

import React, { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
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
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { NavItem, NavItemButton } from '@/components/ui/NavItem';
import { SIGN_IN_LABEL } from '@/components/ui/labels';

type Tab = 'home' | 'documents' | 'team' | 'notifications' | 'admin';
type TeamView = 'subordinates' | 'supervisors';
const isValidTeamView = (view: string | null): view is TeamView =>
    view === 'subordinates' || view === 'supervisors';

const appHeaderLogger = createLogger('AppHeader');

const MENU_ITEM_CLASS =
    'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-1';
const MENU_ITEM_DANGER_CLASS =
    'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-status-danger transition-colors hover:bg-status-danger-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-danger focus-visible:ring-offset-1';
const CORNER_BADGE_CLASS =
    'absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold shadow-elevation-persistent';
const INLINE_BADGE_CLASS =
    'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-badge px-1 text-[10px] font-bold text-badge-foreground';

export const AppHeader: React.FC = () => {
    const { user, loading: authLoading } = useAuth();
    const { isAdmin } = useAdmin();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [showDropdown, setShowDropdown] = useState(false);
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [showPasswordModal, setShowPasswordModal] = useState(false);
    const [showDisplayNameModal, setShowDisplayNameModal] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const accountMenuButtonRef = useRef<HTMLButtonElement>(null);

    const [showTeamMenu, setShowTeamMenu] = useState(false);
    const teamMenuRef = useRef<HTMLDivElement>(null);
    const teamMenuButtonRef = useRef<HTMLButtonElement>(null);
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

            // 閉じたメニューの中にフォーカスが残ると、次の Tab が文書先頭へ飛ぶ。
            // 開いていたメニューを開いたトリガーへ戻す。
            if (showDropdown) {
                setShowDropdown(false);
                window.requestAnimationFrame(() => accountMenuButtonRef.current?.focus());
            }
            if (showTeamMenu) {
                setShowTeamMenu(false);
                window.requestAnimationFrame(() => teamMenuButtonRef.current?.focus());
            }
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
    }, [showDropdown, showMobileMenu, showTeamMenu]);

    // デスクトップ幅へ切り替えた後に、非表示のモバイルメニュー状態を残さない
    useEffect(() => {
        const desktopMediaQuery = window.matchMedia('(min-width: 1024px)');
        const handleBreakpointChange = (event: MediaQueryListEvent) => {
            if (event.matches) {
                setShowMobileMenu(false);
                setShowMobileTeamMenu(false);
                if (showMobileMenu) {
                    window.requestAnimationFrame(() => {
                        desktopNavRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
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
    const {
        notifications: systemNotifications,
        dismissedIds,
        error: notificationsError,
    } = useSystemNotifications();
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

    // チームは view クエリを持つため、現在のクエリを保ったまま view だけ差し替える。
    const teamHref = (view: TeamView) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('view', view);
        return `/team?${params.toString()}`;
    };

    const closeMobileMenu = () => {
        setShowMobileMenu(false);
        setShowMobileTeamMenu(false);
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

    const pendingCornerBadge = effectivePendingCount > 0 ? (
        <span className={`${CORNER_BADGE_CLASS} bg-badge text-badge-foreground`}>
            <span aria-hidden="true">{pendingBadgeDisplay}</span>
            <span className="sr-only">未処理の申請 {pendingBadgeDisplay} 件</span>
        </span>
    ) : undefined;

    const pendingInlineBadge = effectivePendingCount > 0 ? (
        <span className={INLINE_BADGE_CLASS}>
            <span aria-hidden="true">{pendingBadgeDisplay}</span>
            <span className="sr-only">未処理の申請 {pendingBadgeDisplay} 件</span>
        </span>
    ) : undefined;

    // 購読が壊れている間の 0 件表示は「お知らせなし」と読めてしまうため、
    // 件数の代わりに取得失敗を示す。
    const notificationCornerBadge = notificationsError ? (
        <span className={`${CORNER_BADGE_CLASS} bg-status-warning-bg text-status-warning ring-1 ring-status-warning-border`}>
            <span aria-hidden="true">!</span>
            <span className="sr-only">お知らせを取得できませんでした</span>
        </span>
    ) : unreadNotificationCount > 0 ? (
        <span className={`${CORNER_BADGE_CLASS} bg-badge text-badge-foreground`}>
            <span aria-hidden="true">{unreadNotificationBadge}</span>
            <span className="sr-only">未読 {unreadNotificationBadge} 件</span>
        </span>
    ) : undefined;

    const notificationInlineBadge = notificationsError ? (
        <span className="inline-flex h-[18px] shrink-0 items-center justify-center rounded-full bg-status-warning-bg px-2 text-[10px] font-bold text-status-warning ring-1 ring-status-warning-border">
            取得失敗
        </span>
    ) : unreadNotificationCount > 0 ? (
        <span className={INLINE_BADGE_CLASS}>
            <span aria-hidden="true">{unreadNotificationBadge}</span>
            <span className="sr-only">未読 {unreadNotificationBadge} 件</span>
        </span>
    ) : undefined;

    return (
        <header className="sticky top-0 z-40 border-b border-elevation-persistent-boundary bg-surface shadow-elevation-persistent">
            <div className="container mx-auto max-w-7xl px-4">
                {/* モバイルはナビが非表示で 2 要素だけになるため 2 列にする。3 列のままだと空の右列が
                    幅の半分を取り、ロゴ列が 390px 幅で不足してワードマークがメニューボタンと重なる。 */}
                <div className="grid h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2 lg:grid-cols-[1fr_auto_1fr]">
                    {/* 左側: ロゴとタイトル */}
                    <div className="flex min-w-0 items-center">
                        <Link
                            href="/home"
                            aria-label="商談くんミニ（簡易版）"
                            className="flex min-w-0 items-center gap-3 rounded-xl py-1 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
                        >
                            <span
                                aria-hidden="true"
                                className="inline-flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 p-2 shadow-elevation-persistent"
                            >
                                <Music className="h-6 w-6 text-white" />
                            </span>
                            <span className="truncate text-xl font-bold text-text-primary sm:text-2xl">
                                商談くんミニ
                            </span>
                            <span className="hidden shrink-0 rounded-full border border-brand-border bg-brand-subtle px-2 py-0.5 text-xs font-bold text-brand sm:inline">
                                簡易版
                            </span>
                        </Link>
                    </div>

                    {/* 中央: タブ */}
                    <nav
                        ref={desktopNavRef}
                        aria-label="メインナビゲーション"
                        className="hidden items-center gap-1 lg:flex"
                    >
                        <NavItem href="/home" icon={Home} active={activeTab === 'home'}>
                            ホーム
                        </NavItem>
                        <NavItem href="/documents" icon={FileText} active={activeTab === 'documents'}>
                            文書
                        </NavItem>
                        <div className="relative" ref={teamMenuRef}>
                            <NavItemButton
                                ref={teamMenuButtonRef}
                                icon={Users}
                                active={activeTab === 'team'}
                                badge={pendingCornerBadge}
                                trailing={
                                    <ChevronDown
                                        className={`h-4 w-4 shrink-0 transition-transform ${showTeamMenu ? 'rotate-180' : ''}`}
                                        aria-hidden="true"
                                    />
                                }
                                onClick={() => {
                                    setShowTeamMenu((prev) => !prev);
                                }}
                                aria-expanded={showTeamMenu}
                                aria-controls={showTeamMenu ? 'app-header-team-menu' : undefined}
                            >
                                チーム
                            </NavItemButton>
                            {showTeamMenu && (
                                <div
                                    id="app-header-team-menu"
                                    className="absolute left-0 z-40 mt-2 w-44 rounded-lg border border-border bg-surface p-1 shadow-elevation-overlay"
                                >
                                    <NavItem
                                        href={teamHref('subordinates')}
                                        layout="block"
                                        active={activeTab === 'team' && currentTeamView === 'subordinates'}
                                        badge={pendingInlineBadge}
                                        onClick={() => setShowTeamMenu(false)}
                                    >
                                        部下
                                    </NavItem>
                                    <NavItem
                                        href={teamHref('supervisors')}
                                        layout="block"
                                        active={activeTab === 'team' && currentTeamView === 'supervisors'}
                                        onClick={() => setShowTeamMenu(false)}
                                    >
                                        上司
                                    </NavItem>
                                </div>
                            )}
                        </div>
                        <NavItem
                            href="/notifications"
                            icon={Bell}
                            active={activeTab === 'notifications'}
                            badge={notificationCornerBadge}
                        >
                            お知らせ
                        </NavItem>
                        {isAdmin && (
                            <NavItem href="/admin" icon={Shield} active={activeTab === 'admin'}>
                                管理者画面
                            </NavItem>
                        )}
                    </nav>

                    {/* 右側: ユーザーメニュー */}
                    <div className="flex min-w-0 items-center justify-end">
                        <div className="hidden min-w-0 items-center lg:flex">
                            {authLoading ? (
                                <div className="px-4 py-2 text-sm text-muted">読み込み中...</div>
                            ) : user ? (
                                <div className="relative" ref={dropdownRef}>
                                    <button
                                        ref={accountMenuButtonRef}
                                        type="button"
                                        onClick={() => setShowDropdown(!showDropdown)}
                                        aria-expanded={showDropdown}
                                        aria-controls={showDropdown ? 'app-header-account-menu' : undefined}
                                        className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
                                    >
                                        <User className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                                        <span
                                            className="max-w-24 truncate lg:max-w-48 xl:max-w-56"
                                            title={user.displayName || user.email || 'ログイン中'}
                                        >
                                            {user.displayName || user.email || 'ログイン中'}
                                        </span>
                                        <ChevronDown
                                            className={`h-4 w-4 shrink-0 text-muted transition-transform ${showDropdown ? 'rotate-180' : ''}`}
                                            aria-hidden="true"
                                        />
                                    </button>

                                    {showDropdown && (
                                        <div
                                            id="app-header-account-menu"
                                            className="absolute right-0 z-50 mt-2 w-60 rounded-lg border border-border bg-surface p-1 shadow-elevation-overlay"
                                        >
                                            <div className="border-b border-border px-3 py-3">
                                                <p className="text-xs text-muted">表示名</p>
                                                <p className="truncate text-sm font-bold text-text-primary" title={user.displayName || '未設定'}>
                                                    {user.displayName || '未設定'}
                                                </p>
                                                <p className="mt-1 break-all text-xs text-muted">{user.email}</p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowDropdown(false);
                                                    setShowDisplayNameModal(true);
                                                }}
                                                className={MENU_ITEM_CLASS}
                                            >
                                                <Edit3 className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                                                表示名を編集
                                            </button>
                                            {isEmailProvider && (
                                                <button
                                                    type="button"
                                                    onClick={handlePasswordChange}
                                                    className={MENU_ITEM_CLASS}
                                                >
                                                    <Key className="h-4 w-4 shrink-0 text-action" aria-hidden="true" />
                                                    パスワードを変更
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={handleLogout}
                                                className={MENU_ITEM_CLASS}
                                            >
                                                <LogOut className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                                                ログアウト
                                            </button>
                                            <div className="my-1 border-t border-border"></div>
                                            <button
                                                type="button"
                                                onClick={handleDeleteAccount}
                                                className={MENU_ITEM_DANGER_CLASS}
                                            >
                                                <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                                                アカウントを削除
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <Button onClick={() => setShowAuthModal(true)}>{SIGN_IN_LABEL}</Button>
                            )}
                        </div>

                        {/* モバイル: ナビゲーションとアカウント操作を集約 */}
                        <div className="shrink-0 lg:hidden" ref={mobileMenuRef}>
                            <IconButton
                                ref={mobileMenuButtonRef}
                                variant="secondary"
                                onClick={() => {
                                    if (showMobileMenu) setShowMobileTeamMenu(false);
                                    setShowMobileMenu(!showMobileMenu);
                                    setShowDropdown(false);
                                    setShowTeamMenu(false);
                                }}
                                aria-label={showMobileMenu ? 'メニューを閉じる' : 'メニューを開く'}
                                aria-expanded={showMobileMenu}
                                aria-controls="app-header-mobile-menu"
                                selected={showMobileMenu}
                            >
                                {showMobileMenu ? (
                                    <X className="h-5 w-5" aria-hidden="true" />
                                ) : (
                                    <Menu className="h-5 w-5" aria-hidden="true" />
                                )}
                            </IconButton>

                            <div
                                id="app-header-mobile-menu"
                                aria-hidden={!showMobileMenu}
                                inert={!showMobileMenu}
                                className={`absolute inset-x-0 top-full z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain border-y border-border bg-surface shadow-elevation-overlay transition-all duration-150 ease-out motion-reduce:transition-none ${showMobileMenu
                                    ? 'visible translate-y-0 opacity-100'
                                    : 'invisible pointer-events-none -translate-y-1 opacity-0'
                                    }`}
                            >
                                <div className="container mx-auto max-w-7xl px-4 py-2">
                                    <nav aria-label="モバイルメインナビゲーション" className="space-y-1">
                                        <NavItem
                                            href="/home"
                                            layout="block"
                                            icon={Home}
                                            active={activeTab === 'home'}
                                            onClick={closeMobileMenu}
                                        >
                                            ホーム
                                        </NavItem>

                                        <NavItem
                                            href="/documents"
                                            layout="block"
                                            icon={FileText}
                                            active={activeTab === 'documents'}
                                            onClick={closeMobileMenu}
                                        >
                                            文書
                                        </NavItem>

                                        <div>
                                            <NavItemButton
                                                layout="block"
                                                icon={Users}
                                                active={activeTab === 'team'}
                                                badge={pendingInlineBadge}
                                                trailing={
                                                    <ChevronDown
                                                        className={`h-4 w-4 shrink-0 transition-transform ${showMobileTeamMenu ? 'rotate-180' : ''}`}
                                                        aria-hidden="true"
                                                    />
                                                }
                                                onClick={() => setShowMobileTeamMenu((previous) => !previous)}
                                                aria-expanded={showMobileTeamMenu}
                                                aria-controls={showMobileTeamMenu ? 'app-header-mobile-team-menu' : undefined}
                                            >
                                                チーム
                                            </NavItemButton>

                                            {showMobileTeamMenu && (
                                                <div id="app-header-mobile-team-menu" className="ml-5 mt-1 space-y-1 border-l-2 border-brand-border pl-3">
                                                    <NavItem
                                                        href={teamHref('subordinates')}
                                                        layout="block"
                                                        active={activeTab === 'team' && currentTeamView === 'subordinates'}
                                                        badge={pendingInlineBadge}
                                                        onClick={closeMobileMenu}
                                                    >
                                                        部下
                                                    </NavItem>
                                                    <NavItem
                                                        href={teamHref('supervisors')}
                                                        layout="block"
                                                        active={activeTab === 'team' && currentTeamView === 'supervisors'}
                                                        onClick={closeMobileMenu}
                                                    >
                                                        上司
                                                    </NavItem>
                                                </div>
                                            )}
                                        </div>

                                        <NavItem
                                            href="/notifications"
                                            layout="block"
                                            icon={Bell}
                                            active={activeTab === 'notifications'}
                                            badge={notificationInlineBadge}
                                            onClick={closeMobileMenu}
                                        >
                                            お知らせ
                                        </NavItem>

                                        {isAdmin && (
                                            <NavItem
                                                href="/admin"
                                                layout="block"
                                                icon={Shield}
                                                active={activeTab === 'admin'}
                                                onClick={closeMobileMenu}
                                            >
                                                管理者画面
                                            </NavItem>
                                        )}
                                    </nav>

                                    <div className="mt-2 border-t border-border pt-2">
                                        {authLoading ? (
                                            <div role="status" className="flex min-h-11 items-center px-3 text-sm text-muted">
                                                読み込み中...
                                            </div>
                                        ) : user ? (
                                            <>
                                                <div className="mb-1 flex min-w-0 items-center gap-3 rounded-xl bg-surface-subtle px-3 py-3">
                                                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-muted shadow-elevation-persistent ring-1 ring-border">
                                                        <User className="h-4 w-4" aria-hidden="true" />
                                                    </span>
                                                    <div className="min-w-0 flex-1">
                                                        <p
                                                            className="max-w-full truncate text-sm font-bold text-text-primary"
                                                            title={user.displayName || '未設定'}
                                                        >
                                                            {user.displayName || '未設定'}
                                                        </p>
                                                        {user.email && (
                                                            <p className="max-w-full truncate text-xs text-muted" title={user.email}>
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
                                                    className={MENU_ITEM_CLASS}
                                                >
                                                    <Edit3 className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
                                                    表示名を編集
                                                </button>
                                                {isEmailProvider && (
                                                    <button
                                                        type="button"
                                                        onClick={handlePasswordChange}
                                                        className={MENU_ITEM_CLASS}
                                                    >
                                                        <Key className="h-5 w-5 shrink-0 text-action" aria-hidden="true" />
                                                        パスワードを変更
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={handleLogout}
                                                    className={MENU_ITEM_CLASS}
                                                >
                                                    <LogOut className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
                                                    ログアウト
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleDeleteAccount}
                                                    className={MENU_ITEM_DANGER_CLASS}
                                                >
                                                    <Trash2 className="h-5 w-5 shrink-0" aria-hidden="true" />
                                                    アカウントを削除
                                                </button>
                                            </>
                                        ) : (
                                            <Button
                                                className="w-full"
                                                onClick={() => {
                                                    closeMobileMenu();
                                                    setShowAuthModal(true);
                                                }}
                                            >
                                                {SIGN_IN_LABEL}
                                            </Button>
                                        )}
                                    </div>
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

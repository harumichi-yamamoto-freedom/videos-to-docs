'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAdmin } from '@/hooks/useAdmin';
import { useAuth } from '@/hooks/useAuth';
import { Shield, Settings, Users, BarChart, Music, Bell, AlertTriangle, Lock, LogIn } from 'lucide-react';
import AuditLogPanel from '@/components/admin/AuditLogPanel';
import SettingsPanel from '@/components/admin/SettingsPanel';
import UsersPanel from '@/components/admin/UsersPanel';
import AudioFilesPanel from '@/components/admin/AudioFilesPanel';
import SystemNotificationPanel from '@/components/admin/SystemNotificationPanel';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button, buttonClassName } from '@/components/ui/Button';
import { SIGN_IN_LABEL } from '@/components/ui/labels';

const ADMIN_TABS = [
    { id: 'audit', label: '監査ログ', icon: BarChart },
    { id: 'settings', label: 'システム設定', icon: Settings },
    { id: 'users', label: 'ユーザー一覧', icon: Users },
    { id: 'audio', label: '音声ファイル', icon: Music },
    { id: 'notifications', label: 'お知らせ', icon: Bell },
] as const;

type Tab = (typeof ADMIN_TABS)[number]['id'];

export interface SettingsPanelRef {
    hasUnsavedChanges: () => boolean;
}

const StateCard: React.FC<{
    icon: React.ComponentType<{ className?: string }>;
    tone: 'danger' | 'warning' | 'info';
    title: string;
    children: React.ReactNode;
    actions?: React.ReactNode;
}> = ({ icon: Icon, tone, title, children, actions }) => {
    const toneClass = {
        danger: 'border-status-danger-border bg-status-danger-bg text-status-danger',
        warning: 'border-status-warning-border bg-status-warning-bg text-status-warning',
        info: 'border-status-info-border bg-status-info-bg text-status-info',
    }[tone];

    return (
        // 案内は割り込ませない。alert は読み上げを中断するため、失敗・拒否のみに使う。
        <div
            role={tone === 'info' ? 'status' : 'alert'}
            className={`flex flex-col gap-4 rounded-xl border p-6 ${toneClass}`}
        >
            <div className="flex items-start gap-3">
                <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                    <p className="text-base font-bold">{title}</p>
                    <div className="mt-1 text-sm">{children}</div>
                </div>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
};

export default function AdminPage() {
    const router = useRouter();
    const { user, loading: authLoading } = useAuth();
    const { isAdmin, loading: adminLoading, error: adminError, retry: retryAdminCheck } = useAdmin();
    const [activeTab, setActiveTab] = useState<Tab>('audit');
    const settingsPanelRef = useRef<SettingsPanelRef>(null);
    const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

    // ページ離脱時の警告
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (activeTab === 'settings' && settingsPanelRef.current?.hasUnsavedChanges()) {
                e.preventDefault();
                e.returnValue = '';
            }
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [activeTab]);

    const handleTabChange = (tab: Tab): boolean => {
        if (activeTab === 'settings' && settingsPanelRef.current?.hasUnsavedChanges()) {
            if (!confirm('保存されていない変更があります。破棄して移動しますか？')) {
                return false;
            }
        }
        setActiveTab(tab);
        return true;
    };

    // tablist の左右/Home/End 移動。tabIndex はアクティブタブだけ 0 にしている。
    const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const currentIndex = ADMIN_TABS.findIndex(tab => tab.id === activeTab);
        let nextIndex = -1;
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % ADMIN_TABS.length;
        else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + ADMIN_TABS.length) % ADMIN_TABS.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = ADMIN_TABS.length - 1;
        if (nextIndex < 0) return;

        event.preventDefault();
        const nextTab = ADMIN_TABS[nextIndex].id;
        if (handleTabChange(nextTab)) {
            tabRefs.current[nextTab]?.focus();
        }
    };

    const handleGoHome = () => {
        if (activeTab === 'settings' && settingsPanelRef.current?.hasUnsavedChanges()) {
            if (!confirm('保存されていない変更があります。破棄してホームに戻りますか？')) {
                return;
            }
        }
        router.push('/home');
    };

    const header = (
        <PageHeader
            title="管理者画面"
            description="システム管理とモニタリング"
            icon={Shield}
            actions={
                <Button variant="secondary" onClick={handleGoHome}>
                    ホームに戻る
                </Button>
            }
        />
    );

    if (authLoading || adminLoading) {
        return (
            <>
                {header}
                <div role="status" className="flex flex-col items-center gap-4 py-16 text-center">
                    <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-action motion-reduce:animate-none"></div>
                    <p className="text-muted">権限を確認しています...</p>
                </div>
            </>
        );
    }

    if (!user) {
        return (
            <>
                {header}
                <StateCard icon={LogIn} tone="info" title="ログインが必要です">
                    この画面の利用にはログインが必要です。ヘッダーの「{SIGN_IN_LABEL}」からログインしてください。
                    ログイン後は、この画面がそのまま表示されます。
                </StateCard>
            </>
        );
    }

    // 権限の判定に失敗した状態を「権限なし」へ畳み込むと、正規の管理者が
    // 一時障害で締め出される。再試行の出口を必ず出す。
    if (adminError) {
        return (
            <>
                {header}
                <StateCard
                    icon={AlertTriangle}
                    tone="warning"
                    title="権限を確認できませんでした"
                    actions={
                        <>
                            <Button onClick={retryAdminCheck}>再試行</Button>
                            <Link href="/home" className={buttonClassName('secondary')}>
                                ホームへ移動
                            </Link>
                        </>
                    }
                >
                    通信エラーなどにより管理者権限を確認できませんでした。権限がないと判定されたわけではありません。
                </StateCard>
            </>
        );
    }

    if (!isAdmin) {
        return (
            <>
                {header}
                <StateCard
                    icon={Lock}
                    tone="danger"
                    title="この画面を表示する権限がありません"
                    actions={
                        <Link href="/home" className={buttonClassName('secondary')}>
                            ホームへ移動
                        </Link>
                    }
                >
                    管理者権限が必要です。必要な場合は管理者へ権限の付与を依頼してください。
                </StateCard>
            </>
        );
    }

    return (
        <>
            {header}

            {/* タブナビゲーション。狭い画面では横スクロールさせ、末尾のタブが切れないようにする。 */}
            <div className="mb-6 rounded-xl border border-elevation-persistent-boundary bg-surface shadow-elevation-persistent">
                <div className="overflow-x-auto">
                    <div
                        role="tablist"
                        aria-label="管理者機能"
                        className="flex min-w-max border-b border-border"
                    >
                        {ADMIN_TABS.map(tab => {
                            const Icon = tab.icon;
                            const selected = activeTab === tab.id;
                            return (
                                <button
                                    key={tab.id}
                                    ref={element => {
                                        tabRefs.current[tab.id] = element;
                                    }}
                                    id={`admin-tab-${tab.id}`}
                                    type="button"
                                    role="tab"
                                    aria-selected={selected}
                                    /* パネルは選択中の 1 枚しか描画しない（5 枚同時マウントは
                                       Firestore 購読も 5 本になる）。存在しない id を指す
                                       aria-controls は不正なので、選択中のタブにだけ付ける。 */
                                    aria-controls={selected ? `admin-panel-${tab.id}` : undefined}
                                    tabIndex={selected ? 0 : -1}
                                    onClick={() => handleTabChange(tab.id)}
                                    onKeyDown={handleTabKeyDown}
                                    className={`flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap px-6 py-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action ${selected
                                        ? 'border-b-2 border-selection-boundary bg-selection text-selection-foreground'
                                        : 'text-muted hover:bg-surface-subtle hover:text-text-primary'
                                        }`}
                                >
                                    <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                    <span>{tab.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* タブコンテンツ */}
            <div
                role="tabpanel"
                id={`admin-panel-${activeTab}`}
                aria-labelledby={`admin-tab-${activeTab}`}
                /* パネル内に操作可能な要素があるため、パネル自体は tab 停止点にしない。 */
                className="rounded-xl border border-elevation-persistent-boundary bg-surface p-6 shadow-elevation-persistent"
            >
                {activeTab === 'audit' && <AuditLogPanel />}
                {activeTab === 'settings' && <SettingsPanel ref={settingsPanelRef} />}
                {activeTab === 'users' && <UsersPanel />}
                {activeTab === 'audio' && <AudioFilesPanel />}
                {activeTab === 'notifications' && <SystemNotificationPanel />}
            </div>
        </>
    );
}

'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAdmin } from '@/hooks/useAdmin';
import { Shield, Settings, Users, BarChart } from 'lucide-react';
import AuditLogPanel from '@/components/admin/AuditLogPanel';
import SettingsPanel from '@/components/admin/SettingsPanel';
import UsersPanel from '@/components/admin/UsersPanel';

type Tab = 'audit' | 'settings' | 'users';

export default function AdminPage() {
    const router = useRouter();
    const { isAdmin, loading } = useAdmin();
    const [activeTab, setActiveTab] = useState<Tab>('audit');

    useEffect(() => {
        if (!loading && !isAdmin) {
            // 管理者でない場合、ホームにリダイレクト
            router.push('/');
        }
    }, [isAdmin, loading, router]);

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                    <p className="text-gray-600">読み込み中...</p>
                </div>
            </div>
        );
    }

    if (!isAdmin) {
        return null; // リダイレクト処理中
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
            <div className="container mx-auto px-4 py-8 max-w-7xl">
                {/* ヘッダー */}
                <div className="mb-8">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="p-3 bg-gradient-to-br from-purple-600 to-pink-600 rounded-2xl shadow-lg">
                                <Shield className="w-8 h-8 text-white" />
                            </div>
                            <div>
                                <h1 className="text-4xl font-bold text-gray-900">管理者画面</h1>
                                <p className="text-gray-600">システム管理とモニタリング</p>
                            </div>
                        </div>
                        <button
                            onClick={() => router.push('/')}
                            className="px-4 py-2 bg-white hover:bg-gray-50 rounded-lg border border-gray-300 transition-colors"
                        >
                            ホームに戻る
                        </button>
                    </div>
                </div>

                {/* タブナビゲーション */}
                <div className="bg-white rounded-xl shadow-lg mb-6 overflow-hidden">
                    <div className="flex border-b border-gray-200">
                        <button
                            onClick={() => setActiveTab('audit')}
                            className={`flex items-center gap-2 px-6 py-4 font-medium transition-colors ${activeTab === 'audit'
                                ? 'border-b-2 border-purple-600 text-purple-600 bg-purple-50'
                                : 'text-gray-600 hover:bg-gray-50'
                                }`}
                        >
                            <BarChart className="w-5 h-5" />
                            <span>監査ログ</span>
                        </button>

                        <button
                            onClick={() => setActiveTab('settings')}
                            className={`flex items-center gap-2 px-6 py-4 font-medium transition-colors ${activeTab === 'settings'
                                ? 'border-b-2 border-purple-600 text-purple-600 bg-purple-50'
                                : 'text-gray-600 hover:bg-gray-50'
                                }`}
                        >
                            <Settings className="w-5 h-5" />
                            <span>システム設定</span>
                        </button>

                        <button
                            onClick={() => setActiveTab('users')}
                            className={`flex items-center gap-2 px-6 py-4 font-medium transition-colors ${activeTab === 'users'
                                ? 'border-b-2 border-purple-600 text-purple-600 bg-purple-50'
                                : 'text-gray-600 hover:bg-gray-50'
                                }`}
                        >
                            <Users className="w-5 h-5" />
                            <span>ユーザー一覧</span>
                        </button>
                    </div>
                </div>

                {/* タブコンテンツ */}
                <div className="bg-white rounded-xl shadow-lg p-6">
                    {activeTab === 'audit' && <AuditLogPanel />}
                    {activeTab === 'settings' && <SettingsPanel />}
                    {activeTab === 'users' && <UsersPanel />}
                </div>
            </div>
        </div>
    );
}


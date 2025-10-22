'use client';

import React, { useState, useEffect } from 'react';
import { getAllUsers, UserProfile } from '@/lib/userManagement';
import { RefreshCw, Users as UsersIcon } from 'lucide-react';
import { logAudit } from '@/lib/auditLog';

export default function UsersPanel() {
    const [users, setUsers] = useState<UserProfile[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadUsers();
    }, []);

    const loadUsers = async () => {
        try {
            setLoading(true);
            const data = await getAllUsers();
            setUsers(data);
            await logAudit('admin_user_view', 'users', 'all');
        } catch (error) {
            console.error('ユーザー読み込みエラー:', error);
            alert('ユーザー一覧の取得に失敗しました');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-gray-900">ユーザー一覧</h2>
                    <p className="text-gray-600 text-sm mt-1">全ユーザーの情報と統計</p>
                </div>
                <button
                    onClick={loadUsers}
                    disabled={loading}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    更新
                </button>
            </div>

            {loading ? (
                <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
                    <p className="text-gray-600">読み込み中...</p>
                </div>
            ) : (
                <div>
                    <div className="mb-4 flex items-center gap-2 text-gray-600">
                        <UsersIcon className="w-5 h-5" />
                        <span>合計: {users.length}人</span>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">メール</th>
                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">表示名</th>
                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">権限</th>
                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">プロンプト</th>
                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">文書</th>
                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">登録日</th>
                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">最終ログイン</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {users.map((user) => {
                                    const createdAt = user.createdAt instanceof Date
                                        ? user.createdAt
                                        : user.createdAt.toDate();
                                    const lastLoginAt = user.lastLoginAt
                                        ? (user.lastLoginAt instanceof Date
                                            ? user.lastLoginAt
                                            : user.lastLoginAt.toDate())
                                        : null;

                                    return (
                                        <tr key={user.uid} className="hover:bg-gray-50">
                                            <td className="px-4 py-3 text-sm text-gray-900">{user.email}</td>
                                            <td className="px-4 py-3 text-sm text-gray-600">{user.displayName || '-'}</td>
                                            <td className="px-4 py-3 text-sm">
                                                {user.superuser ? (
                                                    <span className="px-2 py-1 bg-purple-100 text-purple-800 rounded text-xs font-medium">
                                                        管理者
                                                    </span>
                                                ) : (
                                                    <span className="px-2 py-1 bg-gray-100 text-gray-800 rounded text-xs">
                                                        一般
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-gray-600">{user.promptCount || 0}</td>
                                            <td className="px-4 py-3 text-sm text-gray-600">{user.documentCount || 0}</td>
                                            <td className="px-4 py-3 text-sm text-gray-600">
                                                {createdAt.toLocaleDateString('ja-JP')}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-gray-600">
                                                {lastLoginAt ? lastLoginAt.toLocaleDateString('ja-JP') : '-'}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {users.length === 0 && (
                            <div className="text-center py-12 text-gray-500">
                                ユーザーがいません
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}


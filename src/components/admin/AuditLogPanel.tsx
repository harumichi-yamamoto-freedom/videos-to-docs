'use client';

import React, { useState, useEffect } from 'react';
import { getAuditLogs, AuditLog } from '@/lib/auditLog';
import { RefreshCw, Download } from 'lucide-react';

export default function AuditLogPanel() {
    const [logs, setLogs] = useState<AuditLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [limitCount, setLimitCount] = useState(100);

    useEffect(() => {
        loadLogs();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [limitCount]);

    const loadLogs = async () => {
        try {
            setLoading(true);
            const data = await getAuditLogs(limitCount);
            setLogs(data);
        } catch (error) {
            console.error('監査ログ読み込みエラー:', error);
            alert('監査ログの取得に失敗しました');
        } finally {
            setLoading(false);
        }
    };

    const exportLogs = () => {
        const csv = [
            ['タイムスタンプ', 'ユーザーID', 'メール', 'アクション', 'リソースタイプ', 'リソースID'].join(','),
            ...logs.map(log => {
                const timestamp = log.timestamp instanceof Date
                    ? log.timestamp
                    : log.timestamp.toDate();
                return [
                    timestamp.toLocaleString('ja-JP'),
                    log.userId,
                    log.userEmail || '',
                    log.action,
                    log.resourceType,
                    log.resourceId || ''
                ].join(',');
            })
        ].join('\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `audit_logs_${new Date().toISOString()}.csv`;
        link.click();
    };

    const getActionLabel = (action: string) => {
        const labels: Record<string, string> = {
            'prompt_create': 'プロンプト作成',
            'prompt_update': 'プロンプト更新',
            'prompt_delete': 'プロンプト削除',
            'document_create': '文書作成',
            'document_delete': '文書削除',
            'user_login': 'ログイン',
            'user_logout': 'ログアウト',
            'user_signup': 'サインアップ',
            'user_delete': 'アカウント削除',
            'user_password_change': 'パスワード変更',
            'admin_settings_update': '設定更新',
            'admin_user_view': 'ユーザー閲覧',
        };
        return labels[action] || action;
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-gray-900">監査ログ</h2>
                    <p className="text-gray-600 text-sm mt-1">システムの全操作履歴</p>
                </div>
                <div className="flex items-center gap-3">
                    <select
                        value={limitCount}
                        onChange={(e) => setLimitCount(Number(e.target.value))}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                        <option value={50}>50件</option>
                        <option value={100}>100件</option>
                        <option value={200}>200件</option>
                        <option value={500}>500件</option>
                    </select>
                    <button
                        onClick={exportLogs}
                        className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
                    >
                        <Download className="w-4 h-4" />
                        CSVエクスポート
                    </button>
                    <button
                        onClick={loadLogs}
                        disabled={loading}
                        className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        更新
                    </button>
                </div>
            </div>

            {loading ? (
                <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
                    <p className="text-gray-600">読み込み中...</p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">タイムスタンプ</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ユーザー</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">アクション</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">リソース</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {logs.map((log) => {
                                const timestamp = log.timestamp instanceof Date
                                    ? log.timestamp
                                    : log.timestamp.toDate();
                                return (
                                    <tr key={log.id} className="hover:bg-gray-50">
                                        <td className="px-4 py-3 text-sm text-gray-900">
                                            {timestamp.toLocaleString('ja-JP')}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-gray-600">
                                            <div>{log.userEmail || log.userId}</div>
                                            <div className="text-xs text-gray-400">{log.userId}</div>
                                        </td>
                                        <td className="px-4 py-3 text-sm">
                                            <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">
                                                {getActionLabel(log.action)}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-gray-600">
                                            {log.resourceType}
                                            {log.resourceId && <span className="text-xs text-gray-400 ml-2">({log.resourceId.slice(0, 8)}...)</span>}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {logs.length === 0 && (
                        <div className="text-center py-12 text-gray-500">
                            監査ログがありません
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}


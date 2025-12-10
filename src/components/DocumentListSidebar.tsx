'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { FileText, Download, Clock, RefreshCw, Trash2, Edit2, Check, XCircle, Search } from 'lucide-react';
import { getTranscriptions, Transcription, deleteTranscription, updateTranscriptionTitle } from '@/lib/firestore';
import { createLogger } from '@/lib/logger';

const documentListLogger = createLogger('DocumentListSidebar');

interface DocumentListSidebarProps {
    onDocumentClick: (transcription: Transcription) => void;
    updateTrigger?: number;
    selectedDocumentIds?: string[];
    isMultiSelectMode?: boolean;
}

export const DocumentListSidebar: React.FC<DocumentListSidebarProps> = ({
    onDocumentClick,
    updateTrigger,
    selectedDocumentIds = [],
    isMultiSelectMode = false,
}) => {
    const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingDocId, setEditingDocId] = useState<string | null>(null);
    const [editedTitle, setEditedTitle] = useState<string>('');
    const [isSaving, setIsSaving] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    // モックデータ
    const mockTranscriptions: Transcription[] = [
        {
            id: '1',
            title: 'モニカ様',
            fileName: 'Test (1).mp3',
            promptName: '顧客情報と希望条件',
            text: '# 議事録\n\n## 顧客情報\n- 名前: モニカ様\n- 連絡先: xxx@example.com\n\n## 希望条件\n- 予算: 500万円\n- 希望エリア: 東京都内\n\n## 次回アクション\n- 物件資料の送付\n- 内見日程の調整',
            createdAt: new Date('2024-12-02T17:26:00'),
        },
        {
            id: '2',
            title: '20251115-shoudan2-smaller',
            fileName: '20251115-shoudan2-smaller.mp4',
            promptName: '動画解析test',
            text: '# 商談記録\n\n## 概要\n新製品の導入についての商談\n\n## 主な議題\n1. 製品の特徴説明\n2. 価格について\n3. 導入スケジュール\n\n## 結論\n来週までに見積もりを提出',
            createdAt: new Date('2024-11-26T18:36:00'),
        },
        {
            id: '3',
            title: '20251115-shoudan1-smaller',
            fileName: '20251115-shoudan1-smaller.mp4',
            promptName: '動画解析test',
            text: '# 打ち合わせメモ\n\n## 参加者\n- 田中様（先方）\n- 佐藤（当社）\n\n## 議題\n- サービス内容の確認\n- 契約条件の協議\n\n## 決定事項\n- 次回ミーティング: 12月15日',
            createdAt: new Date('2024-11-26T18:22:00'),
        },
        {
            id: '4',
            title: '打ち合わせの流れ',
            fileName: '20251115-shoudan1-smaller.mp4',
            promptName: '打ち合わせの流れ',
            text: '# 打ち合わせの流れ\n\n## 1. アイスブレイク\n- 自己紹介\n- 雑談\n\n## 2. 本題\n- 課題のヒアリング\n- 解決策の提案\n\n## 3. まとめ\n- 次回アクションの確認\n- スケジュールの調整',
            createdAt: new Date('2024-11-22T11:28:00'),
        },
    ];

    const loadTranscriptionsQuietly = async () => {
        try {
            // モックデータを使用（Firebase接続なし）
            setTranscriptions(mockTranscriptions);
        } catch (error) {
            documentListLogger.error('バックグラウンドでの文書再取得に失敗', error);
        }
    };

    const loadTranscriptions = async () => {
        try {
            setLoading(true);
            // モックデータを使用（Firebase接続なし）
            await new Promise(resolve => setTimeout(resolve, 500));
            setTranscriptions(mockTranscriptions);
        } catch (error) {
            documentListLogger.error('文書一覧の取得に失敗', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTranscriptions();
        const interval = setInterval(() => loadTranscriptionsQuietly(), 5000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (updateTrigger !== undefined && updateTrigger > 0) {
            loadTranscriptionsQuietly();
        }
    }, [updateTrigger]);

    const downloadDocument = (transcription: Transcription, event: React.MouseEvent) => {
        event.stopPropagation();

        const blob = new Blob([transcription.text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${transcription.title}_${transcription.promptName}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDelete = async (transcription: Transcription, event: React.MouseEvent) => {
        event.stopPropagation();

        if (!confirm(`「${transcription.title}」を削除しますか？`)) return;

        try {
            // モック: ローカルで削除
            setTranscriptions(prev => prev.filter(t => t.id !== transcription.id));
            alert('削除しました（モック）');
        } catch (error) {
            alert('削除に失敗しました');
            documentListLogger.error('文書の削除に失敗', error, { documentId: transcription.id });
        }
    };

    const handleEditTitle = (transcription: Transcription, event: React.MouseEvent) => {
        event.stopPropagation();
        setEditingDocId(transcription.id!);
        setEditedTitle(transcription.title);
    };

    const filteredTranscriptions = useMemo(() => {
        if (!searchQuery.trim()) return transcriptions;

        const normalized = searchQuery.toLowerCase();
        return transcriptions.filter((transcription) => {
            const title = transcription.title?.toLowerCase() || '';
            const fileName = transcription.fileName?.toLowerCase() || '';
            const promptName = transcription.promptName?.toLowerCase() || '';
            return (
                title.includes(normalized) ||
                fileName.includes(normalized) ||
                promptName.includes(normalized)
            );
        });
    }, [searchQuery, transcriptions]);

    const handleSaveTitle = async (
        transcription: Transcription,
        event?: React.MouseEvent | React.KeyboardEvent,
    ) => {
        event?.stopPropagation();
        event?.preventDefault();

        if (!editedTitle.trim()) {
            alert('タイトルを入力してください');
            return;
        }

        if (editedTitle === transcription.title) {
            setEditingDocId(null);
            return;
        }

        try {
            setIsSaving(true);
            // モック: ローカルで更新
            await new Promise(resolve => setTimeout(resolve, 300));
            setTranscriptions(prev =>
                prev.map(t => (t.id === transcription.id ? { ...t, title: editedTitle } : t))
            );
            setEditingDocId(null);
            alert('タイトルを更新しました（モック）');
        } catch (error) {
            documentListLogger.error('文書タイトルの更新に失敗', error, { documentId: transcription.id });
            alert('タイトルの更新に失敗しました');
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancelEdit = (event?: React.MouseEvent | React.KeyboardEvent) => {
        event?.stopPropagation();
        event?.preventDefault();
        setEditingDocId(null);
        setEditedTitle('');
    };

    const formatDate = (timestamp: Date | { toDate: () => Date } | undefined): string => {
        if (!timestamp) return '';
        const date = 'toDate' in timestamp ? timestamp.toDate() : timestamp;
        return new Intl.DateTimeFormat('ja-JP', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    };

    return (
        <div className="h-full flex flex-col bg-gradient-to-br from-gray-50 to-gray-100">
            <div className="p-6 bg-white border-b border-purple-100">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                        <FileText className="w-6 h-6 text-purple-600" />
                        <div>
                            <h2 className="text-xl font-bold text-gray-900">
                                生成された文書
                            </h2>
                            <p className="text-xs text-gray-500 mt-1">
                                全{transcriptions.length}件 / 表示{filteredTranscriptions.length}件
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={loadTranscriptions}
                        disabled={loading}
                        className="p-2 hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="更新"
                    >
                        <RefreshCw className={`w-5 h-5 text-purple-600 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
                <div className="flex items-center space-x-2">
                    <div className="relative flex-1">
                        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="タイトル・ファイル名・プロンプトで検索"
                            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        />
                    </div>
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            className="text-xs text-purple-600 hover:underline"
                        >
                            クリア
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {loading ? (
                    <div className="flex items-center justify-center h-32">
                        <div className="text-sm text-gray-500">読み込み中...</div>
                    </div>
                ) : transcriptions.length === 0 ? (
                    <div className="bg-white rounded-xl p-8 shadow-sm">
                        <div className="flex flex-col items-center justify-center text-gray-400">
                            <FileText className="w-12 h-12 mb-2 opacity-50" />
                            <p className="text-sm">文書がまだありません</p>
                            <p className="text-xs mt-1">動画を変換して文書を生成してください</p>
                        </div>
                    </div>
                ) : filteredTranscriptions.length === 0 ? (
                    <div className="bg-white rounded-xl p-8 shadow-sm">
                        <div className="flex flex-col items-center justify-center text-gray-400">
                            <Search className="w-10 h-10 mb-2 opacity-50" />
                            <p className="text-sm">検索条件に一致する文書がありません</p>
                            <p className="text-xs mt-1">別のキーワードをお試しください</p>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredTranscriptions.map((transcription) => {
                            const isEditing = editingDocId === transcription.id;
                            const isSelected = selectedDocumentIds.includes(transcription.id!);
                            const selectionNumber = isSelected
                                ? selectedDocumentIds.indexOf(transcription.id!) + 1
                                : null;

                            return (
                                <div
                                    key={transcription.id}
                                    onClick={() => !isEditing && onDocumentClick(transcription)}
                                    className={`bg-white rounded-xl p-4 shadow-sm transition-all group border relative ${isEditing
                                        ? 'border-purple-300 shadow-md'
                                        : isSelected
                                            ? 'border-purple-400 shadow-md ring-2 ring-purple-200 bg-purple-50'
                                            : 'border-gray-100 hover:shadow-md cursor-pointer hover:border-purple-200'
                                        }`}
                                >
                                    {/* 複数選択モードの場合、選択番号を表示 */}
                                    {isMultiSelectMode && isSelected && selectionNumber && (
                                        <div className="absolute top-2 right-2 w-7 h-7 rounded-full bg-gradient-to-r from-purple-600 to-pink-600 text-white flex items-center justify-center text-sm font-bold shadow-lg">
                                            {selectionNumber}
                                        </div>
                                    )}

                                    <div className="flex items-start justify-between">
                                        <div className="flex-1 min-w-0 mr-2">
                                            {isEditing ? (
                                                <div className="flex items-center space-x-2 mb-2">
                                                    <input
                                                        type="text"
                                                        value={editedTitle}
                                                        onChange={(e) => setEditedTitle(e.target.value)}
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="flex-1 px-2 py-1 text-sm border border-purple-300 rounded focus:outline-none focus:ring-2 focus:ring-purple-500"
                                                        placeholder="タイトルを入力"
                                                        autoFocus
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') handleSaveTitle(transcription, e);
                                                            if (e.key === 'Escape') handleCancelEdit(e);
                                                        }}
                                                        disabled={isSaving}
                                                    />
                                                    <button
                                                        onClick={(e) => handleSaveTitle(transcription, e)}
                                                        disabled={isSaving}
                                                        className="p-1.5 bg-green-600 text-white rounded hover:bg-green-700 transition-colors disabled:opacity-50"
                                                        title="保存"
                                                    >
                                                        <Check className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={(e) => handleCancelEdit(e)}
                                                        disabled={isSaving}
                                                        className="p-1.5 bg-gray-400 text-white rounded hover:bg-gray-500 transition-colors disabled:opacity-50"
                                                        title="キャンセル"
                                                    >
                                                        <XCircle className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center space-x-1 mb-1">
                                                    <h3 className="text-sm font-semibold text-gray-900 truncate group-hover:text-purple-700 transition-colors">
                                                        {transcription.title}
                                                    </h3>
                                                    <button
                                                        onClick={(e) => handleEditTitle(transcription, e)}
                                                        className="p-1 opacity-0 group-hover:opacity-100 hover:bg-purple-50 rounded transition-all"
                                                        title="タイトルを編集"
                                                    >
                                                        <Edit2 className="w-3 h-3 text-purple-600" />
                                                    </button>
                                                </div>
                                            )}
                                            <p className="text-xs text-gray-500 mt-0.5 truncate">
                                                {transcription.fileName}
                                            </p>
                                            <p className="text-xs text-purple-600 mt-1 font-medium">
                                                {transcription.promptName}
                                            </p>
                                            <div className="flex items-center space-x-2 mt-2 text-xs text-gray-500">
                                                <Clock className="w-3 h-3" />
                                                <span>{formatDate(transcription.createdAt)}</span>
                                            </div>
                                        </div>
                                        {!isEditing && (
                                            <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100">
                                                <button
                                                    onClick={(e) => downloadDocument(transcription, e)}
                                                    className="p-2 hover:bg-purple-50 rounded-lg transition-colors"
                                                    title="ダウンロード"
                                                >
                                                    <Download className="w-4 h-4 text-blue-600" />
                                                </button>
                                                <button
                                                    onClick={(e) => handleDelete(transcription, e)}
                                                    className="p-2 hover:bg-red-50 rounded-lg transition-colors"
                                                    title="削除"
                                                >
                                                    <Trash2 className="w-4 h-4 text-red-600" />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};



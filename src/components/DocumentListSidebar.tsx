'use client';

import React, { useState, useEffect } from 'react';
import { FileText, Download, Clock, RefreshCw, Trash2 } from 'lucide-react';
import { getTranscriptions, Transcription, deleteTranscription } from '@/lib/firestore';

interface DocumentListSidebarProps {
    onDocumentClick: (transcription: Transcription) => void;
    updateTrigger?: number;
}

export const DocumentListSidebar: React.FC<DocumentListSidebarProps> = ({
    onDocumentClick,
    updateTrigger,
}) => {
    const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
    const [loading, setLoading] = useState(true);

    // 静かに更新（ローディング表示なし）
    const loadTranscriptionsQuietly = async () => {
        try {
            const data = await getTranscriptions();
            setTranscriptions(data);
        } catch (error) {
            console.error('文書読み込みエラー:', error);
        }
    };

    // 手動更新（ローディング表示あり）
    const loadTranscriptions = async () => {
        try {
            setLoading(true);
            const data = await getTranscriptions();
            setTranscriptions(data);
            // 最低0.5秒はローディング表示
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error('文書読み込みエラー:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTranscriptions();
        // 自動リロード（新しい文書が生成されたら更新）
        const interval = setInterval(() => loadTranscriptionsQuietly(), 5000);
        return () => clearInterval(interval);
    }, []);

    // 外部からの更新トリガーを監視
    useEffect(() => {
        if (updateTrigger !== undefined && updateTrigger > 0) {
            loadTranscriptionsQuietly();
        }
    }, [updateTrigger]);

    const downloadDocument = (transcription: Transcription, event: React.MouseEvent) => {
        event.stopPropagation(); // クリックイベントの伝播を防止

        const blob = new Blob([transcription.text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${transcription.fileName}_${transcription.promptName}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleDelete = async (transcription: Transcription, event: React.MouseEvent) => {
        event.stopPropagation();

        if (!confirm(`「${transcription.fileName} - ${transcription.promptName}」を削除しますか？`)) return;

        try {
            await deleteTranscription(transcription.id!);
            await loadTranscriptionsQuietly();
        } catch (error) {
            alert('削除に失敗しました');
            console.error(error);
        }
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
            {/* ヘッダー */}
            <div className="p-6 bg-white border-b border-purple-100">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-2">
                        <FileText className="w-6 h-6 text-purple-600" />
                        <h2 className="text-xl font-bold text-gray-900">
                            生成された文書
                        </h2>
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
                <p className="text-xs text-gray-600">
                    {transcriptions.length}件の文書
                </p>
            </div>

            {/* 文書リスト */}
            <div className="flex-1 overflow-y-auto p-4">
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
                ) : (
                    <div className="space-y-3">
                        {transcriptions.map((transcription) => (
                            <div
                                key={transcription.id}
                                onClick={() => onDocumentClick(transcription)}
                                className="bg-white rounded-xl p-4 shadow-sm hover:shadow-md cursor-pointer transition-all group border border-gray-100 hover:border-purple-200"
                            >
                                <div className="flex items-start justify-between">
                                    <div className="flex-1 min-w-0 mr-2">
                                        <h3 className="text-sm font-semibold text-gray-900 truncate group-hover:text-purple-700 transition-colors">
                                            {transcription.fileName}
                                        </h3>
                                        <p className="text-xs text-purple-600 mt-1 font-medium">
                                            {transcription.promptName}
                                        </p>
                                        <div className="flex items-center space-x-2 mt-2 text-xs text-gray-500">
                                            <Clock className="w-3 h-3" />
                                            <span>{formatDate(transcription.createdAt)}</span>
                                        </div>
                                    </div>
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
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};


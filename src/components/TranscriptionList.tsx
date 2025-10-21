'use client';

import React, { useEffect, useState } from 'react';
import { TranscriptionDocument, getTranscriptionDocuments, deleteTranscription } from '@/lib/firestore';
import { FileText, Trash2, Calendar, Music, Video, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

export const TranscriptionList: React.FC = () => {
    const [documents, setDocuments] = useState<TranscriptionDocument[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

    // Firestoreから文書を取得
    const loadDocuments = async () => {
        try {
            setLoading(true);
            setError(null);
            const docs = await getTranscriptionDocuments(20);
            setDocuments(docs);
        } catch (err) {
            setError(err instanceof Error ? err.message : '文書の取得に失敗しました');
        } finally {
            setLoading(false);
        }
    };

    // 初回読み込み
    useEffect(() => {
        loadDocuments();
    }, []);

    // 文書を削除
    const handleDelete = async (documentId: string) => {
        if (!documentId) return;

        if (!confirm('この文書を削除しますか？')) return;

        try {
            await deleteTranscription(documentId);
            // ローカルの状態も更新
            setDocuments(prev => prev.filter(doc => doc.id !== documentId));
        } catch (err) {
            alert('削除に失敗しました: ' + (err instanceof Error ? err.message : '不明なエラー'));
        }
    };

    // 日付フォーマット
    const formatDate = (date: Date) => {
        return new Intl.DateTimeFormat('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    };

    // 折りたたみのトグル
    const toggleExpand = (docId: string) => {
        setExpandedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(docId)) {
                newSet.delete(docId);
            } else {
                newSet.add(docId);
            }
            return newSet;
        });
    };

    // タイトルを抽出（最初の見出しまたは最初の行）
    const extractTitle = (text: string): string => {
        // Markdownの見出しを探す
        const titleMatch = text.match(/^#\s+(.+)$/m);
        if (titleMatch) {
            return titleMatch[1];
        }

        // 見出しがない場合は最初の行を取得
        const firstLine = text.split('\n')[0];
        return firstLine.substring(0, 100) + (firstLine.length > 100 ? '...' : '');
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
                <p className="text-red-800">❌ {error}</p>
                <button
                    onClick={loadDocuments}
                    className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
                >
                    再試行
                </button>
            </div>
        );
    }

    if (documents.length === 0) {
        return (
            <div className="space-y-4">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-bold text-gray-900">
                        生成された文書（0件）
                    </h3>
                    <button
                        onClick={loadDocuments}
                        className="text-sm text-blue-600 hover:text-blue-800 underline"
                    >
                        更新
                    </button>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
                    <FileText className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                    <p className="text-gray-600">まだ生成された文書はありません</p>
                    <p className="text-sm text-gray-500 mt-1">
                        動画や音声を変換して文書を生成しましょう
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-bold text-gray-900">
                    生成された文書（{documents.length}件）
                </h3>
                <button
                    onClick={loadDocuments}
                    className="text-sm text-blue-600 hover:text-blue-800 underline"
                >
                    更新
                </button>
            </div>

            {documents.map((doc) => (
                <div
                    key={doc.id}
                    className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm hover:shadow-md transition-shadow"
                >
                    {/* ヘッダー */}
                    <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center space-x-3">
                            {doc.originalFileType === 'video' ? (
                                <Video className="w-5 h-5 text-purple-600" />
                            ) : (
                                <Music className="w-5 h-5 text-green-600" />
                            )}
                            <div>
                                <h4 className="font-medium text-gray-900">{doc.fileName}</h4>
                                <div className="flex items-center space-x-3 mt-1 text-xs text-gray-500">
                                    <span className="flex items-center">
                                        <Calendar className="w-3 h-3 mr-1" />
                                        {formatDate(doc.createdAt)}
                                    </span>
                                    <span className="text-purple-600 bg-purple-50 px-2 py-0.5 rounded">
                                        {doc.promptName}
                                    </span>
                                    {doc.bitrate && <span>ビットレート: {doc.bitrate}</span>}
                                    {doc.sampleRate && <span>サンプルレート: {doc.sampleRate} Hz</span>}
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={() => handleDelete(doc.id!)}
                            className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                            title="削除"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>

                    {/* タイトルと展開ボタン */}
                    <div
                        className="flex items-center justify-between cursor-pointer hover:bg-gray-50 p-3 rounded-lg -mx-3"
                        onClick={() => toggleExpand(doc.id!)}
                    >
                        <div className="flex items-center space-x-3 flex-1">
                            <FileText className="w-5 h-5 text-blue-600" />
                            <div className="flex-1">
                                <p className="text-sm font-medium text-gray-900">
                                    {extractTitle(doc.transcription)}
                                </p>
                                <p className="text-xs text-gray-500 mt-1">
                                    クリックして{expandedIds.has(doc.id!) ? '折りたたむ' : '全文を表示'}
                                </p>
                            </div>
                        </div>
                        {expandedIds.has(doc.id!) ? (
                            <ChevronUp className="w-5 h-5 text-gray-400" />
                        ) : (
                            <ChevronDown className="w-5 h-5 text-gray-400" />
                        )}
                    </div>

                    {/* 文書内容（展開時のみ表示） */}
                    {expandedIds.has(doc.id!) && (
                        <div className="mt-4 prose prose-sm max-w-none bg-gray-50 rounded-lg p-4">
                            <div className="whitespace-pre-wrap text-gray-800">
                                {doc.transcription}
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};


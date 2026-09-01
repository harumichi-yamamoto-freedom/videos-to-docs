'use client';

import React, { useState, useEffect } from 'react';
import { Eye, FileText, Check, FileTextIcon, Download } from 'lucide-react';
import { Transcription } from '@/lib/firestore';
import { createLogger } from '@/lib/logger';
import { MarkdownDocument } from '@/components/MarkdownDocument';
import { DocumentPrintPortal } from '@/components/DocumentPrintPortal';
import { useDocumentPrint } from '@/hooks/useDocumentPrint';

const documentDetailLogger = createLogger('DocumentDetailPanel');
const PDF_INCLUDE_METADATA_STORAGE_KEY = 'pdfIncludeMetadata';

interface DocumentDetailPanelProps {
    document: Transcription | null;
    onTitleUpdate?: (newTitle: string) => Promise<void>;
    onContentUpdate?: (newContent: string) => Promise<void>;
}

export const DocumentDetailPanel: React.FC<DocumentDetailPanelProps> = ({
    document,
    onTitleUpdate,
    onContentUpdate,
}) => {
    const [isViewMode, setIsViewMode] = useState(true);
    const [editedTitle, setEditedTitle] = useState('');
    const [editedContent, setEditedContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [includeMetadata, setIncludeMetadata] = useState(false);
    const { printPdf, isPreparing } = useDocumentPrint(document);

    const isEditable = !!onContentUpdate;

    useEffect(() => {
        if (document) {
            setEditedTitle(document.title);
            setEditedContent(document.text);
            setIsViewMode(true);
        } else {
            setEditedTitle('');
            setEditedContent('');
            setIsViewMode(true);
        }
    }, [document]);

    useEffect(() => {
        try {
            setIncludeMetadata(
                window.localStorage.getItem(PDF_INCLUDE_METADATA_STORAGE_KEY) === 'true',
            );
        } catch {
            setIncludeMetadata(false);
        }
    }, []);

    if (!document) {
        return (
            <div className="bg-white rounded-xl shadow-lg p-10 h-full flex flex-col items-center justify-center text-center text-gray-500">
                <FileTextIcon className="w-12 h-12 mb-4 text-purple-300" />
                <p className="text-sm font-medium">文書が選択されていません</p>
                <p className="text-xs mt-2 text-gray-400">左側の一覧から表示したい文書を選択してください</p>
            </div>
        );
    }

    const hasChanges = editedTitle !== document.title || editedContent !== document.text;
    const canPrintPdf = isViewMode && !saving && !isPreparing;
    const pdfButtonTitle = saving
        ? '保存完了後に PDF 出力できます'
        : !isViewMode
            ? '保存後に PDF 出力できます'
            : undefined;

    const handlePrintPdf = (): void => {
        if (!canPrintPdf) {
            return;
        }

        void printPdf();
    };

    const handleIncludeMetadataChange = (
        event: React.ChangeEvent<HTMLInputElement>,
    ): void => {
        const checked = event.target.checked;
        setIncludeMetadata(checked);

        try {
            window.localStorage.setItem(
                PDF_INCLUDE_METADATA_STORAGE_KEY,
                String(checked),
            );
        } catch {
            // localStorage が利用できない環境でも、現在の選択はそのまま反映する。
        }
    };

    const handleCancelEdit = () => {
        if (hasChanges && !confirm('保存されていない変更があります。変更を破棄しますか？')) {
            return;
        }
        setEditedTitle(document.title);
        setEditedContent(document.text);
        setIsViewMode(true);
    };

    const handleViewModeSwitch = () => {
        if (hasChanges && !confirm('保存されていない変更があります。変更を破棄して表示モードに戻りますか？')) {
            return;
        }
        setEditedTitle(document.title);
        setEditedContent(document.text);
        setIsViewMode(true);
    };

    const handleSave = async () => {
        if (!onContentUpdate) return;

        if (!editedTitle.trim() || !editedContent.trim()) {
            alert('タイトルと内容を入力してください');
            return;
        }

        try {
            setSaving(true);
            const updates: Promise<void>[] = [];
            if (onTitleUpdate && editedTitle !== document.title) {
                updates.push(onTitleUpdate(editedTitle));
            }
            if (editedContent !== document.text) {
                updates.push(onContentUpdate(editedContent));
            }
            await Promise.all(updates);
            setIsViewMode(true);
        } catch (error) {
            documentDetailLogger.error('文書の保存に失敗', error, { documentId: document?.id });
            alert('保存に失敗しました');
        } finally {
            setSaving(false);
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
        <div className="bg-white rounded-xl shadow-lg h-full flex flex-col overflow-hidden border border-gray-200">
            <div className="p-6 bg-gradient-to-r from-purple-50 to-pink-50 border-b border-purple-100">
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                    <div className="flex-1 min-w-0">
                        {isEditable && !isViewMode ? (
                            <input
                                type="text"
                                value={editedTitle}
                                onChange={(e) => setEditedTitle(e.target.value)}
                                className="w-full px-3 py-2 border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900"
                                placeholder="タイトルを入力"
                                autoFocus
                                disabled={saving}
                            />
                        ) : (
                            <h2 className="text-2xl font-bold text-gray-900 truncate">
                                {document.title}
                            </h2>
                        )}
                        <div className="mt-3 text-xs text-gray-600 space-y-1">
                            <p>ファイル: {document.fileName}</p>
                            <p>プロンプト: <span className="text-purple-700 font-semibold">{document.promptName}</span></p>
                            <p>生成日時: {formatDate(document.createdAt)}</p>
                        </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center space-x-2 bg-white/80 rounded-lg p-1 shadow-sm">
                            <button
                                type="button"
                                onClick={handlePrintPdf}
                                disabled={!canPrintPdf}
                                title={pdfButtonTitle}
                                className="px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 text-purple-700 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <Download className="w-4 h-4" />
                                <span>{isPreparing ? '印刷を準備中…' : 'PDF に保存'}</span>
                            </button>
                            {isEditable && (
                                <>
                                    <button
                                        onClick={handleViewModeSwitch}
                                        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${isViewMode
                                            ? 'bg-purple-100 text-purple-700'
                                            : 'text-gray-600 hover:text-gray-900'
                                            }`}
                                        disabled={saving}
                                    >
                                        <Eye className="w-4 h-4" />
                                        <span>表示</span>
                                    </button>
                                    <button
                                        onClick={() => setIsViewMode(false)}
                                        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${!isViewMode
                                            ? 'bg-purple-100 text-purple-700'
                                            : 'text-gray-600 hover:text-gray-900'
                                            }`}
                                        disabled={saving}
                                    >
                                        <FileText className="w-4 h-4" />
                                        <span>編集</span>
                                    </button>
                                </>
                            )}
                        </div>
                        {isViewMode && (
                            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={includeMetadata}
                                    onChange={handleIncludeMetadataChange}
                                    disabled={isPreparing}
                                    className="h-3.5 w-3.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
                                />
                                <span>文書情報を含める（元ファイル・プロンプト・生成日時）</span>
                            </label>
                        )}
                        <p className="text-xs text-gray-500 text-right">
                            印刷設定は A4・倍率100%を推奨。「ヘッダーとフッター」はオフにしてください
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                {isViewMode ? (
                    <MarkdownDocument
                        className="prose prose-sm max-w-none text-gray-800"
                        markdown={document.text}
                    />
                ) : (
                    <div className="h-full">
                        <textarea
                            value={editedContent}
                            onChange={(e) => setEditedContent(e.target.value)}
                            className="w-full h-full min-h-0 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm resize-none"
                            placeholder="コンテンツを入力"
                            disabled={saving}
                        />
                    </div>
                )}
            </div>

            {isEditable && !isViewMode && (
                <div className="flex items-center justify-end space-x-3 p-4 border-t bg-white">
                    <button
                        onClick={handleCancelEdit}
                        disabled={saving}
                        className="px-6 py-2 bg-gray-400 text-white rounded-lg hover:bg-gray-500 transition-colors text-sm font-medium disabled:opacity-50"
                    >
                        キャンセル
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium flex items-center space-x-2 disabled:opacity-50"
                    >
                        {saving ? (
                            <>
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                <span>保存中...</span>
                            </>
                        ) : (
                            <>
                                <Check className="w-4 h-4" />
                                <span>保存</span>
                            </>
                        )}
                    </button>
                </div>
            )}
            <DocumentPrintPortal
                document={document}
                active={isPreparing}
                includeMetadata={includeMetadata}
            />
        </div>
    );
};

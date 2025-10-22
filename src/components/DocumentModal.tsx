'use client';

import React, { useState } from 'react';
import { X, Download, Trash2, Edit2, Check, XCircle } from 'lucide-react';

interface DocumentModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content: string;
    onDownload: () => void;
    onDelete: () => void;
    onTitleUpdate?: (newTitle: string) => Promise<void>;
}

export const DocumentModal: React.FC<DocumentModalProps> = ({
    isOpen,
    onClose,
    title,
    content,
    onDownload,
    onDelete,
    onTitleUpdate,
}) => {
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [editedTitle, setEditedTitle] = useState(title);
    const [isSaving, setIsSaving] = useState(false);

    if (!isOpen) return null;

    const handleEditTitle = () => {
        setEditedTitle(title);
        setIsEditingTitle(true);
    };

    const handleSaveTitle = async () => {
        if (!editedTitle.trim()) {
            alert('タイトルを入力してください');
            return;
        }

        if (editedTitle === title) {
            setIsEditingTitle(false);
            return;
        }

        if (onTitleUpdate) {
            try {
                setIsSaving(true);
                await onTitleUpdate(editedTitle);
                setIsEditingTitle(false);
            } catch (error) {
                console.error('タイトル更新エラー:', error);
                alert('タイトルの更新に失敗しました');
            } finally {
                setIsSaving(false);
            }
        }
    };

    const handleCancelEdit = () => {
        setEditedTitle(title);
        setIsEditingTitle(false);
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-gray-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* ヘッダー */}
                <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                    {isEditingTitle ? (
                        <div className="flex items-center flex-1 mr-4 space-x-2">
                            <input
                                type="text"
                                value={editedTitle}
                                onChange={(e) => setEditedTitle(e.target.value)}
                                className="flex-1 px-3 py-2 border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900"
                                placeholder="タイトルを入力"
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveTitle();
                                    if (e.key === 'Escape') handleCancelEdit();
                                }}
                                disabled={isSaving}
                            />
                            <button
                                onClick={handleSaveTitle}
                                disabled={isSaving}
                                className="p-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors shadow-sm disabled:opacity-50"
                                title="保存"
                            >
                                <Check className="w-5 h-5" />
                            </button>
                            <button
                                onClick={handleCancelEdit}
                                disabled={isSaving}
                                className="p-2 bg-gray-400 text-white rounded-lg hover:bg-gray-500 transition-colors shadow-sm disabled:opacity-50"
                                title="キャンセル"
                            >
                                <XCircle className="w-5 h-5" />
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center flex-1 mr-4 space-x-2">
                            <h2 className="text-xl font-bold text-gray-900 truncate">
                                {title}
                            </h2>
                            {onTitleUpdate && (
                                <button
                                    onClick={handleEditTitle}
                                    className="p-2 hover:bg-white rounded-lg transition-colors shadow-sm"
                                    title="タイトルを編集"
                                >
                                    <Edit2 className="w-4 h-4 text-purple-600" />
                                </button>
                            )}
                        </div>
                    )}
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-white rounded-lg transition-colors shadow-sm"
                        title="閉じる"
                    >
                        <X className="w-5 h-5 text-gray-600" />
                    </button>
                </div>

                {/* コンテンツ */}
                <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                    <div className="bg-white rounded-lg p-6 shadow-sm">
                        <div className="whitespace-pre-wrap text-gray-800 leading-relaxed text-sm">
                            {content}
                        </div>
                    </div>
                </div>

                {/* フッター */}
                <div className="flex items-center justify-between p-4 border-t bg-white">
                    <button
                        onClick={onDelete}
                        className="px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center space-x-2 shadow-sm font-medium"
                    >
                        <Trash2 className="w-4 h-4" />
                        <span>削除</span>
                    </button>
                    <button
                        onClick={onDownload}
                        className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center space-x-2 shadow-sm font-medium"
                    >
                        <Download className="w-4 h-4" />
                        <span>ダウンロード</span>
                    </button>
                </div>
            </div>
        </div>
    );
};


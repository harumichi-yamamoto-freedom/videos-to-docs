'use client';

import React from 'react';
import { X, Download, Trash2 } from 'lucide-react';

interface DocumentModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content: string;
    onDownload: () => void;
    onDelete: () => void;
}

export const DocumentModal: React.FC<DocumentModalProps> = ({
    isOpen,
    onClose,
    title,
    content,
    onDownload,
    onDelete,
}) => {
    if (!isOpen) return null;

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
                    <h2 className="text-xl font-bold text-gray-900 truncate flex-1 mr-4">
                        {title}
                    </h2>
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


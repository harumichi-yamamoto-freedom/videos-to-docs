'use client';

import React, { useState, useEffect } from 'react';
import { X, Save, Trash2 } from 'lucide-react';
import { DefaultPromptTemplate } from '@/lib/adminSettings';

interface DefaultPromptEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    prompt: DefaultPromptTemplate | null;
    onSave: (prompt: DefaultPromptTemplate) => void;
    onDelete?: () => void;
    mode: 'create' | 'edit';
}

export default function DefaultPromptEditModal({
    isOpen,
    onClose,
    prompt,
    onSave,
    onDelete,
    mode,
}: DefaultPromptEditModalProps) {
    const [name, setName] = useState('');
    const [content, setContent] = useState('');
    const [hasChanges, setHasChanges] = useState(false);

    useEffect(() => {
        if (prompt) {
            setName(prompt.name);
            setContent(prompt.content);
            setHasChanges(false);
        } else if (mode === 'create') {
            setName('');
            setContent('');
            setHasChanges(false);
        }
    }, [prompt, mode, isOpen]);

    useEffect(() => {
        if (prompt) {
            setHasChanges(name !== prompt.name || content !== prompt.content);
        } else if (mode === 'create') {
            setHasChanges(name.trim() !== '' || content.trim() !== '');
        }
    }, [name, content, prompt, mode]);

    if (!isOpen) return null;

    const handleClose = () => {
        if (hasChanges) {
            if (!confirm('変更が保存されていません。閉じますか？')) {
                return;
            }
        }
        onClose();
    };

    const handleSave = () => {
        if (!name.trim() || !content.trim()) {
            alert('名前と内容を入力してください');
            return;
        }

        onSave({ name: name.trim(), content: content.trim() });
        onClose();
    };

    const handleDelete = () => {
        if (!confirm(`「${name}」を削除しますか？`)) return;
        if (onDelete) {
            onDelete();
            onClose();
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={handleClose}
        >
            <div
                className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-gray-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* ヘッダー */}
                <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                    <h2 className="text-xl font-bold text-gray-900">
                        {mode === 'create' ? 'デフォルトプロンプトを追加' : 'デフォルトプロンプトを編集'}
                    </h2>
                    <button
                        onClick={handleClose}
                        className="p-2 hover:bg-white rounded-lg transition-colors shadow-sm"
                        title="閉じる"
                    >
                        <X className="w-5 h-5 text-gray-600" />
                    </button>
                </div>

                {/* コンテンツ */}
                <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                    <div className="space-y-4">
                        {/* プロンプト名 */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                プロンプト名
                            </label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                                placeholder="プロンプト名を入力"
                            />
                        </div>

                        {/* プロンプト内容 */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                プロンプト内容
                            </label>
                            <textarea
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                rows={15}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm"
                                placeholder="プロンプト内容を入力"
                            />
                        </div>

                        {/* 説明 */}
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                            <p className="text-xs text-blue-800">
                                ℹ️ このプロンプトは新規ユーザーのアカウント作成時に自動的に追加されます
                            </p>
                        </div>
                    </div>
                </div>

                {/* フッター */}
                <div className="flex items-center justify-between p-4 border-t bg-white">
                    {mode === 'edit' && onDelete ? (
                        <button
                            onClick={handleDelete}
                            className="px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center space-x-2 shadow-sm font-medium"
                        >
                            <Trash2 className="w-4 h-4" />
                            <span>削除</span>
                        </button>
                    ) : (
                        <div></div>
                    )}
                    <div className="flex items-center space-x-3">
                        <button
                            onClick={handleClose}
                            className="px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                        >
                            キャンセル
                        </button>
                        <button
                            onClick={handleSave}
                            className="px-6 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center space-x-2 shadow-sm font-medium"
                        >
                            <Save className="w-4 h-4" />
                            <span>{mode === 'create' ? '追加' : '保存'}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

'use client';

import React, { useState, useEffect } from 'react';
import { X, Save, Trash2 } from 'lucide-react';
import { Prompt, updatePrompt, deletePrompt } from '@/lib/prompts';

interface PromptEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    prompt: Prompt | null;
    onSave: () => void;
    onDelete: () => void;
}

export const PromptEditModal: React.FC<PromptEditModalProps> = ({
    isOpen,
    onClose,
    prompt,
    onSave,
    onDelete,
}) => {
    const [name, setName] = useState('');
    const [content, setContent] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (prompt) {
            setName(prompt.name);
            setContent(prompt.content);
        }
    }, [prompt]);

    if (!isOpen || !prompt) return null;

    // ゲストのデフォルトプロンプトかどうか
    const isGuestDefaultPrompt = prompt.ownerType === 'guest' && prompt.isDefault;
    // 編集・削除可能かどうか
    const isEditable = !isGuestDefaultPrompt;

    const handleSave = async () => {
        if (!isEditable) {
            alert('デフォルトプロンプトは編集できません');
            return;
        }

        if (!name.trim() || !content.trim()) {
            alert('名前と内容を入力してください');
            return;
        }

        try {
            setSaving(true);
            await updatePrompt(prompt.id!, { name, content });
            onSave();
            onClose();
        } catch (error) {
            alert('保存に失敗しました');
            console.error(error);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!prompt) return;

        if (!isEditable) {
            alert('デフォルトプロンプトは削除できません');
            return;
        }

        if (!confirm(`「${prompt.name}」を削除しますか？`)) return;

        try {
            setSaving(true);
            await deletePrompt(prompt.id!);
            onDelete();
            onClose();
        } catch (error) {
            alert('削除に失敗しました');
            console.error(error);
        } finally {
            setSaving(false);
        }
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
                    <h2 className="text-xl font-bold text-gray-900">
                        プロンプトを編集
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
                                disabled={!isEditable}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
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
                                disabled={!isEditable}
                                rows={12}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
                                placeholder="プロンプト内容を入力"
                            />
                        </div>

                        {/* デフォルトプロンプトの表示 */}
                        {isGuestDefaultPrompt && (
                            <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
                                <div className="flex items-start gap-2">
                                    <span className="text-amber-600 text-lg flex-shrink-0">🔒</span>
                                    <div>
                                        <p className="text-sm font-medium text-amber-900">
                                            このプロンプトは編集・削除できません
                                        </p>
                                        <p className="text-xs text-amber-700 mt-1">
                                            未ログインユーザー向けのデフォルトプロンプトは保護されています
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                        {prompt.isDefault && !isGuestDefaultPrompt && (
                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                                <p className="text-xs text-blue-800">
                                    ℹ️ このプロンプトはデフォルトプロンプトです
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                {/* フッター */}
                <div className="flex items-center justify-between p-4 border-t bg-white">
                    {isEditable ? (
                        <button
                            onClick={handleDelete}
                            disabled={saving}
                            className="px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center space-x-2 shadow-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <Trash2 className="w-4 h-4" />
                            <span>削除</span>
                        </button>
                    ) : (
                        <div></div>
                    )}
                    <div className="flex items-center space-x-3">
                        <button
                            onClick={onClose}
                            className="px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                            disabled={saving}
                        >
                            {isEditable ? 'キャンセル' : '閉じる'}
                        </button>
                        {isEditable && (
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                className="px-6 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center space-x-2 shadow-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Save className="w-4 h-4" />
                                <span>{saving ? '保存中...' : '保存'}</span>
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};


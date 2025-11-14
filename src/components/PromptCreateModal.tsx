'use client';

import React, { useState } from 'react';
import { X, Save } from 'lucide-react';
import { createPrompt } from '@/lib/prompts';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODEL_OPTIONS, getGeminiModelLabel } from '@/constants/geminiModels';
import { createLogger } from '@/lib/logger';

const promptCreateLogger = createLogger('PromptCreateModal');

interface PromptCreateModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: () => void;
}

export const PromptCreateModal: React.FC<PromptCreateModalProps> = ({
    isOpen,
    onClose,
    onSave,
}) => {
    const [name, setName] = useState('');
    const [content, setContent] = useState('');
    const [model, setModel] = useState(DEFAULT_GEMINI_MODEL);
    const [saving, setSaving] = useState(false);

    const selectedModelOption = GEMINI_MODEL_OPTIONS.find(option => option.value === model);

    if (!isOpen) return null;

    const handleSave = async () => {
        if (!name.trim() || !content.trim()) {
            alert('名前と内容を入力してください');
            return;
        }

        try {
            setSaving(true);
            await createPrompt(name, content, false, model);
            setName('');
            setContent('');
            setModel(DEFAULT_GEMINI_MODEL);
            onSave();
            onClose();
        } catch (error) {
            alert('作成に失敗しました');
            promptCreateLogger.error('プロンプトの作成に失敗', error);
        } finally {
            setSaving(false);
        }
    };

    const handleClose = () => {
        setName('');
        setContent('');
        setModel(DEFAULT_GEMINI_MODEL);
        onClose();
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
                <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-blue-50 to-cyan-50">
                    <h2 className="text-xl font-bold text-gray-900">
                        新しいプロンプトを作成
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
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                                rows={12}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                                placeholder="プロンプト内容を入力"
                            />
                        </div>

                        {/* Geminiモデル */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                使用するGeminiモデル
                            </label>
                            <select
                                value={model}
                                onChange={(e) => setModel(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                            >
                                {GEMINI_MODEL_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-gray-500 mt-1">
                                {selectedModelOption?.description || `${getGeminiModelLabel(model)} を使用します`}
                            </p>
                        </div>
                    </div>
                </div>

                {/* フッター */}
                <div className="flex items-center justify-end space-x-3 p-4 border-t bg-white">
                    <button
                        onClick={handleClose}
                        className="px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                        disabled={saving}
                    >
                        キャンセル
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center space-x-2 shadow-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Save className="w-4 h-4" />
                        <span>{saving ? '作成中...' : '作成'}</span>
                    </button>
                </div>
            </div>
        </div>
    );
};


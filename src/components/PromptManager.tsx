'use client';

import React, { useState, useEffect } from 'react';
import { Prompt, getPrompts, createPrompt, updatePrompt, deletePrompt, initializeDefaultPrompts } from '@/lib/prompts';
import { Plus, Edit2, Trash2, Save, X } from 'lucide-react';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODEL_OPTIONS, getGeminiModelLabel } from '@/constants/geminiModels';

export const PromptManager: React.FC = () => {
    const [prompts, setPrompts] = useState<Prompt[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [editContent, setEditContent] = useState('');
    const [editModel, setEditModel] = useState(DEFAULT_GEMINI_MODEL);
    const [isCreating, setIsCreating] = useState(false);

    // プロンプト一覧を読み込み
    const loadPrompts = async () => {
        try {
            setLoading(true);
            await initializeDefaultPrompts(); // デフォルトプロンプトを初期化
            const data = await getPrompts();
            setPrompts(data);
        } catch (error) {
            console.error('プロンプト読み込みエラー:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadPrompts();
    }, []);

    // 新規作成開始
    const handleStartCreate = () => {
        setIsCreating(true);
        setEditName('');
        setEditContent('');
        setEditModel(DEFAULT_GEMINI_MODEL);
    };

    // 新規作成保存
    const handleSaveNew = async () => {
        if (!editName.trim() || !editContent.trim()) {
            alert('名前と内容を入力してください');
            return;
        }

        try {
            await createPrompt(editName, editContent, false, editModel);
            await loadPrompts();
            setIsCreating(false);
            setEditName('');
            setEditContent('');
            setEditModel(DEFAULT_GEMINI_MODEL);
        } catch {
            alert('プロンプトの作成に失敗しました');
        }
    };

    // 編集開始
    const handleStartEdit = (prompt: Prompt) => {
        setEditingId(prompt.id!);
        setEditName(prompt.name);
        setEditContent(prompt.content);
        setEditModel(prompt.model);
    };

    // 編集保存
    const handleSaveEdit = async (promptId: string) => {
        try {
            await updatePrompt(promptId, { name: editName, content: editContent, model: editModel });
            await loadPrompts();
            setEditingId(null);
            setEditModel(DEFAULT_GEMINI_MODEL);
        } catch {
            alert('プロンプトの更新に失敗しました');
        }
    };

    // 削除
    const handleDelete = async (prompt: Prompt) => {
        if (!confirm(`「${prompt.name}」を削除しますか？`)) return;

        try {
            await deletePrompt(prompt.id!);
            await loadPrompts();
        } catch {
            alert('プロンプトの削除に失敗しました');
        }
    };

    if (loading) {
        return <div className="text-center py-4">読み込み中...</div>;
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-gray-900">プロンプト管理</h3>
                <button
                    onClick={handleStartCreate}
                    className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    <span>新規作成</span>
                </button>
            </div>

            {/* 新規作成フォーム */}
            {isCreating && (
                <div className="bg-gray-50 border border-gray-300 rounded-lg p-4">
                    <h4 className="font-medium text-gray-900 mb-3">新しいプロンプト</h4>
                    <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="プロンプト名"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3"
                    />
                    <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        placeholder="プロンプト内容"
                        rows={8}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3 font-mono text-sm"
                    />
                    <select
                        value={editModel}
                        onChange={(e) => setEditModel(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3 bg-white text-sm"
                    >
                        {GEMINI_MODEL_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                    <div className="flex space-x-2">
                        <button
                            onClick={handleSaveNew}
                            className="flex items-center space-x-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                        >
                            <Save className="w-4 h-4" />
                            <span>保存</span>
                        </button>
                        <button
                            onClick={() => {
                                setIsCreating(false);
                                setEditName('');
                                setEditContent('');
                                setEditModel(DEFAULT_GEMINI_MODEL);
                            }}
                            className="flex items-center space-x-1 px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
                        >
                            <X className="w-4 h-4" />
                            <span>キャンセル</span>
                        </button>
                    </div>
                </div>
            )}

            {/* プロンプト一覧 */}
            <div className="space-y-3">
                {prompts.map((prompt) => (
                    <div
                        key={prompt.id}
                        className="bg-white border border-gray-200 rounded-lg p-4"
                    >
                        {editingId === prompt.id ? (
                            // 編集モード
                            <div>
                                <input
                                    type="text"
                                    value={editName}
                                    onChange={(e) => setEditName(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3"
                                />
                                <textarea
                                    value={editContent}
                                    onChange={(e) => setEditContent(e.target.value)}
                                    rows={8}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3 font-mono text-sm"
                                />
                                <select
                                    value={editModel}
                                    onChange={(e) => setEditModel(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg mb-3 bg-white text-sm"
                                >
                                    {GEMINI_MODEL_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                                <div className="flex space-x-2">
                                    <button
                                        onClick={() => handleSaveEdit(prompt.id!)}
                                        className="flex items-center space-x-1 px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700"
                                    >
                                        <Save className="w-3 h-3" />
                                        <span className="text-sm">保存</span>
                                    </button>
                                    <button
                                        onClick={() => {
                                            setEditingId(null);
                                            setEditModel(DEFAULT_GEMINI_MODEL);
                                        }}
                                        className="flex items-center space-x-1 px-3 py-1 bg-gray-500 text-white rounded hover:bg-gray-600"
                                    >
                                        <X className="w-3 h-3" />
                                        <span className="text-sm">キャンセル</span>
                                    </button>
                                </div>
                            </div>
                        ) : (
                            // 表示モード
                            <div>
                                <div className="flex items-start justify-between mb-2">
                                    <div className="flex flex-col gap-1">
                                    <div className="flex items-center flex-wrap gap-2">
                                        <h4 className="font-medium text-gray-900">{prompt.name}</h4>
                                        {prompt.isDefault && (
                                            <span className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
                                                デフォルト
                                            </span>
                                        )}
                                        <span className="text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                                            {getGeminiModelLabel(prompt.model)}
                                        </span>
                                    </div>
                                    </div>
                                    <div className="flex space-x-2">
                                        <button
                                            onClick={() => handleStartEdit(prompt)}
                                            className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                                            title="編集"
                                        >
                                            <Edit2 className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={() => handleDelete(prompt)}
                                            className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                                            title="削除"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                                <pre className="text-xs text-gray-600 bg-gray-50 p-3 rounded overflow-x-auto whitespace-pre-wrap">
                                    {prompt.content}
                                </pre>
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {prompts.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                    プロンプトがありません。新規作成してください。
                </div>
            )}
        </div>
    );
};


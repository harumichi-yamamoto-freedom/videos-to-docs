'use client';

import React, { useState } from 'react';
import { X } from 'lucide-react';
import { DefaultPromptTemplate } from '@/lib/adminSettings';

interface AddDefaultPromptsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAdd: (selectedTemplateNames: string[]) => Promise<void>;
    templates: DefaultPromptTemplate[];
}

export const AddDefaultPromptsModal: React.FC<AddDefaultPromptsModalProps> = ({
    isOpen,
    onClose,
    onAdd,
    templates,
}) => {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(false);

    // モーダルが開かれていない場合は何も表示しない
    if (!isOpen) return null;

    // チェックボックスのトグル処理
    const handleToggle = (templateName: string) => {
        const newSelected = new Set(selected);
        if (newSelected.has(templateName)) {
            // 既に選択されている場合は削除
            newSelected.delete(templateName);
        } else {
            // 選択されていない場合は追加
            newSelected.add(templateName);
        }
        setSelected(newSelected);
    };

    // すべて選択
    const handleSelectAll = () => {
        const allNames = templates.map(t => t.name);
        setSelected(new Set(allNames));
    };

    // すべて解除
    const handleDeselectAll = () => {
        setSelected(new Set());
    };

    // 追加ボタンの処理
    const handleAdd = async () => {
        if (selected.size === 0) {
            alert('追加するプロンプトを選択してください');
            return;
        }

        setIsLoading(true);
        try {
            await onAdd(Array.from(selected));
            // 成功したら選択をリセットしてモーダルを閉じる
            setSelected(new Set());
            onClose();
        } catch {
            // エラーは親コンポーネントで処理される
        } finally {
            setIsLoading(false);
        }
    };

    // キャンセルボタンの処理
    const handleCancel = () => {
        setSelected(new Set());
        onClose();
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
                {/* ヘッダー */}
                <div className="flex items-center justify-between p-6 border-b border-gray-200">
                    <h2 className="text-xl font-bold text-gray-900">
                        デフォルトプロンプトを追加
                    </h2>
                    <button
                        onClick={handleCancel}
                        className="p-1 hover:bg-gray-100 rounded transition-colors"
                        disabled={isLoading}
                    >
                        <X className="w-5 h-5 text-gray-500" />
                    </button>
                </div>

                {/* コンテンツ */}
                <div className="p-6">
                    {/* 全選択/全解除ボタン */}
                    <div className="flex gap-2 mb-4">
                        <button
                            onClick={handleSelectAll}
                            className="text-sm text-blue-600 hover:text-blue-700 underline"
                            disabled={isLoading}
                        >
                            すべて選択
                        </button>
                        <span className="text-sm text-gray-400">|</span>
                        <button
                            onClick={handleDeselectAll}
                            className="text-sm text-blue-600 hover:text-blue-700 underline"
                            disabled={isLoading}
                        >
                            すべて解除
                        </button>
                    </div>

                    {/* プロンプトリスト */}
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                        {templates.map((template) => (
                            <label
                                key={template.name}
                                className="flex items-center p-3 hover:bg-gray-50 rounded-lg cursor-pointer transition-colors"
                            >
                                <input
                                    type="checkbox"
                                    checked={selected.has(template.name)}
                                    onChange={() => handleToggle(template.name)}
                                    disabled={isLoading}
                                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                />
                                <span className="ml-3 text-sm text-gray-900">
                                    {template.name}
                                </span>
                            </label>
                        ))}
                    </div>

                    {/* 選択数表示 */}
                    <div className="mt-4 text-sm text-gray-600">
                        {selected.size}個のプロンプトを選択中
                    </div>
                </div>

                {/* フッター */}
                <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200">
                    <button
                        onClick={handleCancel}
                        disabled={isLoading}
                        className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        キャンセル
                    </button>
                    <button
                        onClick={handleAdd}
                        disabled={isLoading || selected.size === 0}
                        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isLoading ? '追加中...' : '追加'}
                    </button>
                </div>
            </div>
        </div>
    );
};

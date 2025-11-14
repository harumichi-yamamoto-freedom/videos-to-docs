'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { X, Download, Trash2, Eye, FileText, Check } from 'lucide-react';
import ReactMarkdown, { Components } from 'react-markdown';

type CodeProps = React.HTMLAttributes<HTMLElement> & { inline?: boolean };

export interface ContentEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content: string;
    isEditable?: boolean; // 編集可能かどうか（デフォルト: true）
    showDownload?: boolean; // ダウンロードボタンを表示するか（デフォルト: false）
    onSave?: (title: string, content: string) => Promise<void>; // タイトルとコンテンツの両方を保存
    onDelete?: () => void;
    onDownload?: () => void;
    warningMessage?: React.ReactNode; // 警告メッセージ（本文の下に表示）
    contentLabel?: string; // コンテンツのラベル（デフォルト: 'コンテンツ'）
    renderExtraContent?: (params: { isViewMode: boolean; saving: boolean }) => React.ReactNode;
}

export const ContentEditModal: React.FC<ContentEditModalProps> = ({
    isOpen,
    onClose,
    title: initialTitle,
    content: initialContent,
    isEditable = true,
    showDownload = false,
    onSave,
    onDelete,
    onDownload,
    warningMessage,
    contentLabel = 'コンテンツ',
    renderExtraContent,
}) => {
    const markdownComponents: Components = useMemo(() => ({
        h1: (props) => (
            <h1 className="text-2xl font-bold mt-6 mb-4 text-gray-900" {...props} />
        ),
        h2: (props) => (
            <h2 className="text-xl font-bold mt-5 mb-3 text-gray-900" {...props} />
        ),
        h3: (props) => (
            <h3 className="text-lg font-bold mt-4 mb-2 text-gray-900" {...props} />
        ),
        p: (props) => (
            <p className="mb-4 leading-relaxed" {...props} />
        ),
        ul: (props) => (
            <ul className="list-disc pl-6 mb-4 space-y-1" {...props} />
        ),
        ol: (props) => (
            <ol className="list-decimal pl-6 mb-4 space-y-1" {...props} />
        ),
        li: (props) => (
            <li className="leading-relaxed" {...props} />
        ),
        code: ({ inline, ...props }: CodeProps) =>
            inline ? (
                <code
                    className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono text-purple-600"
                    {...props}
                />
            ) : (
                <code
                    className="block bg-gray-100 p-4 rounded-lg text-sm font-mono overflow-x-auto mb-4"
                    {...props}
                />
            ),
        pre: (props) => (
            <pre className="bg-gray-100 p-4 rounded-lg overflow-x-auto mb-4" {...props} />
        ),
        blockquote: (props) => (
            <blockquote
                className="border-l-4 border-purple-300 pl-4 italic my-4 text-gray-700"
                {...props}
            />
        ),
        strong: (props) => (
            <strong className="font-bold text-gray-900" {...props} />
        ),
        em: (props) => (
            <em className="italic" {...props} />
        ),
        a: (props) => (
            <a
                className="text-blue-600 hover:text-blue-800 underline"
                target="_blank"
                rel="noopener noreferrer"
                {...props}
            />
        ),
    }), []);
    const [title, setTitle] = useState(initialTitle);
    const [content, setContent] = useState(initialContent);
    const [isViewMode, setIsViewMode] = useState(true);
    const [editedTitle, setEditedTitle] = useState(initialTitle);
    const [editedContent, setEditedContent] = useState(initialContent);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [saving, setSaving] = useState(false);

    // 初期値が変更されたときにstateを更新
    useEffect(() => {
        setTitle(initialTitle);
        setContent(initialContent);
        setEditedTitle(initialTitle);
        setEditedContent(initialContent);
    }, [initialTitle, initialContent]);

    // モーダルが開かれたときにリセット
    useEffect(() => {
        if (isOpen) {
            setEditedTitle(initialTitle);
            setEditedContent(initialContent);
            setIsViewMode(true);
            setIsEditingTitle(false);
        }
    }, [isOpen, initialTitle, initialContent]);

    // 編集モードに切り替えたときにタイトルも編集可能にする
    useEffect(() => {
        if (!isViewMode && isEditable) {
            setIsEditingTitle(true);
        } else {
            setIsEditingTitle(false);
        }
    }, [isViewMode, isEditable]);

    if (!isOpen) return null;

    // 変更があるかどうかをチェック
    const hasChanges = editedTitle !== title || editedContent !== content;

    const handleSave = async () => {
        if (!onSave) return;

        if (!editedTitle.trim() || !editedContent.trim()) {
            alert('タイトルと内容を入力してください');
            return;
        }

        try {
            setSaving(true);
            await onSave(editedTitle, editedContent);
            // 保存後にstateを更新して表示モードに遷移
            setTitle(editedTitle);
            setContent(editedContent);
            setIsViewMode(true);
        } catch (error) {
            console.error('保存エラー:', error);
            alert('保存に失敗しました');
        } finally {
            setSaving(false);
        }
    };

    const handleCancelEdit = () => {
        if (hasChanges) {
            if (!confirm('保存されていない変更があります。変更を破棄しますか？')) {
                return;
            }
        }
        setEditedTitle(title);
        setEditedContent(content);
        setIsViewMode(true);
    };

    const handleClose = () => {
        if (!isViewMode && hasChanges) {
            if (!confirm('保存されていない変更があります。変更を破棄して閉じますか？')) {
                return;
            }
        }
        onClose();
    };

    const handleViewModeSwitch = () => {
        if (hasChanges) {
            if (!confirm('保存されていない変更があります。変更を破棄して表示モードに戻りますか？')) {
                return;
            }
        }
        setEditedTitle(title);
        setEditedContent(content);
        setIsViewMode(true);
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
                    {isEditingTitle ? (
                        <div className="flex items-center flex-1 mr-4 space-x-2">
                            <input
                                type="text"
                                value={editedTitle}
                                onChange={(e) => setEditedTitle(e.target.value)}
                                className="flex-1 px-3 py-2 border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900"
                                placeholder="タイトルを入力"
                                autoFocus
                                disabled={saving}
                            />
                        </div>
                    ) : (
                        <div className="flex items-center flex-1 mr-4 space-x-2">
                            <h2 className="text-xl font-bold text-gray-900 truncate">
                                {title}
                            </h2>
                        </div>
                    )}
                    <div className="flex items-center space-x-3">
                        {/* モード切り替えボタン（編集可能な場合のみ） */}
                        {isEditable && onSave && (
                            <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
                                <button
                                    onClick={handleViewModeSwitch}
                                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${
                                        isViewMode
                                            ? 'bg-white text-purple-600 shadow-sm'
                                            : 'text-gray-600 hover:text-gray-900'
                                    }`}
                                    disabled={saving}
                                >
                                    <Eye className="w-4 h-4" />
                                    <span>表示</span>
                                </button>
                                <button
                                    onClick={() => setIsViewMode(false)}
                                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center space-x-2 ${
                                        !isViewMode
                                            ? 'bg-white text-purple-600 shadow-sm'
                                            : 'text-gray-600 hover:text-gray-900'
                                    }`}
                                    disabled={saving}
                                >
                                    <FileText className="w-4 h-4" />
                                    <span>編集</span>
                                </button>
                            </div>
                        )}
                        <button
                            onClick={handleClose}
                            className="p-2 hover:bg-white rounded-lg transition-colors shadow-sm"
                            title="閉じる"
                        >
                            <X className="w-5 h-5 text-gray-600" />
                        </button>
                    </div>
                </div>

                {/* コンテンツ */}
                <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                    {/* コンテンツ */}
                    <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            {contentLabel}
                        </label>
                        {isViewMode ? (
                            /* 表示モード: Markdownレンダリング */
                            <div className="prose prose-sm max-w-none text-gray-800">
                                <ReactMarkdown components={markdownComponents}>
                                    {content}
                                </ReactMarkdown>
                            </div>
                        ) : (
                            /* 編集モード: テキストエリア */
                            <textarea
                                value={editedContent}
                                onChange={(e) => setEditedContent(e.target.value)}
                                rows={20}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-sm resize-none"
                                placeholder="コンテンツを入力"
                                disabled={saving}
                            />
                        )}
                    </div>

                    {renderExtraContent && (
                        <div className="mt-6">
                            {renderExtraContent({ isViewMode, saving })}
                        </div>
                    )}

                    {/* 警告メッセージ（本文の下） */}
                    {warningMessage && (
                        <div className="mt-4">
                            {warningMessage}
                        </div>
                    )}
                </div>

                {/* フッター */}
                <div className="flex items-center justify-between p-4 border-t bg-white">
                    {isViewMode ? (
                        /* 表示モード: 左詰めで削除（削除可能な場合のみ）、右詰めでダウンロード（ダウンロード可能な場合のみ）または閉じる */
                        <>
                            {onDelete && isEditable ? (
                                <button
                                    onClick={onDelete}
                                    className="px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center space-x-2 shadow-sm font-medium"
                                >
                                    <Trash2 className="w-4 h-4" />
                                    <span>削除</span>
                                </button>
                            ) : (
                                <div></div>
                            )}
                            <div className="flex items-center space-x-3">
                                {showDownload && onDownload && (
                                    <button
                                        onClick={onDownload}
                                        className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center space-x-2 shadow-sm font-medium"
                                    >
                                        <Download className="w-4 h-4" />
                                        <span>ダウンロード</span>
                                    </button>
                                )}
                                <button
                                    onClick={handleClose}
                                    className="px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                                >
                                    閉じる
                                </button>
                            </div>
                        </>
                    ) : (
                        /* 編集モード: 右詰めで左から順にキャンセルと保存 */
                        <>
                            <div></div>
                            <div className="flex items-center space-x-3">
                                <button
                                    onClick={handleCancelEdit}
                                    disabled={saving}
                                    className="px-6 py-2.5 bg-gray-400 text-white rounded-lg hover:bg-gray-500 transition-colors shadow-sm font-medium disabled:opacity-50"
                                >
                                    キャンセル
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="px-6 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors shadow-sm font-medium flex items-center space-x-2 disabled:opacity-50"
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
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};


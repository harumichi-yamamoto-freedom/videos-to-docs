'use client';

import React, { useState, useEffect, useId, useMemo, useRef } from 'react';
import { X, Trash2, Eye, FileText, Check } from 'lucide-react';
import ReactMarkdown, { Components } from 'react-markdown';
import type { DefaultPromptTemplate } from '@/lib/adminSettings';
import { canonicalizeGeminiModel } from '@/constants/geminiModels';
import {
    canonicalizeThinkingLevel,
    THINKING_LEVELS,
} from '@/constants/geminiThinking';
import { Dialog } from '@/components/ui/Dialog';
import {
    effectiveThinkingLevel,
    ModelComboboxSelect,
    supportsThinkingLevel,
} from '../ModelComboboxSelect';

type CodeProps = React.HTMLAttributes<HTMLElement> & { inline?: boolean };

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

    const initialName = prompt?.name || '';
    const initialContent = prompt?.content || '';
    const initialModel = canonicalizeGeminiModel(prompt?.model);
    const initialThinkingLevel = canonicalizeThinkingLevel(prompt?.thinkingLevel);

    const [title, setTitle] = useState(initialName);
    const [content, setContent] = useState(initialContent);
    const [selectedModel, setSelectedModel] = useState(initialModel);
    const [selectedThinkingLevel, setSelectedThinkingLevel] = useState(initialThinkingLevel);
    const [isViewMode, setIsViewMode] = useState(mode === 'create' ? false : true);
    const [editedTitle, setEditedTitle] = useState(initialName);
    const [editedContent, setEditedContent] = useState(initialContent);
    const [editedModel, setEditedModel] = useState(initialModel);
    const [editedThinkingLevel, setEditedThinkingLevel] = useState(initialThinkingLevel);
    const [saving, setSaving] = useState(false);
    const titleId = useId();
    const titleInputRef = useRef<HTMLInputElement>(null);

    // The title input is exactly the edit mode's rendering of the heading, so it
    // is derived instead of mirrored into state: a separate state only re-synced
    // on isViewMode changes stayed stale when the modal reopened in the mode it
    // already held.
    const isEditingTitle = !isViewMode;
    const thinkingLevelDescriptionId = useId();
    const thinkingLevelSupported = supportsThinkingLevel(
        isViewMode ? selectedModel : editedModel,
    );

    // 初期値が変更されたときにstateを更新
    useEffect(() => {
        setTitle(initialName);
        setContent(initialContent);
        setSelectedModel(initialModel);
        setSelectedThinkingLevel(initialThinkingLevel);
        setEditedTitle(initialName);
        setEditedContent(initialContent);
        setEditedModel(initialModel);
        setEditedThinkingLevel(initialThinkingLevel);
    }, [initialName, initialContent, initialModel, initialThinkingLevel]);

    // モーダルが開かれたときにリセット
    useEffect(() => {
        if (isOpen) {
            setEditedTitle(initialName);
            setEditedContent(initialContent);
            setEditedModel(initialModel);
            setSelectedThinkingLevel(initialThinkingLevel);
            setEditedThinkingLevel(initialThinkingLevel);
            setIsViewMode(mode === 'create' ? false : true);
        }
    }, [isOpen, initialName, initialContent, initialModel, initialThinkingLevel, mode]);

    // 変更があるかどうかをチェック
    const hasChanges =
        editedTitle !== title ||
        editedContent !== content ||
        editedModel !== selectedModel ||
        effectiveThinkingLevel(editedModel, editedThinkingLevel)
            !== effectiveThinkingLevel(selectedModel, selectedThinkingLevel);

    const headingText = title
        || (mode === 'create' ? 'デフォルトプロンプトを追加' : 'デフォルトプロンプトを編集');

    const handleSave = async () => {
        if (!editedTitle.trim() || !editedContent.trim()) {
            alert('名前と内容を入力してください');
            return;
        }

        try {
            setSaving(true);
            onSave({
                name: editedTitle.trim(),
                content: editedContent.trim(),
                model: canonicalizeGeminiModel(editedModel),
                thinkingLevel: effectiveThinkingLevel(
                    canonicalizeGeminiModel(editedModel),
                    canonicalizeThinkingLevel(editedThinkingLevel),
                ),
            });
            // 保存後にstateを更新して表示モードに遷移
            setTitle(editedTitle);
            setContent(editedContent);
            setSelectedModel(editedModel);
            setSelectedThinkingLevel(effectiveThinkingLevel(
                canonicalizeGeminiModel(editedModel),
                canonicalizeThinkingLevel(editedThinkingLevel),
            ));
            setIsViewMode(true);
            onClose();
        } catch {
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
        setEditedModel(selectedModel);
        setEditedThinkingLevel(selectedThinkingLevel);
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
        setEditedModel(selectedModel);
        setEditedThinkingLevel(selectedThinkingLevel);
        setIsViewMode(true);
    };

    const handleDelete = () => {
        if (!confirm(`「${title}」を削除しますか？`)) return;
        if (onDelete) {
            onDelete();
            onClose();
        }
    };

    // 警告メッセージ
    const warningMessage = (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-xs text-blue-800">
                ℹ️ このプロンプトは新規ユーザーのアカウント作成時に自動的に追加されます
            </p>
        </div>
    );

    return (
        <Dialog
            isOpen={isOpen}
            onClose={handleClose}
            initialFocusRef={titleInputRef}
            dismissible={!saving}
            aria-labelledby={titleId}
            aria-busy={saving || undefined}
            className="w-[calc(100%-2rem)] max-w-4xl max-h-[90dvh] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl open:flex open:flex-col"
        >
            <div className="flex max-h-[90dvh] min-h-0 flex-col">
                {/* ヘッダー */}
                <div className="flex shrink-0 items-center justify-between p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                    <div className="flex items-center flex-1 mr-4 min-w-0">
                        <div className="min-w-0 flex-1">
                            {/* The heading always exists so aria-labelledby never dangles;
                                in edit mode the input renders it and the heading goes
                                screen-reader only. */}
                            <h2
                                id={titleId}
                                tabIndex={-1}
                                data-dialog-initial-focus
                                className={isEditingTitle
                                    ? 'sr-only'
                                    : 'truncate rounded-sm text-xl font-bold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2'}
                            >
                                {isEditingTitle ? `${headingText}（編集中）` : headingText}
                            </h2>
                            {isEditingTitle && (
                                <input
                                    ref={titleInputRef}
                                    type="text"
                                    value={editedTitle}
                                    onChange={(e) => setEditedTitle(e.target.value)}
                                    className="min-h-11 w-full min-w-0 rounded-lg border border-purple-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500"
                                    placeholder="プロンプト名を入力"
                                    aria-label="プロンプト名"
                                    disabled={saving}
                                />
                            )}
                        </div>
                    </div>
                    <div className="flex items-center space-x-3">
                        {/* モード切り替えボタン */}
                        <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
                            <button
                                type="button"
                                onClick={handleViewModeSwitch}
                                className={`flex min-h-11 items-center space-x-2 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 ${
                                    isViewMode
                                        ? 'bg-white text-purple-600 shadow-sm'
                                        : 'text-gray-700 hover:text-gray-900'
                                }`}
                                aria-pressed={isViewMode}
                                disabled={saving}
                            >
                                <Eye className="w-4 h-4" />
                                <span>表示</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsViewMode(false)}
                                className={`flex min-h-11 items-center space-x-2 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 ${
                                    !isViewMode
                                        ? 'bg-white text-purple-600 shadow-sm'
                                        : 'text-gray-700 hover:text-gray-900'
                                }`}
                                aria-pressed={!isViewMode}
                                disabled={saving}
                            >
                                <FileText className="w-4 h-4" />
                                <span>編集</span>
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={handleClose}
                            disabled={saving}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg shadow-sm transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label="閉じる"
                            title="閉じる"
                        >
                            <X className="w-5 h-5 text-gray-700" />
                        </button>
                    </div>
                </div>

                {/* コンテンツ */}
                <div className="min-h-0 flex-1 overflow-y-auto p-6 bg-gray-50">
                    {/* コンテンツ */}
                    <div>
                        <span className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
                            プロンプト内容
                        </span>
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
                                placeholder="プロンプト内容を入力"
                                aria-label="プロンプト内容"
                                disabled={saving}
                            />
                        )}
                    </div>

                    <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                        {/* Geminiモデル選択 */}
                        <div>
                            <span className="block text-sm font-semibold text-gray-700 mb-2">
                                使用するGeminiモデル
                            </span>
                            <ModelComboboxSelect
                                value={isViewMode ? selectedModel : editedModel}
                                onChange={setEditedModel}
                                disabled={isViewMode || saving}
                            />
                        </div>

                        {/* 思考レベル選択 */}
                        <div>
                            <label
                                htmlFor="default-prompt-thinking-level"
                                className="block text-sm font-semibold text-gray-700 mb-2"
                            >
                                思考レベル
                            </label>
                            <select
                                id="default-prompt-thinking-level"
                                value={isViewMode
                                    ? effectiveThinkingLevel(selectedModel, selectedThinkingLevel)
                                    : effectiveThinkingLevel(editedModel, editedThinkingLevel)}
                                onChange={(e) =>
                                    setEditedThinkingLevel(canonicalizeThinkingLevel(e.target.value))
                                }
                                disabled={isViewMode || saving || !thinkingLevelSupported}
                                aria-describedby={!thinkingLevelSupported
                                    ? thinkingLevelDescriptionId
                                    : undefined}
                                className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-gray-900 focus:border-transparent focus:ring-2 focus:ring-purple-500 disabled:bg-gray-100 disabled:text-gray-600"
                            >
                                {THINKING_LEVELS.map(level => (
                                    <option key={level.id} value={level.id}>
                                        {level.description
                                            ? `${level.label}（${level.description}）`
                                            : level.label}
                                    </option>
                                ))}
                            </select>
                            {!thinkingLevelSupported && (
                                <p
                                    id={thinkingLevelDescriptionId}
                                    className="mt-2 text-xs leading-relaxed text-gray-600"
                                >
                                    このモデルでは思考レベルを指定できません。
                                </p>
                            )}
                        </div>
                    </div>

                    {/* 警告メッセージ（本文の下） */}
                    {warningMessage && (
                        <div className="mt-4">
                            {warningMessage}
                        </div>
                    )}
                </div>

                {/* フッター */}
                <div className="flex shrink-0 items-center justify-between p-4 border-t bg-white">
                    {isViewMode ? (
                        /* 表示モード: 左詰めで削除（削除可能な場合のみ）、右詰めで閉じる */
                        <>
                            {onDelete && mode === 'edit' ? (
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    className="inline-flex min-h-11 items-center space-x-2 rounded-lg bg-red-600 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2"
                                >
                                    <Trash2 className="w-4 h-4" />
                                    <span>削除</span>
                                </button>
                            ) : (
                                <div></div>
                            )}
                            <div className="flex items-center space-x-3">
                                <button
                                    type="button"
                                    onClick={handleClose}
                                    className="min-h-11 rounded-lg border border-gray-400 px-6 py-2.5 font-medium text-gray-800 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-600 focus-visible:ring-offset-2"
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
                                    type="button"
                                    onClick={handleCancelEdit}
                                    disabled={saving}
                                    className="min-h-11 rounded-lg border border-gray-400 bg-white px-6 py-2.5 font-medium text-gray-800 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    キャンセル
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="inline-flex min-h-11 items-center space-x-2 rounded-lg bg-green-700 px-6 py-2.5 font-medium text-white shadow-sm transition-colors hover:bg-green-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {saving ? (
                                        <>
                                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                                            <span>保存中...</span>
                                        </>
                                    ) : (
                                        <>
                                            <Check className="w-4 h-4" />
                                            <span>{mode === 'create' ? '追加' : '保存'}</span>
                                        </>
                                    )}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </Dialog>
    );
}

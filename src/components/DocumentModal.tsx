'use client';

import React from 'react';
import { ContentEditModal } from './ContentEditModal';

interface DocumentModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content: string;
    onDownload: () => void;
    onDelete: () => void;
    onTitleUpdate?: (newTitle: string) => Promise<void>;
    onContentUpdate?: (newContent: string) => Promise<void>;
}

export const DocumentModal: React.FC<DocumentModalProps> = ({
    isOpen,
    onClose,
    title,
    content,
    onDownload,
    onDelete,
    onTitleUpdate,
    onContentUpdate,
}) => {
    const handleSave = async (newTitle: string, newContent: string) => {
        // タイトルとコンテンツの両方を更新
        const updates: Promise<void>[] = [];
        if (onTitleUpdate && newTitle !== title) {
            updates.push(onTitleUpdate(newTitle));
        }
        if (onContentUpdate && newContent !== content) {
            updates.push(onContentUpdate(newContent));
        }
        // 並列で実行
        await Promise.all(updates);
    };

    return (
        <ContentEditModal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            content={content}
            isEditable={!!onContentUpdate}
            showDownload={true}
            onSave={onContentUpdate ? handleSave : undefined}
            onDelete={onDelete}
            onDownload={onDownload}
            contentLabel="文書内容"
        />
    );
};

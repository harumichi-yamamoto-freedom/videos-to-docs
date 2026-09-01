import React from 'react';
import type { Transcription } from '@/lib/firestore';
import { formatPdfDateTime } from '@/lib/pdfExport';
import { getGeminiModelLabel } from '../constants/geminiModels';
import { THINKING_LEVELS } from '../constants/geminiThinking';

function getThinkingLevelLabel(level: string): string {
    const normalizedLevel = level.trim().toLowerCase();
    if (normalizedLevel === 'unspecified') {
        return '未指定';
    }

    return (
        THINKING_LEVELS.find(option => option.id === normalizedLevel)?.label ?? level
    );
}

export type PdfDocumentHeaderProps = {
    document: Transcription;
};

export function PdfDocumentHeader({
    document,
}: PdfDocumentHeaderProps): React.ReactElement {
    return (
        <header className="pdf-document__header">
            <h1 className="pdf-document__title">{document.title}</h1>
            <dl className="pdf-document__meta">
                <dt>生成日時</dt>
                <dd>{formatPdfDateTime(document.createdAt)}</dd>
                <dt>元ファイル</dt>
                <dd>{document.fileName}</dd>
                <dt>プロンプト</dt>
                <dd>{document.promptName}</dd>
                {document.generatedByModel && (
                    <>
                        <dt>使用モデル</dt>
                        <dd>
                            {getGeminiModelLabel(document.generatedByModel)}
                            {document.modelSelection === 'default' && '（デフォルト選択）'}
                            {document.generatedByThinkingLevel &&
                                `・思考: ${getThinkingLevelLabel(document.generatedByThinkingLevel)}`}
                        </dd>
                    </>
                )}
            </dl>
        </header>
    );
}

'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import type { Transcription } from '@/lib/firestore';
import { formatPdfDateTime } from '@/lib/pdfExport';
import { MarkdownDocument } from '@/components/MarkdownDocument';
import {
    normalizePdfThemeId,
    type PdfThemeId,
} from '../constants/pdfThemes';

export type DocumentPrintPortalProps = {
    document: Transcription;
    active: boolean;
    includeMetadata: boolean;
    theme?: PdfThemeId;
};

export function DocumentPrintPortal({
    document,
    active,
    includeMetadata,
    theme,
}: DocumentPrintPortalProps): React.ReactPortal | null {
    if (!active) {
        return null;
    }

    const resolvedTheme = normalizePdfThemeId(theme);

    return createPortal(
        <div className={`pdf-print-root pdf-theme-${resolvedTheme}`}>
            <article className="pdf-document">
                {includeMetadata && (
                    <header className="pdf-document__header">
                        <h1 className="pdf-document__title">{document.title}</h1>
                        <dl className="pdf-document__meta">
                            <dt>生成日時</dt>
                            <dd>{formatPdfDateTime(document.createdAt)}</dd>
                            <dt>元ファイル</dt>
                            <dd>{document.fileName}</dd>
                            <dt>プロンプト</dt>
                            <dd>{document.promptName}</dd>
                        </dl>
                    </header>
                )}
                <MarkdownDocument
                    className="pdf-markdown"
                    markdown={document.text}
                />
            </article>
        </div>,
        window.document.body,
    );
}

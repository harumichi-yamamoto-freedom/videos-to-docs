'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import type { Transcription } from '@/lib/firestore';
import { MarkdownDocument } from '@/components/MarkdownDocument';
import { PdfDocumentHeader } from './PdfDocumentHeader';
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
                    <PdfDocumentHeader document={document} />
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

'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import type { Transcription } from '@/lib/firestore';
import { MarkdownDocument } from '@/components/MarkdownDocument';
import { PdfDocumentHeader } from './PdfDocumentHeader';
import {
    normalizePdfFontId,
    resolvePdfFontId,
    type PdfFontId,
} from '../constants/pdfFonts';
import {
    normalizePdfThemeId,
    type PdfThemeId,
} from '../constants/pdfThemes';

export type DocumentPrintPortalProps = {
    document: Transcription;
    active: boolean;
    includeMetadata: boolean;
    theme?: PdfThemeId;
    font?: PdfFontId;
};

export function DocumentPrintPortal({
    document,
    active,
    includeMetadata,
    theme,
    font,
}: DocumentPrintPortalProps): React.ReactPortal | null {
    if (!active) {
        return null;
    }

    const resolvedTheme = normalizePdfThemeId(theme);
    const resolvedFont = resolvePdfFontId(normalizePdfFontId(font), resolvedTheme);

    return createPortal(
        <div
            className={`pdf-print-root pdf-theme-${resolvedTheme} pdf-font-${resolvedFont}`}
        >
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

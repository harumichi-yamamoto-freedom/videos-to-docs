'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Transcription } from '@/lib/firestore';
import { formatPdfDateTime } from '@/lib/pdfExport';
import { MarkdownDocument } from '@/components/MarkdownDocument';

export type DocumentPrintPortalProps = {
    document: Transcription;
};

export function DocumentPrintPortal({
    document,
}: DocumentPrintPortalProps): React.ReactPortal | null {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const frameId = window.requestAnimationFrame(() => setMounted(true));

        return () => window.cancelAnimationFrame(frameId);
    }, []);

    if (!mounted) {
        return null;
    }

    return createPortal(
        <div className="pdf-print-root">
            <article className="pdf-document">
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
                <MarkdownDocument
                    className="pdf-markdown"
                    markdown={document.text}
                />
            </article>
        </div>,
        window.document.body,
    );
}

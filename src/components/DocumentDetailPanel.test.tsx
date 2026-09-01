import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcription } from '@/lib/firestore';
import { DocumentDetailPanel } from './DocumentDetailPanel';

const printPdf = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();

    return {
        ...actual,
        useEffect: vi.fn(),
        useState: vi.fn(),
    };
});

vi.mock('@/hooks/useDocumentPrint', () => ({
    useDocumentPrint: () => ({ printPdf, isPreparing: false }),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn() }),
}));

vi.mock('@/components/MarkdownDocument', () => ({
    MarkdownDocument: () => null,
}));

vi.mock('@/components/DocumentPrintPortal', () => ({
    DocumentPrintPortal: () => null,
}));

type ButtonProps = {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick: () => void;
    title?: string;
};

function getText(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }

    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return '';
    }

    return React.Children.toArray(node.props.children).map(getText).join('');
}

function findPdfButton(
    node: React.ReactNode,
): React.ReactElement<ButtonProps> | null {
    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return null;
    }

    if (node.type === 'button' && getText(node).includes('PDF に保存')) {
        return node as React.ReactElement<ButtonProps>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const button = findPdfButton(child);

        if (button) {
            return button;
        }
    }

    return null;
}

describe('DocumentDetailPanel PDF 出力', () => {
    beforeEach(() => {
        printPdf.mockClear();
        vi.mocked(useState).mockReset();
    });

    it('保存中は表示モードへ戻ってもクリックを拒否する', () => {
        const document: Transcription = {
            id: 'document-1',
            title: '新タイトル',
            fileName: 'meeting.mp4',
            text: '新しい本文',
            promptName: '議事録',
            createdAt: new Date('2026-09-01T05:30:00.000Z'),
        };

        vi.mocked(useState)
            .mockImplementationOnce(() => [true, vi.fn()])
            .mockImplementationOnce(() => [document.title, vi.fn()])
            .mockImplementationOnce(() => [document.text, vi.fn()])
            .mockImplementationOnce(() => [true, vi.fn()]);

        const tree = DocumentDetailPanel({
            document,
            onContentUpdate: async () => undefined,
        }) as React.ReactNode;
        const pdfButton = findPdfButton(tree);

        expect(pdfButton).not.toBeNull();
        expect(pdfButton?.props.disabled).toBe(true);
        expect(pdfButton?.props.title).toBe('保存完了後に PDF 出力できます');

        pdfButton?.props.onClick();

        expect(printPdf).not.toHaveBeenCalled();
    });
});

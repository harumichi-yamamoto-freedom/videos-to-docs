import React, { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcription } from '@/lib/firestore';
import { DocumentDetailPanel } from './DocumentDetailPanel';

const { documentPrintPortal, printPdf } = vi.hoisted(() => ({
    documentPrintPortal: vi.fn(() => null),
    printPdf: vi.fn(async (): Promise<void> => undefined),
}));

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
    DocumentPrintPortal: documentPrintPortal,
}));

type ButtonProps = {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick: () => void;
    title?: string;
};

type CheckboxProps = {
    checked: boolean;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

type DocumentPrintPortalProps = {
    active: boolean;
    includeMetadata: boolean;
};

const document: Transcription = {
    id: 'document-1',
    title: '新タイトル',
    fileName: 'meeting.mp4',
    text: '新しい本文',
    promptName: '議事録',
    createdAt: new Date('2026-09-01T05:30:00.000Z'),
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

function findMetadataCheckbox(
    node: React.ReactNode,
): React.ReactElement<CheckboxProps> | null {
    if (!React.isValidElement<{ children?: React.ReactNode; type?: string }>(node)) {
        return null;
    }

    if (node.type === 'input' && node.props.type === 'checkbox') {
        return node as React.ReactElement<CheckboxProps>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const checkbox = findMetadataCheckbox(child);

        if (checkbox) {
            return checkbox;
        }
    }

    return null;
}

function findPrintPortal(
    node: React.ReactNode,
): React.ReactElement<DocumentPrintPortalProps> | null {
    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return null;
    }

    if (node.type === documentPrintPortal) {
        return node as React.ReactElement<DocumentPrintPortalProps>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const portal = findPrintPortal(child);

        if (portal) {
            return portal;
        }
    }

    return null;
}

function mockPanelState({
    includeMetadata = false,
    saving = false,
    setIncludeMetadata = vi.fn(),
}: {
    includeMetadata?: boolean;
    saving?: boolean;
    setIncludeMetadata?: ReturnType<typeof vi.fn>;
} = {}): void {
    vi.mocked(useState)
        .mockImplementationOnce(() => [true, vi.fn()])
        .mockImplementationOnce(() => [document.title, vi.fn()])
        .mockImplementationOnce(() => [document.text, vi.fn()])
        .mockImplementationOnce(() => [saving, vi.fn()])
        .mockImplementationOnce(() => [includeMetadata, setIncludeMetadata]);
}

describe('DocumentDetailPanel PDF 出力', () => {
    const localStorageGetItem = vi.fn<() => string | null>(() => null);
    const localStorageSetItem = vi.fn();

    beforeEach(() => {
        printPdf.mockClear();
        vi.mocked(useState).mockReset();
        vi.mocked(useEffect).mockReset();
        localStorageGetItem.mockReset();
        localStorageGetItem.mockReturnValue(null);
        localStorageSetItem.mockReset();
        vi.stubGlobal('window', {
            document: { body: {} },
            localStorage: {
                getItem: localStorageGetItem,
                setItem: localStorageSetItem,
            },
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('文書情報は既定 OFF で portal に渡す', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({ document }) as React.ReactNode;
        const checkbox = findMetadataCheckbox(tree);
        const portal = findPrintPortal(tree);

        expect(useState).toHaveBeenNthCalledWith(5, false);
        expect(checkbox?.props.checked).toBe(false);
        expect(portal?.props.includeMetadata).toBe(false);
    });

    it('文書情報を選択すると設定を保存し portal に true を渡す', () => {
        const setIncludeMetadata = vi.fn();
        mockPanelState({ setIncludeMetadata });

        const initialTree = DocumentDetailPanel({ document }) as React.ReactNode;
        const checkbox = findMetadataCheckbox(initialTree);

        checkbox?.props.onChange({
            target: { checked: true },
        } as React.ChangeEvent<HTMLInputElement>);

        expect(setIncludeMetadata).toHaveBeenCalledWith(true);
        expect(localStorageSetItem).toHaveBeenCalledWith('pdfIncludeMetadata', 'true');

        vi.mocked(useState).mockReset();
        mockPanelState({ includeMetadata: true });

        const selectedTree = DocumentDetailPanel({ document }) as React.ReactNode;
        expect(findPrintPortal(selectedTree)?.props.includeMetadata).toBe(true);
    });

    it('保存中は表示モードへ戻ってもクリックを拒否する', () => {
        mockPanelState({ saving: true });

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

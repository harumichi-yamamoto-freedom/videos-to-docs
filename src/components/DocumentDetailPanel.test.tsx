import React, { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcription } from '@/lib/firestore';
import { DocumentDetailPanel } from './DocumentDetailPanel';

const { createPortal, documentPrintPortal, printPdf } = vi.hoisted(() => ({
    createPortal: vi.fn((children: React.ReactNode) => children),
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

vi.mock('@/lib/pdfExport', () => ({
    formatPdfDateTime: vi.fn(() => ''),
}));

vi.mock('@/components/MarkdownDocument', () => ({
    MarkdownDocument: () => null,
}));

vi.mock('@/components/DocumentPrintPortal', () => ({
    DocumentPrintPortal: documentPrintPortal,
}));

vi.mock('react-dom', () => ({
    createPortal,
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

type SelectProps = {
    'aria-label'?: string;
    onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
    value: string;
};

type DocumentPrintPortalProps = {
    active: boolean;
    includeMetadata: boolean;
    theme: string;
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

function findPdfThemeSelect(
    node: React.ReactNode,
): React.ReactElement<SelectProps> | null {
    if (!React.isValidElement<SelectProps & { children?: React.ReactNode }>(node)) {
        return null;
    }

    if (node.type === 'select' && node.props['aria-label'] === 'PDF デザイン') {
        return node as React.ReactElement<SelectProps>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const select = findPdfThemeSelect(child);

        if (select) {
            return select;
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
    pdfTheme = 'editorial',
    saving = false,
    setIncludeMetadata = vi.fn(),
    setPdfTheme = vi.fn(),
}: {
    includeMetadata?: boolean;
    pdfTheme?: string;
    saving?: boolean;
    setIncludeMetadata?: ReturnType<typeof vi.fn>;
    setPdfTheme?: ReturnType<typeof vi.fn>;
} = {}): void {
    vi.mocked(useState)
        .mockImplementationOnce(() => [true, vi.fn()])
        .mockImplementationOnce(() => [document.title, vi.fn()])
        .mockImplementationOnce(() => [document.text, vi.fn()])
        .mockImplementationOnce(() => [saving, vi.fn()])
        .mockImplementationOnce(() => [includeMetadata, setIncludeMetadata])
        .mockImplementationOnce(() => [pdfTheme, setPdfTheme]);
}

describe('DocumentDetailPanel', () => {
    const localStorageGetItem = vi.fn<(key: string) => string | null>(() => null);
    const localStorageSetItem = vi.fn();

    beforeEach(() => {
        createPortal.mockClear();
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

    it('記録された解決済みモデル ID を表示名に変換して表示する', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({
            document: {
                ...document,
                generatedByModel: 'gemini-3.7-flash',
                modelSelection: 'pinned',
            },
        }) as React.ReactNode;

        expect(getText(tree)).toContain('使用モデル: Gemini 3.7 Flash');
        expect(getText(tree)).not.toContain('デフォルト選択');
    });

    it('デフォルト選択で生成した文書には注記を添える', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({
            document: {
                ...document,
                generatedByModel: 'gemini-3.7-flash',
                modelSelection: 'default',
            },
        }) as React.ReactNode;

        expect(getText(tree)).toContain(
            '使用モデル: Gemini 3.7 Flash（デフォルト選択）',
        );
    });

    it('記録された思考レベルを表示名に変換して使用モデル行へ表示する', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({
            document: {
                ...document,
                generatedByModel: 'gemini-3.7-flash',
                generatedByThinkingLevel: 'HIGH',
                modelSelection: 'pinned',
            },
        }) as React.ReactNode;

        expect(getText(tree)).toContain(
            '使用モデル: Gemini 3.7 Flash・思考: 高',
        );
    });

    it('思考レベルが unspecified の文書には未指定と表示する', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({
            document: {
                ...document,
                generatedByModel: 'gemini-2.5-pro',
                generatedByThinkingLevel: 'unspecified',
                modelSelection: 'pinned',
            },
        }) as React.ReactNode;

        expect(getText(tree)).toContain(
            '使用モデル: Gemini 2.5 Pro・思考: 未指定',
        );
    });

    it('思考レベルの記録がない過去文書では思考表示を添えない', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({
            document: {
                ...document,
                generatedByModel: 'gemini-3.7-flash',
                modelSelection: 'pinned',
            },
        }) as React.ReactNode;

        expect(getText(tree)).not.toContain('思考:');
    });

    it('未知の思考レベルは自動へ丸めず記録値を表示する', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({
            document: {
                ...document,
                generatedByModel: 'gemini-3.7-flash',
                generatedByThinkingLevel: 'FUTURE',
                modelSelection: 'pinned',
            },
        }) as React.ReactNode;

        expect(getText(tree)).toContain(
            '使用モデル: Gemini 3.7 Flash・思考: FUTURE',
        );
        expect(getText(tree)).not.toContain('思考: 自動');
    });

    it('モデルの記録がない過去文書では使用モデル行を表示しない', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({ document }) as React.ReactNode;

        expect(getText(tree)).not.toContain('使用モデル:');
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

    it('PDF デザインは editorial を既定値として select と portal に渡す', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({ document }) as React.ReactNode;
        const select = findPdfThemeSelect(tree);
        const portal = findPrintPortal(tree);

        expect(useState).toHaveBeenNthCalledWith(6, 'editorial');
        expect(select).not.toBeNull();
        expect(select?.props.value).toBe('editorial');
        expect(portal?.props.theme).toBe('editorial');
    });

    it('PDF デザインを選択すると pdfTheme に保存し portal に渡す', () => {
        const setPdfTheme = vi.fn();
        mockPanelState({ setPdfTheme });

        const initialTree = DocumentDetailPanel({ document }) as React.ReactNode;
        const select = findPdfThemeSelect(initialTree);

        expect(select).not.toBeNull();
        select?.props.onChange({
            target: { value: 'minimal' },
        } as React.ChangeEvent<HTMLSelectElement>);

        expect(setPdfTheme).toHaveBeenCalledWith('minimal');
        expect(localStorageSetItem).toHaveBeenCalledWith('pdfTheme', 'minimal');

        vi.mocked(useState).mockReset();
        mockPanelState({ pdfTheme: 'minimal' });

        const selectedTree = DocumentDetailPanel({ document }) as React.ReactNode;
        expect(findPrintPortal(selectedTree)?.props.theme).toBe('minimal');
    });

    it('保存済みの有効な PDF デザインを読み戻す', () => {
        const setPdfTheme = vi.fn();
        localStorageGetItem.mockImplementation(key => (
            key === 'pdfTheme' ? 'minimal' : null
        ));
        mockPanelState({ setPdfTheme });

        DocumentDetailPanel({ document });

        for (const [effect, dependencies] of vi.mocked(useEffect).mock.calls) {
            if (Array.isArray(dependencies) && dependencies.length === 0) {
                effect();
            }
        }

        expect(localStorageGetItem).toHaveBeenCalledWith('pdfTheme');
        expect(setPdfTheme).toHaveBeenCalledWith('minimal');
    });

    it('不正な保存済み PDF デザインは editorial にフォールバックする', () => {
        const setPdfTheme = vi.fn();
        localStorageGetItem.mockImplementation(key => (
            key === 'pdfTheme' ? 'unknown-theme' : null
        ));
        mockPanelState({ setPdfTheme });

        DocumentDetailPanel({ document });

        for (const [effect, dependencies] of vi.mocked(useEffect).mock.calls) {
            if (Array.isArray(dependencies) && dependencies.length === 0) {
                effect();
            }
        }

        expect(localStorageGetItem).toHaveBeenCalledWith('pdfTheme');
        expect(setPdfTheme).toHaveBeenCalledWith('editorial');
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

describe('DocumentPrintPortal PDF テーマ', () => {
    beforeEach(() => {
        vi.stubGlobal('window', { document: { body: {} } });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('選択テーマをルート class に反映する', async () => {
        const { DocumentPrintPortal: ActualDocumentPrintPortal } =
            await vi.importActual<typeof import('./DocumentPrintPortal')>(
                './DocumentPrintPortal',
            );

        const portal = ActualDocumentPrintPortal({
            document,
            active: true,
            includeMetadata: false,
            theme: 'minimal',
        }) as unknown as React.ReactElement<{ className: string }>;

        expect(portal.props.className).toBe('pdf-print-root pdf-theme-minimal');
    });

    it('テーマ未指定時は editorial のルート class にフォールバックする', async () => {
        const { DocumentPrintPortal: ActualDocumentPrintPortal } =
            await vi.importActual<typeof import('./DocumentPrintPortal')>(
                './DocumentPrintPortal',
            );

        const portal = ActualDocumentPrintPortal({
            document,
            active: true,
            includeMetadata: false,
        }) as unknown as React.ReactElement<{ className: string }>;

        expect(portal.props.className).toBe('pdf-print-root pdf-theme-editorial');
    });

    it('文書情報に解決済みモデル名・デフォルト選択の注記・思考レベルを表示する', async () => {
        const { DocumentPrintPortal: ActualDocumentPrintPortal } =
            await vi.importActual<typeof import('./DocumentPrintPortal')>(
                './DocumentPrintPortal',
            );

        const portal = ActualDocumentPrintPortal({
            document: {
                ...document,
                generatedByModel: 'gemini-3.7-flash',
                generatedByThinkingLevel: 'MEDIUM',
                modelSelection: 'default',
            },
            active: true,
            includeMetadata: true,
        }) as unknown as React.ReactNode;

        expect(getText(portal)).toContain(
            '使用モデルGemini 3.7 Flash（デフォルト選択）・思考: 標準',
        );
    });

    it('文書情報の unspecified 思考レベルは未指定と表示する', async () => {
        const { DocumentPrintPortal: ActualDocumentPrintPortal } =
            await vi.importActual<typeof import('./DocumentPrintPortal')>(
                './DocumentPrintPortal',
            );

        const portal = ActualDocumentPrintPortal({
            document: {
                ...document,
                generatedByModel: 'gemini-2.5-pro',
                generatedByThinkingLevel: 'unspecified',
                modelSelection: 'pinned',
            },
            active: true,
            includeMetadata: true,
        }) as unknown as React.ReactNode;

        expect(getText(portal)).toContain(
            '使用モデルGemini 2.5 Pro・思考: 未指定',
        );
    });

    it('文書情報に思考レベルの記録がなければ思考表示を添えない', async () => {
        const { DocumentPrintPortal: ActualDocumentPrintPortal } =
            await vi.importActual<typeof import('./DocumentPrintPortal')>(
                './DocumentPrintPortal',
            );

        const portal = ActualDocumentPrintPortal({
            document: {
                ...document,
                generatedByModel: 'gemini-3.7-flash',
                modelSelection: 'pinned',
            },
            active: true,
            includeMetadata: true,
        }) as unknown as React.ReactNode;

        expect(getText(portal)).not.toContain('思考:');
    });

    it('文書情報を含めない場合は使用モデルを表示しない', async () => {
        const { DocumentPrintPortal: ActualDocumentPrintPortal } =
            await vi.importActual<typeof import('./DocumentPrintPortal')>(
                './DocumentPrintPortal',
            );

        const portal = ActualDocumentPrintPortal({
            document: {
                ...document,
                generatedByModel: 'gemini-3.7-flash',
                modelSelection: 'pinned',
            },
            active: true,
            includeMetadata: false,
        }) as unknown as React.ReactNode;

        expect(getText(portal)).not.toContain('使用モデル');
    });
});

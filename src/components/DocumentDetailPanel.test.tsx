import React, {
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DocumentSizeLimitError,
    TranscriptionConflictError,
    type Transcription,
} from '@/lib/firestore';
import {
    DocumentDetailPanelView as DocumentDetailPanel,
    type DocumentDetailPanelHandle,
} from './DocumentDetailPanel';
import { PdfDocumentHeader } from './PdfDocumentHeader';

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
        useImperativeHandle: vi.fn(),
        useRef: vi.fn(),
        useState: vi.fn(),
    };
});

vi.mock('@/hooks/useDocumentPrint', () => ({
    useDocumentPrint: () => ({ printPdf, isPreparing: false }),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn() }),
}));

// firestore.ts の実クラスを使うため、SDK初期化だけを差し替える。
vi.mock('@/lib/firebase', () => ({
    db: { name: 'mock-firestore' },
    auth: { currentUser: null },
    storage: { name: 'mock-storage' },
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
    className?: string;
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
    font?: string;
};

type PdfPreviewProps = {
    children?: React.ReactNode;
    className: string;
};

const document: Transcription = {
    id: 'document-1',
    title: '新タイトル',
    fileName: 'meeting.mp4',
    text: '新しい本文',
    promptName: '議事録',
    createdAt: new Date('2026-09-01T05:30:00.000Z'),
};

const createdRefs: Array<{ current: unknown }> = [];
// ref生成後にcomponentがcurrentを書き換えるため、特定は生成時の初期値スナップショットで行う。
const createdRefInitials: unknown[] = [];

function findCreatedRef(
    label: string,
    predicate: (initial: unknown) => boolean,
): { current: unknown } {
    const matches = createdRefs.filter((_, index) => predicate(createdRefInitials[index]));
    if (matches.length !== 1) {
        throw new Error(`${label} のrefを一意に特定できません（候補${matches.length}件）`);
    }
    return matches[0];
}

function findSelectedDocumentIdRef(): { current: unknown } {
    return findCreatedRef('selectedDocumentIdRef', initial => initial === document.id);
}

function findDraftBaselineRef(): { current: unknown } {
    return findCreatedRef('baselineRef', initial => Boolean(
        initial
        && typeof initial === 'object'
        && 'documentId' in (initial as Record<string, unknown>),
    ));
}

// rootRefは「描画木のルート要素に渡されたref」として特定する（初期値nullのrefは複数ある）。
function getRootElementRef(tree: React.ReactNode): { current: unknown } {
    if (!React.isValidElement(tree)) {
        throw new Error('描画結果のルートが要素ではありません');
    }
    const refFromProps = (tree.props as { ref?: unknown }).ref;
    const ref = refFromProps ?? (tree as { ref?: unknown }).ref;
    if (!ref || typeof ref !== 'object' || !('current' in ref)) {
        throw new Error('ルート要素のrefを取得できません');
    }
    return ref as { current: unknown };
}

function findPanelEffect(
    label: string,
    predicate: (dependencies: unknown[] | undefined) => boolean,
): () => void {
    const matches = vi.mocked(useEffect).mock.calls
        .filter(([, dependencies]) => predicate(dependencies as unknown[] | undefined));
    if (matches.length !== 1) {
        throw new Error(`${label} のeffectを一意に特定できません（候補${matches.length}件）`);
    }
    return matches[0][0] as () => void;
}

function runDraftRebaseEffect(): void {
    // deps = [id, text, title, updatedAt]
    findPanelEffect('draft rebase', dependencies => dependencies?.length === 4)();
}

function findDraftBaselineUpdatedAtRef(loadedValue: unknown): { current: unknown } {
    return findCreatedRef(
        'draftBaselineUpdatedAtRef',
        initial => initial === loadedValue,
    );
}

function runDirtyNotifyEffect(): void {
    findPanelEffect('dirty notify', dependencies =>
        dependencies?.length === 2
        && typeof dependencies[0] === 'boolean'
        && typeof dependencies[1] === 'function')();
}

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

    if (node.type === 'button' && getText(node).includes('印刷してPDF保存')) {
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

function findButtonByText(
    node: React.ReactNode,
    label: string,
): React.ReactElement<ButtonProps> | null {
    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return null;
    }

    if (node.type === 'button' && getText(node).includes(label)) {
        return node as React.ReactElement<ButtonProps>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const button = findButtonByText(child, label);

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

function findPdfFontSelect(
    node: React.ReactNode,
): React.ReactElement<SelectProps> | null {
    if (!React.isValidElement<SelectProps & { children?: React.ReactNode }>(node)) {
        return null;
    }

    if (node.type === 'select' && node.props['aria-label'] === 'PDF フォント') {
        return node as React.ReactElement<SelectProps>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const select = findPdfFontSelect(child);

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

function findPdfPreview(
    node: React.ReactNode,
): React.ReactElement<PdfPreviewProps> | null {
    if (!React.isValidElement<{
        children?: React.ReactNode;
        className?: unknown;
    }>(node)) {
        return null;
    }

    if (
        node.type === 'div' &&
        typeof node.props.className === 'string' &&
        node.props.className.split(/\s+/).includes('pdf-preview')
    ) {
        return node as React.ReactElement<PdfPreviewProps>;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const preview = findPdfPreview(child);

        if (preview) {
            return preview;
        }
    }

    return null;
}

function findPdfDocumentHeader(
    node: React.ReactNode,
): React.ReactElement<React.ComponentProps<typeof PdfDocumentHeader>> | null {
    if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
        return null;
    }

    if (node.type === PdfDocumentHeader) {
        return node as React.ReactElement<
            React.ComponentProps<typeof PdfDocumentHeader>
        >;
    }

    for (const child of React.Children.toArray(node.props.children)) {
        const header = findPdfDocumentHeader(child);

        if (header) {
            return header;
        }
    }

    return null;
}

// スロット番号(宣言順)は実装へuseStateを1行足すだけで静かにずれる。
// probe描画へ操作を仕掛け、「どのsetterが呼ばれたか」と初期値でスロットを特定する。
type PanelStateName =
    | 'isViewMode'
    | 'editedTitle'
    | 'editedContent'
    | 'saving'
    | 'saveError'
    | 'showDiscardConfirmation'
    | 'includeMetadata'
    | 'pdfTheme'
    | 'pdfFont'
    | 'draftRevision';

function resolveInitialValue(initialValue: unknown): unknown {
    return typeof initialValue === 'function'
        ? (initialValue as () => unknown)()
        : initialValue;
}

function discoverPanelStateSlots(): Record<PanelStateName, number> {
    const setterSlots: Array<ReturnType<typeof vi.fn>> = [];
    const initials: unknown[] = [];
    let probeIndex = 0;

    vi.mocked(useState).mockReset();
    vi.mocked(useState).mockImplementation(((initialValue?: unknown) => {
        const index = probeIndex++;
        const setter = vi.fn();
        setterSlots[index] = setter;
        initials[index] = initialValue;
        // タイトルdraftを初期値からずらしてhasChangesを成立させ、
        // 表示ボタン(requestDiscard)がdiscard確認setterを呼ぶようにする。
        const value = initialValue === document.title
            ? `${document.title}__probe_dirty`
            : resolveInitialValue(initialValue);
        return [value, setter];
    }) as never);

    const stubbedWindow = window as unknown as { localStorage: unknown };
    const realLocalStorage = stubbedWindow.localStorage;
    stubbedWindow.localStorage = {
        getItem: () => null,
        setItem: () => undefined,
    };
    const refCountBeforeProbe = createdRefs.length;

    const identified = new Map<number, PanelStateName>();
    const claim = (name: PanelStateName, candidates: number[]): void => {
        const free = candidates.filter(index => !identified.has(index));
        if (free.length !== 1) {
            throw new Error(`${name} のスロットを一意に特定できません（候補${free.length}件）`);
        }
        identified.set(free[0], name);
    };
    const callCounts = (): number[] => setterSlots.map(setter => setter.mock.calls.length);
    const newlyCalledWith = (
        before: number[],
        match: (value: unknown) => boolean,
    ): number[] => setterSlots
        .map((setter, index) => ({ setter, index }))
        .filter(({ setter, index }) =>
            setter.mock.calls.length > (before[index] ?? 0)
            && setter.mock.calls.slice(before[index] ?? 0).some(call => match(call[0])))
        .map(({ index }) => index);
    const initialSlots = (match: (value: unknown) => boolean): number[] => initials
        .map((value, index) => ({ value, index }))
        .filter(({ value }) => match(value))
        .map(({ index }) => index);

    try {
        const probeTree = DocumentDetailPanel({
            document,
            onDocumentUpdate: async () => undefined,
        }) as React.ReactNode;

        const editButton = findButtonByText(probeTree, '編集');
        const viewButton = findButtonByText(probeTree, '表示');
        const metadataCheckbox = findMetadataCheckbox(probeTree);
        const themeSelect = findPdfThemeSelect(probeTree);
        const fontSelect = findPdfFontSelect(probeTree);
        if (!editButton || !viewButton || !metadataCheckbox || !themeSelect || !fontSelect) {
            throw new Error('スロット特定用の操作UIが見つかりません');
        }

        let before = callCounts();
        editButton.props.onClick();
        claim('isViewMode', newlyCalledWith(before, value => value === false));
        claim('saveError', newlyCalledWith(before, value => value === null));

        before = callCounts();
        metadataCheckbox.props.onChange({
            target: { checked: true },
        } as React.ChangeEvent<HTMLInputElement>);
        claim('includeMetadata', newlyCalledWith(before, value => value === true));

        before = callCounts();
        themeSelect.props.onChange({
            target: { value: 'minimal' },
        } as React.ChangeEvent<HTMLSelectElement>);
        claim('pdfTheme', newlyCalledWith(before, () => true));

        before = callCounts();
        fontSelect.props.onChange({
            target: { value: 'mincho' },
        } as React.ChangeEvent<HTMLSelectElement>);
        claim('pdfFont', newlyCalledWith(before, () => true));

        before = callCounts();
        viewButton.props.onClick();
        claim('showDiscardConfirmation', newlyCalledWith(before, value => value === true));

        claim('editedTitle', initialSlots(value => value === document.title));
        claim('editedContent', initialSlots(value => value === document.text));
        claim('draftRevision', initialSlots(value => value === 0));
        claim('saving', initialSlots(value => value === false));
    } finally {
        stubbedWindow.localStorage = realLocalStorage;
        createdRefs.length = refCountBeforeProbe;
        createdRefInitials.length = refCountBeforeProbe;
        vi.mocked(useEffect).mockClear();
        vi.mocked(useImperativeHandle).mockClear();
    }

    const slots = {} as Record<PanelStateName, number>;
    for (const [index, name] of identified) {
        slots[name] = index;
    }
    return slots;
}

function mockPanelState({
    isViewMode = true,
    editedTitle = document.title,
    editedContent = document.text,
    includeMetadata = false,
    pdfTheme = 'editorial',
    pdfFont = 'auto',
    saving = false,
    saveError = null,
    showDiscardConfirmation = false,
    setIsViewMode = vi.fn(),
    setEditedTitle = vi.fn(),
    setEditedContent = vi.fn(),
    setSaving = vi.fn(),
    setSaveError = vi.fn(),
    setShowDiscardConfirmation = vi.fn(),
    setIncludeMetadata = vi.fn(),
    setPdfTheme = vi.fn(),
    setPdfFont = vi.fn(),
    setDraftRevision = vi.fn(),
}: {
    isViewMode?: boolean;
    editedTitle?: string;
    editedContent?: string;
    includeMetadata?: boolean;
    pdfTheme?: string;
    pdfFont?: string;
    saving?: boolean;
    saveError?: { message: string; canReloadLatest: boolean } | null;
    showDiscardConfirmation?: boolean;
    setIsViewMode?: ReturnType<typeof vi.fn>;
    setEditedTitle?: ReturnType<typeof vi.fn>;
    setEditedContent?: ReturnType<typeof vi.fn>;
    setSaving?: ReturnType<typeof vi.fn>;
    setSaveError?: ReturnType<typeof vi.fn>;
    setShowDiscardConfirmation?: ReturnType<typeof vi.fn>;
    setIncludeMetadata?: ReturnType<typeof vi.fn>;
    setPdfTheme?: ReturnType<typeof vi.fn>;
    setPdfFont?: ReturnType<typeof vi.fn>;
    setDraftRevision?: ReturnType<typeof vi.fn>;
} = {}): { slots: Record<PanelStateName, number> } {
    const slots = discoverPanelStateSlots();
    const stateBindings: Record<PanelStateName, [unknown, ReturnType<typeof vi.fn>]> = {
        isViewMode: [isViewMode, setIsViewMode],
        editedTitle: [editedTitle, setEditedTitle],
        editedContent: [editedContent, setEditedContent],
        saving: [saving, setSaving],
        saveError: [saveError, setSaveError],
        showDiscardConfirmation: [showDiscardConfirmation, setShowDiscardConfirmation],
        includeMetadata: [includeMetadata, setIncludeMetadata],
        pdfTheme: [pdfTheme, setPdfTheme],
        pdfFont: [pdfFont, setPdfFont],
        draftRevision: [0, setDraftRevision],
    };
    const nameBySlot = new Map<number, PanelStateName>(
        (Object.entries(slots) as Array<[PanelStateName, number]>)
            .map(([name, slot]) => [slot, name]),
    );

    vi.mocked(useState).mockReset();
    const maxSlot = Math.max(...nameBySlot.keys());
    let chained = vi.mocked(useState);
    for (let index = 0; index <= maxSlot; index += 1) {
        const name = nameBySlot.get(index);
        chained = name
            ? chained.mockImplementationOnce(() => stateBindings[name] as never)
            : chained.mockImplementationOnce(
                (initialValue?: unknown) => [resolveInitialValue(initialValue), vi.fn()] as never,
            );
    }
    // 特定対象外の新規stateが末尾へ増えても、初期値のまま素通しして落とさない。
    chained.mockImplementation(
        (initialValue?: unknown) => [resolveInitialValue(initialValue), vi.fn()] as never,
    );

    return { slots };
}

describe('DocumentDetailPanel', () => {
    const localStorageGetItem = vi.fn<(key: string) => string | null>(() => null);
    const localStorageSetItem = vi.fn();

    beforeEach(() => {
        createPortal.mockClear();
        printPdf.mockClear();
        vi.mocked(useState).mockReset();
        vi.mocked(useEffect).mockReset();
        vi.mocked(useRef).mockReset();
        vi.mocked(useRef).mockImplementation((initialValue: unknown) => {
            const createdRef = { current: initialValue };
            createdRefs.push(createdRef);
            createdRefInitials.push(initialValue);
            return createdRef as never;
        });
        vi.mocked(useImperativeHandle).mockReset();
        vi.mocked(useImperativeHandle).mockImplementation((
            forwardedRef: React.Ref<unknown> | undefined,
            createHandle: () => unknown,
        ) => {
            if (!forwardedRef) {
                return;
            }

            const handle = createHandle();
            if (typeof forwardedRef === 'function') {
                forwardedRef(handle);
            } else {
                forwardedRef.current = handle;
            }
        });
        createdRefs.length = 0;
        createdRefInitials.length = 0;
        localStorageGetItem.mockReset();
        localStorageGetItem.mockReturnValue(null);
        localStorageSetItem.mockReset();
        vi.stubGlobal('window', {
            document: { body: {} },
            localStorage: {
                getItem: localStorageGetItem,
                setItem: localStorageSetItem,
            },
            requestAnimationFrame: vi.fn(),
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
        expect(getText(tree)).not.toContain('標準を選択');
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
            '使用モデル: Gemini 3.7 Flash（標準を選択）',
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

    it('文書情報は既定 OFF で画面プレビューから省略し portal に渡す', () => {
        const { slots } = mockPanelState();

        const tree = DocumentDetailPanel({ document }) as React.ReactNode;
        const checkbox = findMetadataCheckbox(tree);
        const preview = findPdfPreview(tree);
        const portal = findPrintPortal(tree);

        expect(useState).toHaveBeenNthCalledWith(slots.includeMetadata + 1, false);
        expect(checkbox?.props.checked).toBe(false);
        expect(preview).not.toBeNull();
        expect(findPdfDocumentHeader(preview)).toBeNull();
        expect(portal?.props.includeMetadata).toBe(false);
    });

    it('文書情報を選択すると画面プレビューに表示し portal に true を渡す', () => {
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
        const previewHeader = findPdfDocumentHeader(findPdfPreview(selectedTree));

        expect(previewHeader).not.toBeNull();
        expect(previewHeader?.props.document).toBe(document);
        expect(findPrintPortal(selectedTree)?.props.includeMetadata).toBe(true);
    });

    it('PDF デザインは editorial を既定値として select と portal に渡す', () => {
        const { slots } = mockPanelState();

        const tree = DocumentDetailPanel({ document }) as React.ReactNode;
        const select = findPdfThemeSelect(tree);
        const portal = findPrintPortal(tree);

        expect(useState).toHaveBeenNthCalledWith(slots.pdfTheme + 1, 'editorial');
        expect(select).not.toBeNull();
        expect(select?.props.value).toBe('editorial');
        expect(findPdfPreview(tree)?.props.className).toBe(
            'pdf-preview pdf-preview--reading pdf-theme-editorial pdf-font-gothic shadow',
        );
        expect(portal?.props.theme).toBe('editorial');
    });

    it('PDF デザインを選択すると画面プレビューと portal に即時反映する', () => {
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
        expect(findPdfPreview(selectedTree)?.props.className).toBe(
            'pdf-preview pdf-preview--reading pdf-theme-minimal pdf-font-gothic shadow',
        );
        expect(findPrintPortal(selectedTree)?.props.theme).toBe('minimal');
    });

    it('PDF フォントは auto を既定とし、テーマ推奨へ解決して画面プレビューに反映する', () => {
        const { slots } = mockPanelState({ pdfTheme: 'architect' });

        const tree = DocumentDetailPanel({ document }) as React.ReactNode;
        const select = findPdfFontSelect(tree);
        const portal = findPrintPortal(tree);

        expect(useState).toHaveBeenNthCalledWith(slots.pdfFont + 1, 'auto');
        expect(select).not.toBeNull();
        expect(select?.props.value).toBe('auto');
        expect(findPdfPreview(tree)?.props.className).toBe(
            'pdf-preview pdf-preview--reading pdf-theme-architect pdf-font-zen shadow',
        );
        expect(portal?.props.font).toBe('auto');
    });

    it('PDF フォントを選択すると保存し、画面プレビューと portal に即時反映する', () => {
        const setPdfFont = vi.fn();
        mockPanelState({ setPdfFont });

        const initialTree = DocumentDetailPanel({ document }) as React.ReactNode;
        const select = findPdfFontSelect(initialTree);

        expect(select).not.toBeNull();
        select?.props.onChange({
            target: { value: 'mincho' },
        } as React.ChangeEvent<HTMLSelectElement>);

        expect(setPdfFont).toHaveBeenCalledWith('mincho');
        expect(localStorageSetItem).toHaveBeenCalledWith('pdfFont', 'mincho');

        vi.mocked(useState).mockReset();
        mockPanelState({ pdfFont: 'mincho' });

        const selectedTree = DocumentDetailPanel({ document }) as React.ReactNode;
        expect(findPdfPreview(selectedTree)?.props.className).toBe(
            'pdf-preview pdf-preview--reading pdf-theme-editorial pdf-font-mincho shadow',
        );
        expect(findPrintPortal(selectedTree)?.props.font).toBe('mincho');
    });

    it('不正な保存済み PDF フォントは auto にフォールバックする', () => {
        const setPdfFont = vi.fn();
        localStorageGetItem.mockImplementation(key => (
            key === 'pdfFont' ? 'unknown-font' : null
        ));
        mockPanelState({ setPdfFont });

        DocumentDetailPanel({ document });

        for (const [effect, dependencies] of vi.mocked(useEffect).mock.calls) {
            if (Array.isArray(dependencies) && dependencies.length === 0) {
                effect();
            }
        }

        expect(localStorageGetItem).toHaveBeenCalledWith('pdfFont');
        expect(setPdfFont).toHaveBeenCalledWith('auto');
    });

    it('画面プレビューの改ページ位置に関する注記を表示する', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({ document }) as React.ReactNode;

        expect(getText(tree)).toContain('※改ページ位置はPDF出力時のみ反映されます');
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
            onDocumentUpdate: async () => undefined,
        }) as React.ReactNode;
        const pdfButton = findPdfButton(tree);

        expect(pdfButton).not.toBeNull();
        expect(pdfButton?.props.disabled).toBe(true);
        expect(pdfButton?.props.title).toBe('保存完了後に印刷できます');

        pdfButton?.props.onClick();

        expect(printPdf).not.toHaveBeenCalled();
    });

    it('タイトルと本文を文書 ID 付きの一回の更新で保存する', async () => {
        const onDocumentUpdate = vi.fn(async (): Promise<void> => undefined);
        const onDirtyChange = vi.fn();
        const setIsViewMode = vi.fn();
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: '編集後のタイトル',
            editedContent: '編集後の本文',
            setIsViewMode,
            setEditedTitle,
            setEditedContent,
        });

        DocumentDetailPanel({
            document,
            onDocumentUpdate,
            onDirtyChange,
        }, panelRef);

        await expect(panelRef.current?.save()).resolves.toBe(true);
        expect(onDocumentUpdate).toHaveBeenCalledTimes(1);
        expect(onDocumentUpdate).toHaveBeenCalledWith('document-1', {
            title: '編集後のタイトル',
            text: '編集後の本文',
        }, { expectedUpdatedAt: null });
        expect(setEditedTitle).toHaveBeenCalledWith('編集後のタイトル');
        expect(setEditedContent).toHaveBeenCalledWith('編集後の本文');
        expect(setIsViewMode).toHaveBeenCalledWith(true);
        expect(onDirtyChange).toHaveBeenCalledWith(false);
    });

    it('保存中に選択 ID が変わった場合は新しい選択へドラフトを反映しない', async () => {
        let finishUpdate: (() => void) | undefined;
        const onDocumentUpdate = vi.fn(() => new Promise<void>(resolve => {
            finishUpdate = resolve;
        }));
        const setIsViewMode = vi.fn();
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        const onDirtyChange = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: '保存対象のタイトル',
            editedContent: '保存対象の本文',
            setIsViewMode,
            setEditedTitle,
            setEditedContent,
        });
        DocumentDetailPanel({
            document,
            onDocumentUpdate,
            onDirtyChange,
        }, panelRef);

        const savingResult = panelRef.current!.save();
        findSelectedDocumentIdRef().current = 'document-2';
        finishUpdate?.();

        await expect(savingResult).resolves.toBe(true);
        expect(onDocumentUpdate).toHaveBeenCalledWith('document-1', {
            title: '保存対象のタイトル',
            text: '保存対象の本文',
        }, { expectedUpdatedAt: null });
        expect(setEditedTitle).not.toHaveBeenCalled();
        expect(setEditedContent).not.toHaveBeenCalled();
        expect(setIsViewMode).not.toHaveBeenCalled();
        expect(onDirtyChange).not.toHaveBeenCalledWith(false);
    });

    it('保存失敗時はドラフトを保ち、画面内に失敗理由を表示する', async () => {
        const onDocumentUpdate = vi.fn(async (): Promise<void> => {
            throw new Error('network error');
        });
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        const setSaveError = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: '未保存タイトル',
            editedContent: '未保存本文',
            setEditedTitle,
            setEditedContent,
            setSaveError,
        });
        DocumentDetailPanel({ document, onDocumentUpdate }, panelRef);

        await expect(panelRef.current?.save()).resolves.toBe(false);
        expect(setEditedTitle).not.toHaveBeenCalled();
        expect(setEditedContent).not.toHaveBeenCalled();
        expect(setSaveError).toHaveBeenLastCalledWith({
            message: '保存に失敗しました。編集内容は保持されています。',
            canReloadLatest: false,
        });
    });

    it('上限超過の保存失敗はサイズ超過と対処を伝え、汎用文言で潰さない', async () => {
        const onDocumentUpdate = vi.fn(async (): Promise<void> => {
            throw new DocumentSizeLimitError(
                '文書のサイズが上限を超えています。（現在: 4.00KB / 上限: 1.00KB）',
            );
        });
        const setSaveError = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: '未保存タイトル',
            editedContent: '未保存本文',
            setSaveError,
        });
        DocumentDetailPanel({ document, onDocumentUpdate }, panelRef);

        await expect(panelRef.current?.save()).resolves.toBe(false);
        expect(setSaveError).toHaveBeenLastCalledWith({
            message: '文書のサイズが上限を超えています。（現在: 4.00KB / 上限: 1.00KB）'
                + ' 本文を短くしてから保存してください。',
            canReloadLatest: false,
        });
    });

    it('空のドラフトは保存せず dirty 状態を保持する', async () => {
        const onDocumentUpdate = vi.fn(async (): Promise<void> => undefined);
        const setSaveError = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: ' ',
            editedContent: '本文',
            setSaveError,
        });
        DocumentDetailPanel({ document, onDocumentUpdate }, panelRef);

        await expect(panelRef.current?.save()).resolves.toBe(false);
        expect(onDocumentUpdate).not.toHaveBeenCalled();
        expect(setSaveError).toHaveBeenCalledWith({
            message: 'タイトルと本文を入力してください。',
            canReloadLatest: false,
        });
    });

    it('保存競合は競合専用の文言で伝え、最新読込の導線を有効にする', async () => {
        const onDocumentUpdate = vi.fn(async (): Promise<void> => {
            throw new TranscriptionConflictError();
        });
        const setSaveError = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: '競合するタイトル',
            editedContent: '競合する本文',
            setSaveError,
        });
        DocumentDetailPanel({ document, onDocumentUpdate }, panelRef);

        await expect(panelRef.current?.save()).resolves.toBe(false);
        expect(setSaveError).toHaveBeenLastCalledWith({
            message: '他の場所で更新されています。内容を確認してから保存し直してください。',
            canReloadLatest: true,
        });
    });

    it('競合エラー表示は最新の内容を読み込むボタンを持ち、押すと親へ再取得を頼み表示モードへ戻る', () => {
        const onRequestLatestDocument = vi.fn();
        const setIsViewMode = vi.fn();
        const setSaveError = vi.fn();
        mockPanelState({
            isViewMode: false,
            saveError: {
                message: '他の場所で更新されています。内容を確認してから保存し直してください。',
                canReloadLatest: true,
            },
            setIsViewMode,
            setSaveError,
        });

        const tree = DocumentDetailPanel({
            document,
            onDocumentUpdate: async () => undefined,
            onRequestLatestDocument,
        }) as React.ReactNode;

        expect(getText(tree)).toContain(
            '他の場所で更新されています。内容を確認してから保存し直してください。',
        );
        const reloadButton = findButtonByText(tree, '最新の内容を読み込む');
        expect(reloadButton).not.toBeNull();

        reloadButton?.props.onClick();
        expect(onRequestLatestDocument).toHaveBeenCalledOnce();
        expect(setIsViewMode).toHaveBeenCalledWith(true);
        expect(setSaveError).toHaveBeenCalledWith(null);
    });

    it('最新の内容を読み込むはdirtyなdraftを保持したまま、期待値を採用版へ前進させる(手動マージの出口)', () => {
        const loadedUpdatedAt = new Date('2026-09-01T09:00:00.000Z');
        const propUpdatedAt = new Date('2026-09-01T09:00:30.000Z');
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        mockPanelState({
            isViewMode: false,
            editedTitle: document.title,
            editedContent: '手元でマージ中の本文',
            saveError: {
                message: '他の場所で更新されています。内容を確認してから保存し直してください。',
                canReloadLatest: true,
            },
            setEditedTitle,
            setEditedContent,
        });
        const tree = DocumentDetailPanel({
            document: { ...document, updatedAt: propUpdatedAt },
            onDocumentUpdate: async () => undefined,
            onRequestLatestDocument: vi.fn(),
        }) as React.ReactNode;
        const pinnedUpdatedAtRef = findDraftBaselineUpdatedAtRef(propUpdatedAt);
        pinnedUpdatedAtRef.current = loadedUpdatedAt;

        findButtonByText(tree, '最新の内容を読み込む')?.props.onClick();

        // 採用を明示した現行版が新しい期待値になる(これが無いとpinが凍結し、
        // 手動マージしても保存へ到達できない)。draft自体は書き換えない。
        expect(pinnedUpdatedAtRef.current).toBe(propUpdatedAt);
        expect(setEditedTitle).not.toHaveBeenCalled();
        expect(setEditedContent).not.toHaveBeenCalled();
    });

    it('最新読込の採用予約は、後着の受信版もdirtyな部分rebaseのまま一度だけ期待値に採る', () => {
        const loadedUpdatedAt = new Date('2026-09-01T09:00:00.000Z');
        const reloadedUpdatedAt = new Date('2026-09-01T09:01:00.000Z');
        mockPanelState({
            isViewMode: false,
            editedTitle: document.title,
            editedContent: '手元でマージ中の本文',
            saveError: {
                message: '他の場所で更新されています。内容を確認してから保存し直してください。',
                canReloadLatest: true,
            },
        });
        const tree = DocumentDetailPanel({
            document: {
                ...document,
                text: '再取得で届いた本文',
                updatedAt: reloadedUpdatedAt,
            },
            onDocumentUpdate: async () => undefined,
            onRequestLatestDocument: vi.fn(),
        }) as React.ReactNode;
        findDraftBaselineRef().current = {
            documentId: 'document-1',
            title: document.title,
            text: document.text,
        };
        const pinnedUpdatedAtRef = findDraftBaselineUpdatedAtRef(reloadedUpdatedAt);

        findButtonByText(tree, '最新の内容を読み込む')?.props.onClick();
        // 予約(フラグ)側の経路を単独で確かめるため、同期採用分を巻き戻す。
        pinnedUpdatedAtRef.current = loadedUpdatedAt;

        runDraftRebaseEffect();
        expect(pinnedUpdatedAtRef.current).toBe(reloadedUpdatedAt);

        // 予約は一度きり。以後のdirty部分rebaseは従来どおり期待値を据え置く。
        pinnedUpdatedAtRef.current = loadedUpdatedAt;
        runDraftRebaseEffect();
        expect(pinnedUpdatedAtRef.current).toBe(loadedUpdatedAt);
    });

    it('競合以外の保存エラー表示には最新読込ボタンを出さない', () => {
        mockPanelState({
            isViewMode: false,
            saveError: {
                message: '保存に失敗しました。編集内容は保持されています。',
                canReloadLatest: false,
            },
        });

        const tree = DocumentDetailPanel({
            document,
            onDocumentUpdate: async () => undefined,
            onRequestLatestDocument: vi.fn(),
        }) as React.ReactNode;

        expect(getText(tree)).toContain('保存に失敗しました。編集内容は保持されています。');
        expect(findButtonByText(tree, '最新の内容を読み込む')).toBeNull();
    });

    it('dirty 通知と命令的な破棄操作を親へ公開する', () => {
        const onDirtyChange = vi.fn();
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: '未保存タイトル',
            editedContent: document.text,
            setEditedTitle,
            setEditedContent,
        });
        DocumentDetailPanel({
            document,
            onDocumentUpdate: async () => undefined,
            onDirtyChange,
        }, panelRef);

        runDirtyNotifyEffect();
        expect(onDirtyChange).toHaveBeenCalledWith(true);
        expect(panelRef.current?.getDraft()).toEqual({
            title: '未保存タイトル',
            text: document.text,
        });

        panelRef.current?.discard();
        expect(setEditedTitle).toHaveBeenCalledWith(document.title);
        expect(setEditedContent).toHaveBeenCalledWith(document.text);
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    it('破棄は命令的handleでも確認ダイアログ経由でもonDraftDiscardedを同期で通知する', () => {
        const onDraftDiscarded = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: '未保存タイトル',
        });
        DocumentDetailPanel({
            document,
            onDocumentUpdate: async () => undefined,
            onDraftDiscarded,
        }, panelRef);

        panelRef.current?.discard();
        expect(onDraftDiscarded).toHaveBeenCalledTimes(1);

        vi.mocked(useState).mockReset();
        mockPanelState({
            isViewMode: false,
            editedTitle: '未保存タイトル',
            showDiscardConfirmation: true,
        });
        const confirmationTree = DocumentDetailPanel({
            document,
            onDocumentUpdate: async () => undefined,
            onDraftDiscarded,
        }) as React.ReactNode;

        findButtonByText(confirmationTree, '変更を破棄する')?.props.onClick();
        expect(onDraftDiscarded).toHaveBeenCalledTimes(2);
    });

    it('同じ ID の一覧再取得は dirty ドラフトを上書きしない', () => {
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        mockPanelState({
            isViewMode: false,
            editedTitle: '入力中のタイトル',
            editedContent: document.text,
            setEditedTitle,
            setEditedContent,
        });
        DocumentDetailPanel({
            document: { ...document, title: '一覧で更新されたタイトル' },
            onDocumentUpdate: async () => undefined,
        });
        findDraftBaselineRef().current = {
            documentId: 'document-1',
            title: document.title,
            text: document.text,
        };

        runDraftRebaseEffect();

        expect(setEditedTitle).not.toHaveBeenCalled();
        expect(setEditedContent).not.toHaveBeenCalled();
    });

    it('本文だけ編集中なら一覧で更新されたタイトルをドラフトへrebaseする', () => {
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        mockPanelState({
            isViewMode: false,
            editedTitle: document.title,
            editedContent: '入力中の本文',
            setEditedTitle,
            setEditedContent,
        });
        DocumentDetailPanel({
            document: { ...document, title: '一覧で更新されたタイトル' },
            onDocumentUpdate: async () => undefined,
        });
        findDraftBaselineRef().current = {
            documentId: 'document-1',
            title: document.title,
            text: document.text,
        };

        runDraftRebaseEffect();

        expect(setEditedTitle).toHaveBeenCalledWith('一覧で更新されたタイトル');
        expect(setEditedContent).not.toHaveBeenCalled();
        expect(findDraftBaselineRef().current).toEqual({
            documentId: 'document-1',
            title: '一覧で更新されたタイトル',
            text: document.text,
        });
    });

    it('タイトルだけ編集中なら外部更新された本文をドラフトへrebaseする', () => {
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        mockPanelState({
            isViewMode: false,
            editedTitle: '入力中のタイトル',
            editedContent: document.text,
            setEditedTitle,
            setEditedContent,
        });
        DocumentDetailPanel({
            document: { ...document, text: '外部更新された本文' },
            onDocumentUpdate: async () => undefined,
        });
        findDraftBaselineRef().current = {
            documentId: 'document-1',
            title: document.title,
            text: document.text,
        };

        runDraftRebaseEffect();

        expect(setEditedTitle).not.toHaveBeenCalled();
        expect(setEditedContent).toHaveBeenCalledWith('外部更新された本文');
        expect(findDraftBaselineRef().current).toEqual({
            documentId: 'document-1',
            title: document.title,
            text: '外部更新された本文',
        });
    });

    it('外部更新がdirtyドラフトへ追いついた場合はdirty判定を再計算する', () => {
        const setDraftRevision = vi.fn();
        mockPanelState({
            isViewMode: false,
            editedTitle: '外部更新と一致するタイトル',
            editedContent: document.text,
            setDraftRevision,
        });
        DocumentDetailPanel({
            document: { ...document, title: '外部更新と一致するタイトル' },
            onDocumentUpdate: async () => undefined,
        });
        findDraftBaselineRef().current = {
            documentId: 'document-1',
            title: document.title,
            text: document.text,
        };

        runDraftRebaseEffect();

        expect(findDraftBaselineRef().current).toEqual({
            documentId: 'document-1',
            title: '外部更新と一致するタイトル',
            text: document.text,
        });
        expect(setDraftRevision).toHaveBeenCalledOnce();
        const updateRevision = setDraftRevision.mock.calls[0][0] as (revision: number) => number;
        expect(updateRevision(4)).toBe(5);
    });

    it('dirty中にポーリングでupdatedAtが前進しても、保存のexpectedUpdatedAtはロード時の版のまま渡す', async () => {
        const loadedUpdatedAt = new Date('2026-09-01T09:00:00.000Z');
        const polledUpdatedAt = new Date('2026-09-01T09:00:30.000Z');
        const onDocumentUpdate = vi.fn(async (): Promise<void> => undefined);
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: document.title,
            editedContent: '入力中の本文',
        });
        // ポーリング済みの一覧が本文とupdatedAtの両方を前進させた状態のprops。
        DocumentDetailPanel({
            document: {
                ...document,
                text: '外部更新された本文',
                updatedAt: polledUpdatedAt,
            },
            onDocumentUpdate,
        }, panelRef);
        findDraftBaselineRef().current = {
            documentId: 'document-1',
            title: document.title,
            text: document.text,
        };
        const pinnedUpdatedAtRef = findDraftBaselineUpdatedAtRef(polledUpdatedAt);
        pinnedUpdatedAtRef.current = loadedUpdatedAt;

        runDraftRebaseEffect();

        // 本文dirtyの部分rebaseでは期待値を前進させない（前進させると
        // 他者の更新を競合検査素通りで上書きできてしまう＝F4の自己無効化）。
        expect(pinnedUpdatedAtRef.current).toBe(loadedUpdatedAt);

        await expect(panelRef.current?.save()).resolves.toBe(true);
        expect(onDocumentUpdate).toHaveBeenCalledWith('document-1', {
            title: document.title,
            text: '入力中の本文',
        }, { expectedUpdatedAt: loadedUpdatedAt });
    });

    it('破棄はpropsの現行版をdraftとして採用するので、expectedUpdatedAtも同じ版へ前進させる', () => {
        const loadedUpdatedAt = new Date('2026-09-01T09:00:00.000Z');
        const polledUpdatedAt = new Date('2026-09-01T09:00:30.000Z');
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState({
            isViewMode: false,
            editedTitle: document.title,
            editedContent: '入力中の本文',
        });
        DocumentDetailPanel({
            document: {
                ...document,
                text: '外部更新された本文',
                updatedAt: polledUpdatedAt,
            },
            onDocumentUpdate: async () => undefined,
        }, panelRef);
        const pinnedUpdatedAtRef = findDraftBaselineUpdatedAtRef(polledUpdatedAt);
        pinnedUpdatedAtRef.current = loadedUpdatedAt;

        panelRef.current?.discard();

        // 破棄後のdraftはpropsの現行版(V2)の内容そのもの。pinをV1に残すと
        // 以後の保存が常に偽競合して文書切替まで保存不能になる。
        expect(pinnedUpdatedAtRef.current).toBe(polledUpdatedAt);
    });

    it('cleanなドラフトの一覧同期では expectedUpdatedAt も受信版へ前進させる', () => {
        const loadedUpdatedAt = new Date('2026-09-01T09:00:00.000Z');
        const polledUpdatedAt = new Date('2026-09-01T09:00:30.000Z');
        mockPanelState({
            editedTitle: document.title,
            editedContent: document.text,
        });
        DocumentDetailPanel({
            document: {
                ...document,
                title: '一覧で更新されたタイトル',
                text: '一覧で更新された本文',
                updatedAt: polledUpdatedAt,
            },
            onDocumentUpdate: async () => undefined,
        });
        findDraftBaselineRef().current = {
            documentId: 'document-1',
            title: document.title,
            text: document.text,
        };
        const pinnedUpdatedAtRef = findDraftBaselineUpdatedAtRef(polledUpdatedAt);
        pinnedUpdatedAtRef.current = loadedUpdatedAt;

        runDraftRebaseEffect();

        expect(pinnedUpdatedAtRef.current).toBe(polledUpdatedAt);
    });

    it('同じ ID の一覧再取得は clean なドラフトへ同期する', () => {
        const setEditedTitle = vi.fn();
        const setEditedContent = vi.fn();
        mockPanelState({
            editedTitle: document.title,
            editedContent: document.text,
            setEditedTitle,
            setEditedContent,
        });
        DocumentDetailPanel({
            document: {
                ...document,
                title: '一覧で更新されたタイトル',
                text: '一覧で更新された本文',
            },
            onDocumentUpdate: async () => undefined,
        });
        findDraftBaselineRef().current = {
            documentId: 'document-1',
            title: document.title,
            text: document.text,
        };

        runDraftRebaseEffect();

        expect(setEditedTitle).toHaveBeenCalledWith('一覧で更新されたタイトル');
        expect(setEditedContent).toHaveBeenCalledWith('一覧で更新された本文');
    });

    it('モバイル向けの戻る操作と詳細フォーカス契約を提供する', () => {
        const onBackToList = vi.fn();
        const focus = vi.fn();
        const panelRef = {
            current: null as DocumentDetailPanelHandle | null,
        };
        mockPanelState();
        const tree = DocumentDetailPanel({ document, onBackToList }, panelRef);
        const backButton = findButtonByText(tree, '一覧へ戻る');
        getRootElementRef(tree).current = { focus };

        expect(backButton?.props.className).toContain('lg:hidden');
        backButton?.props.onClick();
        expect(onBackToList).toHaveBeenCalledOnce();

        panelRef.current?.focus();
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    it('PDF 操作の実態と文書情報の列挙を正確に案内する', () => {
        mockPanelState();

        const tree = DocumentDetailPanel({ document });

        expect(getText(tree)).toContain('印刷してPDF保存');
        expect(getText(tree)).toContain(
            '文書情報を含める（元ファイル・プロンプト・生成日時・使用モデル・思考）',
        );
        expect(findPdfPreview(tree)?.props.className).toContain(
            'pdf-preview--reading',
        );
    });

    it('dirty な編集のキャンセルは画面内確認を開く', () => {
        const setShowDiscardConfirmation = vi.fn();
        mockPanelState({
            isViewMode: false,
            editedTitle: '未保存タイトル',
            setShowDiscardConfirmation,
        });
        const tree = DocumentDetailPanel({
            document,
            onDocumentUpdate: async () => undefined,
        });

        findButtonByText(tree, 'キャンセル')?.props.onClick();

        expect(setShowDiscardConfirmation).toHaveBeenCalledWith(true);
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

        expect(portal.props.className).toBe(
            'pdf-print-root pdf-theme-minimal pdf-font-gothic',
        );
    });

    it('明示フォント指定はテーマ推奨より優先してルート class に反映する', async () => {
        const { DocumentPrintPortal: ActualDocumentPrintPortal } =
            await vi.importActual<typeof import('./DocumentPrintPortal')>(
                './DocumentPrintPortal',
            );

        const portal = ActualDocumentPrintPortal({
            document,
            active: true,
            includeMetadata: false,
            theme: 'minimal',
            font: 'mincho',
        }) as unknown as React.ReactElement<{ className: string }>;

        expect(portal.props.className).toBe(
            'pdf-print-root pdf-theme-minimal pdf-font-mincho',
        );
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

        expect(portal.props.className).toBe(
            'pdf-print-root pdf-theme-editorial pdf-font-gothic',
        );
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
        const header = findPdfDocumentHeader(portal);

        expect(header).not.toBeNull();
        expect(getText(PdfDocumentHeader(header!.props))).toContain(
            '使用モデルGemini 3.7 Flash（標準を選択）・思考: 標準',
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
        const header = findPdfDocumentHeader(portal);

        expect(header).not.toBeNull();
        expect(getText(PdfDocumentHeader(header!.props))).toContain(
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
        const header = findPdfDocumentHeader(portal);

        expect(header).not.toBeNull();
        expect(getText(PdfDocumentHeader(header!.props))).not.toContain('思考:');
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

        expect(findPdfDocumentHeader(portal)).toBeNull();
    });
});

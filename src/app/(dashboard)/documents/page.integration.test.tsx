// @vitest-environment jsdom

// 実DocumentDetailPanel(pin/rebase/保存を本物)でpage結線を貫通検証する統合テスト。
// page.test.tsxのモックパネルは独自pinを持つため、page merge×panel pin×pollの
// 三者を跨ぐ版汚染(C1)はここでしか検出できない。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcription } from '@/lib/firestore';
import DocumentsPage from './page';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type ListSidebarProps = {
  onDocumentClick: (document: Transcription) => void;
  onDocumentUpdated?: (documentId: string, patch: { title: string }) => void;
  onDocumentsChange?: (documents: Transcription[]) => void;
  onListStateChange?: (state: { status: string; count?: number }) => void;
};

const loadedVersion = new Date('2026-09-02T09:00:00.000Z');
const interleavedVersion = new Date('2026-09-02T09:00:45.000Z');

const documentV1: Transcription = {
  id: 'document-1',
  title: '統合テスト文書',
  fileName: 'integration.mp4',
  text: 'ロード時の本文',
  promptName: '議事録',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: loadedVersion,
};

const mocks = vi.hoisted(() => ({
  updateTranscription: vi.fn(),
  restoreTranscription: vi.fn(),
}));

let latestSidebarProps: ListSidebarProps | null = null;

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/documents',
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ loading: false, user: { uid: 'owner-1' } }),
}));

vi.mock('@/components/DocumentListSidebar', () => ({
  DocumentListSidebar: (props: ListSidebarProps) => {
    latestSidebarProps = props;
    return <aside data-testid="list-sidebar" />;
  },
}));

// パネルの描画専用の葉だけを差し替える。pin/rebase/保存ロジックは実物のまま。
vi.mock('@/components/MarkdownDocument', () => ({
  MarkdownDocument: () => null,
}));
vi.mock('@/components/DocumentPrintPortal', () => ({
  DocumentPrintPortal: () => null,
}));
vi.mock('@/hooks/useDocumentPrint', () => ({
  useDocumentPrint: () => ({ printPdf: vi.fn(), isPreparing: false }),
}));
vi.mock('@/lib/pdfExport', () => ({
  formatPdfDateTime: () => '',
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}));

// firestore.tsの実クラス(エラー型)を使うため、SDK初期化だけを差し替える。
vi.mock('@/lib/firebase', () => ({
  db: { name: 'mock-firestore' },
  auth: { currentUser: null },
  storage: { name: 'mock-storage' },
}));

vi.mock('@/lib/firestore', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/firestore')>();
  return {
    ...actual,
    updateTranscription: mocks.updateTranscription,
    restoreTranscription: mocks.restoreTranscription,
  };
});

function publishDocuments(documents: Transcription[]): void {
  latestSidebarProps?.onDocumentsChange?.(documents);
  latestSidebarProps?.onListStateChange?.({ status: 'success', count: documents.length });
}

function getButtonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(element => element.textContent?.trim() === label);
  if (!button) throw new Error(`${label} ボタンがありません`);
  return button;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function waitForPopStates(count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener('popstate', handlePopState);
      reject(new Error(`popstateが${count}回発火しませんでした`));
    }, 1000);
    const handlePopState = (): void => {
      seen += 1;
      if (seen < count) return;
      window.clearTimeout(timeoutId);
      window.removeEventListener('popstate', handlePopState);
      resolve();
    };
    window.addEventListener('popstate', handlePopState);
  });
}

async function editBodyAndSave(container: HTMLElement, nextBody: string): Promise<void> {
  await act(async () => {
    getButtonByText(container, '編集').click();
  });
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('編集textareaがありません');
  await act(async () => {
    setTextareaValue(textarea, nextBody);
  });
  // 保存成功でdirtyが解けるとguard effectがsentinelを片付ける(back→popstate)。
  // これを待たずに次の編集へ進むと、片付けのpopstateを新しいguardが誤って
  // 離脱要求として保留してしまう。
  const sentinelCleanup = waitForPopStates(1);
  await act(async () => {
    getButtonByText(container, '保存').click();
    await Promise.resolve();
  });
  await act(async () => {
    await sentinelCleanup;
  });
}

describe('DocumentsPage × 実DocumentDetailPanel 統合', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    latestSidebarProps = null;
    mocks.updateTranscription.mockReset();
    mocks.restoreTranscription.mockReset();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    });
    window.history.replaceState(null, '', '/history-origin');
    window.history.pushState(null, '', '/documents');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('readBackがnull(割り込み検出)の保存後、pollが格納した他者版をpinせず、次の保存を他者版への無警告上書きにしない', async () => {
    // A保存のcommitと読み戻しの間にBがV3を書き、pollがV3(B本文+B版印)を先に
    // 一覧へ格納してからreadBack不一致(null)が返る——C1の再現順序。
    mocks.updateTranscription.mockImplementationOnce(async () => {
      publishDocuments([{
        ...documentV1,
        title: 'Bのタイトル',
        text: 'Bの本文',
        updatedAt: interleavedVersion,
      }]);
      return null;
    });
    mocks.updateTranscription.mockResolvedValue(null);

    await act(async () => {
      root.render(<DocumentsPage />);
    });
    await act(async () => {
      publishDocuments([documentV1]);
    });
    await act(async () => {
      latestSidebarProps?.onDocumentClick(documentV1);
    });

    await editBodyAndSave(container, 'Aの編集本文');

    expect(mocks.updateTranscription).toHaveBeenNthCalledWith(1, 'document-1', {
      title: '統合テスト文書',
      transcription: 'Aの編集本文',
    }, { expectedUpdatedAt: loadedVersion });

    await editBodyAndSave(container, 'Aの二回目の本文');

    const secondMeta = mocks.updateTranscription.mock.calls[1][2] as {
      expectedUpdatedAt: unknown;
    };
    // 捏造ペア(A本文+B版印)でpinがV3へ前進すると、ここがV3になり
    // 次の保存がBの更新を競合検査素通りで上書きする。
    expect(secondMeta.expectedUpdatedAt).not.toBe(interleavedVersion);
    expect(secondMeta.expectedUpdatedAt).toBeNull();

    // 保存は通ったが自分の版を確定できなかったことをユーザーへ提示する。
    expect(container.textContent)
      .toContain('保存は完了しましたが、他の場所で更新された可能性があります');
  });

  it('改名通知(onDocumentUpdated)は一覧entryの版印を温存せず、次の保存を他者版への無警告上書きにしない', async () => {
    mocks.updateTranscription.mockResolvedValue(null);

    await act(async () => {
      root.render(<DocumentsPage />);
    });
    await act(async () => {
      publishDocuments([documentV1]);
    });
    await act(async () => {
      latestSidebarProps?.onDocumentClick(documentV1);
    });
    // pollが他者B版(V3)を格納し、cleanなパネルはそれを正当に採用する。
    await act(async () => {
      publishDocuments([{
        ...documentV1,
        title: 'Bのタイトル',
        text: 'Bの本文',
        updatedAt: interleavedVersion,
      }]);
    });
    // 遅れて届いた改名continuationの親通知が、V3行へ自分のタイトルだけを被せる。
    // 版印を温存すると「自分のタイトル+他者V3」の捏造ペアがpanelにpinされる。
    await act(async () => {
      latestSidebarProps?.onDocumentUpdated?.('document-1', { title: '改名後のタイトル' });
    });

    await editBodyAndSave(container, '改名後に続けた編集本文');

    const savedMeta = mocks.updateTranscription.mock.calls[0][2] as {
      expectedUpdatedAt: unknown;
    };
    expect(savedMeta.expectedUpdatedAt).not.toBe(interleavedVersion);
    expect(savedMeta.expectedUpdatedAt).toBeNull();
  });

  it('最新読込の採用予約は同意した版に紐づき、後着の未確認版(V3)を自動採用しない', async () => {
    const v2 = new Date('2026-09-02T09:00:45.000Z');
    const v3 = new Date('2026-09-02T09:01:30.000Z');
    const conflictError = await import('@/lib/firestore')
      .then(module => new module.TranscriptionConflictError());
    mocks.updateTranscription
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValue(null);

    await act(async () => {
      root.render(<DocumentsPage />);
    });
    await act(async () => {
      publishDocuments([documentV1]);
    });
    await act(async () => {
      latestSidebarProps?.onDocumentClick(documentV1);
    });

    // draft1保存→競合。pollがBのv2を格納(dirtyのため部分rebase・pinはv1のまま)。
    await act(async () => {
      getButtonByText(container, '編集').click();
    });
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('編集textareaがありません');
    await act(async () => {
      setTextareaValue(textarea, 'Aのdraft1本文');
    });
    await act(async () => {
      getButtonByText(container, '保存').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('他の場所で更新されています');
    await act(async () => {
      publishDocuments([{
        ...documentV1,
        title: 'Bのタイトル',
        text: 'Bのv2本文',
        updatedAt: v2,
      }]);
    });

    // 利用者が「最新の内容を読み込む」=v2の採用を明示。
    await act(async () => {
      getButtonByText(container, '最新の内容を読み込む').click();
    });

    // 利用者が一度も見ていないCのv3が後着しても、予約(v2)と一致しないので採用しない。
    await act(async () => {
      publishDocuments([{
        ...documentV1,
        title: 'Cのタイトル',
        text: 'Cのv3本文',
        updatedAt: v3,
      }]);
    });

    const saveSentinelCleanup = waitForPopStates(1);
    await act(async () => {
      getButtonByText(container, '編集').click();
    });
    await act(async () => {
      getButtonByText(container, '保存').click();
      await Promise.resolve();
    });
    await act(async () => {
      await saveSentinelCleanup;
    });

    const finalMeta = mocks.updateTranscription.mock.calls[1][2] as {
      expectedUpdatedAt: unknown;
    };
    expect(finalMeta.expectedUpdatedAt).not.toBe(v3);
    expect(finalMeta.expectedUpdatedAt).toBe(v2);
  });

  it('競合→最新読込→破棄→再編集の新draftは、後着のv3を無断で期待値に採らない', async () => {
    // 批評probe(scratchpad/probe.m2.test.tsx)のシナリオ: 予約が破棄を生き延びて
    // 破棄後の新draftで未確認版を採ると、v3を無警告上書きできてしまう。
    const v2 = new Date('2026-09-02T09:00:45.000Z');
    const v3 = new Date('2026-09-02T09:01:30.000Z');
    const conflictError = await import('@/lib/firestore')
      .then(module => new module.TranscriptionConflictError());
    mocks.updateTranscription
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValue(null);

    await act(async () => {
      root.render(<DocumentsPage />);
    });
    await act(async () => {
      publishDocuments([documentV1]);
    });
    await act(async () => {
      latestSidebarProps?.onDocumentClick(documentV1);
    });

    await act(async () => {
      getButtonByText(container, '編集').click();
    });
    const textarea1 = container.querySelector('textarea');
    if (!textarea1) throw new Error('編集textareaがありません');
    await act(async () => {
      setTextareaValue(textarea1, 'Aのdraft1本文');
    });
    await act(async () => {
      getButtonByText(container, '保存').click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('他の場所で更新されています');

    await act(async () => {
      publishDocuments([{
        ...documentV1,
        title: 'Bのタイトル',
        text: 'Bのv2本文',
        updatedAt: v2,
      }]);
    });
    await act(async () => {
      getButtonByText(container, '最新の内容を読み込む').click();
    });

    // draft1を破棄(dirty解除でguard片付けのpopstateを待つ)。
    const sentinelCleanup1 = waitForPopStates(1);
    await act(async () => {
      getButtonByText(container, '表示').click();
    });
    await act(async () => {
      getButtonByText(container, '変更を破棄する').click();
    });
    await act(async () => {
      await sentinelCleanup1;
    });

    // v2土台で新しいdraft2を作り、未確認のv3が後着してから保存する。
    await act(async () => {
      getButtonByText(container, '編集').click();
    });
    const textarea2 = container.querySelector('textarea');
    if (!textarea2) throw new Error('再編集textareaがありません');
    await act(async () => {
      setTextareaValue(textarea2, 'Aのdraft2本文');
    });
    await act(async () => {
      publishDocuments([{
        ...documentV1,
        title: 'Cのタイトル',
        text: 'Cのv3本文',
        updatedAt: v3,
      }]);
    });

    const sentinelCleanup2 = waitForPopStates(1);
    await act(async () => {
      getButtonByText(container, '保存').click();
      await Promise.resolve();
    });
    await act(async () => {
      await sentinelCleanup2;
    });

    const finalMeta = mocks.updateTranscription.mock.calls[1][2] as {
      expectedUpdatedAt: unknown;
    };
    // 正: 破棄時点の土台v2(サーバがv3ならサーバ側で競合として止まる)。
    expect(finalMeta.expectedUpdatedAt).not.toBe(v3);
    expect(finalMeta.expectedUpdatedAt).toBe(v2);
  });

  it('readBackが版を確定できた保存は、返ったupdatedAtが実パネルのpinへ前進し次の保存の期待値になる', async () => {
    const certifiedVersion = new Date('2026-09-02T09:01:00.000Z');
    mocks.updateTranscription
      .mockResolvedValueOnce(certifiedVersion)
      .mockResolvedValue(null);

    await act(async () => {
      root.render(<DocumentsPage />);
    });
    await act(async () => {
      publishDocuments([documentV1]);
    });
    await act(async () => {
      latestSidebarProps?.onDocumentClick(documentV1);
    });

    await editBodyAndSave(container, 'Aの編集本文');
    expect(container.textContent)
      .not.toContain('保存は完了しましたが、他の場所で更新された可能性があります');
    await editBodyAndSave(container, 'Aの二回目の本文');

    const secondMeta = mocks.updateTranscription.mock.calls[1][2] as {
      expectedUpdatedAt: unknown;
    };
    expect(secondMeta.expectedUpdatedAt).toBe(certifiedVersion);
  });
});

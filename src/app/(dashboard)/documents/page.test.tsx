// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcription } from '@/lib/firestore';
import DocumentsPage from './page';

// jsdomはshowModal/closeを実装していないため、共通Dialogを使う画面のテストは
// 他モーダルテストと同じ最小polyfillを当てる。
const originalShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal',
);
const originalDialogClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'close',
);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type ListState = {
  status: 'loading' | 'success' | 'error';
  count?: number;
};

type ListSidebarProps = {
  onDocumentClick: (document: Transcription) => void;
  onDocumentUpdated?: (documentId: string, patch: Pick<Transcription, 'title'>) => void;
  onDocumentDeleted?: (documentId: string) => void;
  onDocumentsChange?: (documents: Transcription[]) => void;
  onListStateChange?: (state: ListState) => void;
  selectedDocumentId?: string | null;
  isSelectedDocumentDirty?: boolean;
  updateTrigger?: number;
};

type DetailPanelUpdateMeta = {
  expectedUpdatedAt: Transcription['updatedAt'] | null;
};

type DetailPanelProps = {
  document: Transcription | null;
  onDocumentUpdate?: (
    documentId: string,
    patch: { title: string; text: string },
    meta: DetailPanelUpdateMeta,
  ) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onDraftDiscarded?: () => void;
  onRequestLatestDocument?: () => void;
};

type MountedPage = {
  container: HTMLDivElement;
  root: Root;
};

const firstDocument: Transcription = {
  id: 'document-1',
  title: '最初の文書',
  fileName: 'first.mp4',
  text: '最初の本文',
  promptName: '議事録',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
};

const secondDocument: Transcription = {
  ...firstDocument,
  id: 'document-2',
  title: '次の文書',
  fileName: 'second.mp4',
  text: '次の本文',
};

// G1転送錠用の版マーカー。ロード時pinとライブ値を必ず異なる固有値にして、
// pageがライブなdocuments[]由来の値へすり替えたら逐語一致で検出できるようにする。
const loadedVersionMarker = new Date('2026-09-01T11:00:00.000Z');
const polledVersionMarker = new Date('2026-09-01T11:00:30.000Z');

const mocks = vi.hoisted(() => ({
  pathname: '/documents',
  authState: {
    loading: false,
    user: { uid: 'owner-1' } as { uid: string } | null,
  },
  confirm: vi.fn(),
  detailDiscard: vi.fn(),
  detailDraft: {
    title: '未保存タイトル',
    text: '未保存本文',
  },
  detailFocus: vi.fn(),
  detailSave: vi.fn(),
  headerNavigation: vi.fn(),
  restoreTranscription: vi.fn(),
  updateTranscription: vi.fn(),
}));

let latestListSidebarProps: ListSidebarProps | null = null;
let latestDetailPanelProps: DetailPanelProps | null = null;

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
  usePathname: () => mocks.pathname,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mocks.authState,
}));

vi.mock('@/components/DocumentListSidebar', () => ({
  DocumentListSidebar: (props: ListSidebarProps) => {
    latestListSidebarProps = props;

    const publishDocuments = (documents: Transcription[]): void => {
      props.onDocumentsChange?.(documents);
      props.onListStateChange?.({ status: 'success', count: documents.length });
    };

    return (
      <aside data-testid="list-sidebar">
        <output data-testid="selected-document-id">
          {props.selectedDocumentId ?? ''}
        </output>
        <output data-testid="selected-document-dirty">
          {String(props.isSelectedDocumentDirty ?? false)}
        </output>
        <output data-testid="update-trigger">{props.updateTrigger ?? 0}</output>
        <button
          type="button"
          data-testid="load-documents"
          onClick={() => publishDocuments([firstDocument, secondDocument])}
        >
          一覧を取得
        </button>
        <button
          type="button"
          data-testid="refresh-without-selected"
          onClick={() => publishDocuments([secondDocument])}
        >
          選択文書なしで更新
        </button>
        <button
          type="button"
          data-testid="load-documents-with-versions"
          onClick={() => publishDocuments([
            { ...firstDocument, updatedAt: loadedVersionMarker },
            secondDocument,
          ])}
        >
          版付きで取得
        </button>
        <button
          type="button"
          data-testid="advance-first-updated-at"
          onClick={() => publishDocuments([
            { ...firstDocument, updatedAt: polledVersionMarker },
            secondDocument,
          ])}
        >
          最初の文書の版を前進
        </button>
        <button
          type="button"
          data-testid="refresh-empty"
          onClick={() => publishDocuments([])}
        >
          空で更新
        </button>
        <button
          type="button"
          data-testid="select-first"
          onClick={() => props.onDocumentClick(firstDocument)}
        >
          最初の文書
        </button>
        <button
          type="button"
          data-testid="select-second"
          onClick={() => props.onDocumentClick(secondDocument)}
        >
          次の文書
        </button>
        <button
          type="button"
          data-testid="rename-first"
          onClick={() => props.onDocumentUpdated?.(firstDocument.id!, { title: '改名後' })}
        >
          最初の文書を改名
        </button>
        <button
          type="button"
          data-testid="delete-first"
          onClick={() => props.onDocumentDeleted?.(firstDocument.id!)}
        >
          最初の文書を削除
        </button>
        <a data-testid="internal-navigation" href="/home">ホームへ移動</a>
        <header>
          <nav>
            <button
              type="button"
              data-testid="header-navigation"
              onClick={() => mocks.headerNavigation()}
            >
              ヘッダーナビ
            </button>
          </nav>
        </header>
      </aside>
    );
  },
}));

vi.mock('@/components/DocumentDetailPanel', async () => {
  const ReactModule = await import('react');

  return {
    DocumentDetailPanel: ReactModule.forwardRef(function MockDocumentDetailPanel(
      props: DetailPanelProps,
      ref: React.ForwardedRef<{
        save: () => Promise<boolean>;
        discard: () => void;
        getDraft: () => { title: string; text: string };
        focus: () => void;
      }>,
    ) {
      latestDetailPanelProps = props;
      const propsRef = ReactModule.useRef(props);
      propsRef.current = props;

      // 実パネル相当のpin: 文書をロードした時点のupdatedAtを固定し、以後の
      // ポーリング(props.document.updatedAtの前進)には追随しない。保存成功後
      // だけ、pageがpatchした最新版へ前進させる。ライブ値から都度導出すると
      // page転送の欠陥(ライブ値へのすり替え)をこのモックが覆い隠してしまう。
      const pinnedVersionRef = ReactModule.useRef<{
        documentId: string | null;
        updatedAt: Transcription['updatedAt'] | null;
      }>({ documentId: null, updatedAt: null });
      if ((props.document?.id ?? null) !== pinnedVersionRef.current.documentId) {
        pinnedVersionRef.current = {
          documentId: props.document?.id ?? null,
          updatedAt: props.document?.updatedAt ?? null,
        };
      }

      // 保存成功後のpin前進は、実パネル(rebase effect)と同じくcommit後のeffectで
      // 行う。保存continuation内のpropsRefはまだ旧propsを指しているため。
      const pinAdvancePendingRef = ReactModule.useRef(false);
      ReactModule.useEffect(() => {
        if (!pinAdvancePendingRef.current) return;
        if ((props.document?.id ?? null) !== pinnedVersionRef.current.documentId) return;
        pinAdvancePendingRef.current = false;
        pinnedVersionRef.current = {
          documentId: props.document?.id ?? null,
          updatedAt: props.document?.updatedAt ?? null,
        };
      });

      const submitDocumentUpdate = async (
        patch: { title: string; text: string },
      ): Promise<void> => {
        const currentDocument = propsRef.current.document;
        if (!currentDocument?.id) return;
        await propsRef.current.onDocumentUpdate?.(currentDocument.id, patch, {
          expectedUpdatedAt: pinnedVersionRef.current.updatedAt,
        });
        pinAdvancePendingRef.current = true;
      };

      ReactModule.useImperativeHandle(ref, () => ({
        save: async () => {
          const saved = await mocks.detailSave();
          if (!saved) return false;

          const currentProps = propsRef.current;
          const currentDocument = currentProps.document;
          try {
            if (currentDocument?.id) {
              await submitDocumentUpdate({
                title: `${currentDocument.title}（編集済み）`,
                text: `${currentDocument.text}（編集済み）`,
              });
            }
          } catch {
            return false;
          }
          currentProps.onDirtyChange?.(false);
          return true;
        },
        discard: () => {
          mocks.detailDiscard();
          propsRef.current.onDirtyChange?.(false);
          // 実パネルのdiscardDraftはdirty解除と同時にonDraftDiscardedも発火する。
          propsRef.current.onDraftDiscarded?.();
        },
        getDraft: () => ({ ...mocks.detailDraft }),
        focus: () => mocks.detailFocus(),
      }), []);

      return (
        <section
          data-testid="detail-panel"
          data-document-id={props.document?.id ?? ''}
          data-document-title={props.document?.title ?? ''}
          data-document-text={props.document?.text ?? ''}
        >
          <button
            type="button"
            data-testid="mark-dirty"
            onClick={() => props.onDirtyChange?.(true)}
          >
            編集する
          </button>
          <button
            type="button"
            data-testid="mark-clean"
            onClick={() => props.onDirtyChange?.(false)}
          >
            編集を終える
          </button>
          <button
            type="button"
            data-testid="discard-from-panel"
            onClick={() => {
              mocks.detailDiscard();
              props.onDirtyChange?.(false);
              props.onDraftDiscarded?.();
            }}
          >
            パネル内で破棄
          </button>
          <button
            type="button"
            data-testid="request-latest"
            onClick={() => props.onRequestLatestDocument?.()}
          >
            最新を読み込む
          </button>
          <button
            type="button"
            data-testid="save-new-body"
            onClick={() => {
              if (!props.document?.id) return;
              void submitDocumentUpdate({
                title: props.document.title,
                text: '本文編集後',
              }).then(() => props.onDirtyChange?.(false));
            }}
          >
            編集本文を保存
          </button>
          <button
            type="button"
            data-testid="save-current-document"
            onClick={() => {
              if (!props.document?.id) return;
              void submitDocumentUpdate({
                title: props.document.title,
                text: props.document.text,
              }).then(() => props.onDirtyChange?.(false));
            }}
          >
            現在の親文書を再保存
          </button>
        </section>
      );
    }),
  };
});

vi.mock('@/lib/firestore', () => ({
  restoreTranscription: mocks.restoreTranscription,
  updateTranscription: mocks.updateTranscription,
}));

const mountedPages = new Set<MountedPage>();

function getByTestId(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`data-testid=${testId} の要素がありません`);
  return element;
}

function getButtonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(element => element.textContent?.trim() === label);
  if (!button) throw new Error(`${label} ボタンがありません`);
  return button;
}

async function mountPage(): Promise<MountedPage> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedPages.add(mounted);

  await act(async () => {
    root.render(<DocumentsPage />);
  });
  return mounted;
}

async function unmountPage(mounted: MountedPage): Promise<void> {
  if (!mountedPages.delete(mounted)) return;
  const marker = window.history.state?.__documentsUnsavedChangesGuard as
    | { role?: string }
    | undefined;
  const sentinelCleanup = marker?.role === 'sentinel' ? waitForPopStates(1) : null;
  await act(async () => {
    mounted.root.unmount();
  });
  await sentinelCleanup;
  mounted.container.remove();
}

async function rerenderPage(mounted: MountedPage): Promise<void> {
  await act(async () => {
    mounted.root.render(<DocumentsPage />);
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

function waitForPopStates(count: number): Promise<PopStateEvent[]> {
  return new Promise((resolve, reject) => {
    const events: PopStateEvent[] = [];
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener('popstate', handlePopState);
      reject(new Error(`popstateが${count}回発火しませんでした`));
    }, 1000);
    const handlePopState = (event: PopStateEvent): void => {
      events.push(event);
      if (events.length < count) return;
      window.clearTimeout(timeoutId);
      window.removeEventListener('popstate', handlePopState);
      resolve(events);
    };
    window.addEventListener('popstate', handlePopState);
  });
}

describe('DocumentsPage', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        if (!this.open) return;
        this.removeAttribute('open');
        queueMicrotask(() => {
          this.dispatchEvent(new Event('close'));
        });
      },
    });
  });

  afterAll(() => {
    if (originalShowModal) {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
    } else {
      delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    }
    if (originalDialogClose) {
      Object.defineProperty(HTMLDialogElement.prototype, 'close', originalDialogClose);
    } else {
      delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
    }
  });

  beforeEach(() => {
    mocks.pathname = '/documents';
    mocks.authState.loading = false;
    mocks.authState.user = { uid: 'owner-1' };
    latestListSidebarProps = null;
    latestDetailPanelProps = null;
    mocks.confirm.mockReset().mockReturnValue(false);
    mocks.detailDiscard.mockReset();
    mocks.detailFocus.mockReset();
    mocks.detailSave.mockReset().mockResolvedValue(true);
    mocks.headerNavigation.mockReset();
    mocks.restoreTranscription.mockReset().mockResolvedValue(undefined);
    mocks.updateTranscription.mockReset().mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockImplementation(mocks.confirm);
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
    window.history.replaceState(null, '', '/history-far');
    window.history.pushState(null, '', '/history-origin');
    window.history.pushState(null, '', '/documents');
  });

  afterEach(async () => {
    for (const mounted of [...mountedPages]) {
      await unmountPage(mounted);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('一覧クリックで親stateを更新し、実mountを再描画して選択文書を切り替える', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));

    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);
    expect(getByTestId(mounted.container, 'selected-document-id').textContent)
      .toBe(firstDocument.id);

    await click(getByTestId(mounted.container, 'select-second'));

    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(secondDocument.id);
    expect(getByTestId(mounted.container, 'selected-document-id').textContent)
      .toBe(secondDocument.id);
  });

  it('dirty中の別文書クリックを保留し、保存後にだけ切り替える', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    await click(getByTestId(mounted.container, 'select-second'));

    expect(mounted.container.querySelector('[role="dialog"]')?.textContent)
      .toContain('未保存の変更があります');
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);

    const switchSentinelCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '保存して切り替える'));
    await switchSentinelCleanup;

    expect(mocks.detailSave).toHaveBeenCalledOnce();
    expect(mocks.updateTranscription).toHaveBeenCalledWith(firstDocument.id, {
      title: '最初の文書（編集済み）',
      transcription: '最初の本文（編集済み）',
    }, { expectedUpdatedAt: null });
    expect(mocks.restoreTranscription).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(secondDocument.id);
  });

  it('dirty選択文書がrefresh結果から消えても保持し、保存成功で一覧側の親stateへ復元する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    await click(getByTestId(mounted.container, 'refresh-without-selected'));

    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);
    expect(getByTestId(mounted.container, 'selected-document-id').textContent)
      .toBe(firstDocument.id);
    expect(mounted.container.textContent)
      .toContain('一覧から消えた文書に未保存の変更があります');
    expect(mounted.container.textContent).not.toContain('ホームで文書を生成');

    const restoreSentinelCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '保存して復元'));
    await restoreSentinelCleanup;

    expect(mocks.restoreTranscription).toHaveBeenCalledWith(
      firstDocument.id,
      firstDocument,
      {
        title: '最初の文書（編集済み）',
        transcription: '最初の本文（編集済み）',
      },
      { expectedUpdatedAt: null },
    );
    expect(mocks.updateTranscription).not.toHaveBeenCalled();
    expect(mounted.container.textContent)
      .not.toContain('一覧から消えた文書に未保存の変更があります');
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);
    expect(getByTestId(mounted.container, 'update-trigger').textContent).toBe('1');
  });

  it('dirty選択文書が0件refreshで消えた場合も空CTAへ落とさず、明示破棄後にだけ選択を外す', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    await click(getByTestId(mounted.container, 'refresh-empty'));

    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);
    expect(mounted.container.textContent).not.toContain('ホームで文書を生成');

    const discardSentinelCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '変更を破棄'));
    await discardSentinelCleanup;

    expect(mocks.detailDiscard).toHaveBeenCalledOnce();
    expect(mounted.container.querySelector('[data-testid="detail-panel"]')).toBeNull();
    expect(mounted.container.textContent).toContain('ホームで文書を生成');
    expect(getByTestId(mounted.container, 'selected-document-id').textContent).toBe('');
  });

  it('0件refreshから保存復元した文書を古いcount=0の空CTAで隠さない', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    await click(getByTestId(mounted.container, 'refresh-empty'));

    const restoreSentinelCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '保存して復元'));
    await restoreSentinelCleanup;

    expect(mocks.restoreTranscription).toHaveBeenCalledOnce();
    expect(mounted.container.textContent).not.toContain('ホームで文書を生成');
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);
    expect(getByTestId(mounted.container, 'selected-document-id').textContent)
      .toBe(firstDocument.id);
  });

  it('欠落文書の復元保存に失敗した場合はdirty選択と編集内容を保持する', async () => {
    mocks.restoreTranscription.mockRejectedValueOnce(new Error('restore failed'));
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    await click(getByTestId(mounted.container, 'refresh-without-selected'));

    await click(getButtonByText(mounted.container, '保存して復元'));

    expect(mounted.container.textContent)
      .toContain('保存できませんでした。編集内容は保持されています。');
    expect(mounted.container.textContent)
      .toContain('一覧から消えた文書に未保存の変更があります');
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('true');
    expect(getByTestId(mounted.container, 'update-trigger').textContent).toBe('0');
  });

  it('cleanな選択文書が一覧から消えたrefreshでは選択を解除し、欠落バナーを出さない', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'refresh-without-selected'));

    expect(getByTestId(mounted.container, 'selected-document-id').textContent).toBe('');
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId).toBe('');
    expect(mounted.container.textContent)
      .not.toContain('一覧から消えた文書に未保存の変更があります');
    const unloadAfterDeselect = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadAfterDeselect);
    expect(unloadAfterDeselect.defaultPrevented).toBe(false);
  });

  it('欠落バナー表示中の詳細パネル側破棄は、ポーリングを待たず同期でバナーを畳み選択を外す', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    await click(getByTestId(mounted.container, 'refresh-without-selected'));
    expect(mounted.container.textContent)
      .toContain('一覧から消えた文書に未保存の変更があります');

    const discardSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'discard-from-panel'));
    await discardSentinelCleanup;

    expect(mounted.container.textContent)
      .not.toContain('一覧から消えた文書に未保存の変更があります');
    expect(getByTestId(mounted.container, 'selected-document-id').textContent).toBe('');
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId).toBe('');
    const unloadAfterDiscard = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadAfterDiscard);
    expect(unloadAfterDiscard.defaultPrevented).toBe(false);
  });

  it('保存はexpectedUpdatedAtを渡し、返ったupdatedAtを次回保存の期待値に使う', async () => {
    const firstSavedAt = new Date('2026-09-01T10:00:05.000Z');
    mocks.updateTranscription.mockResolvedValueOnce(firstSavedAt);
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    const firstSaveSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-new-body'));
    await firstSaveSentinelCleanup;

    expect(mocks.updateTranscription).toHaveBeenNthCalledWith(1, firstDocument.id, {
      title: firstDocument.title,
      transcription: '本文編集後',
    }, { expectedUpdatedAt: null });

    await click(getByTestId(mounted.container, 'mark-dirty'));
    const secondSaveSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-current-document'));
    await secondSaveSentinelCleanup;

    // 返ったupdatedAtが親state経由で次回のexpectedへ伝搬しないと、
    // 自分の保存が直後の再保存で偽競合になる。
    expect(mocks.updateTranscription).toHaveBeenNthCalledWith(2, firstDocument.id, {
      title: firstDocument.title,
      transcription: '本文編集後',
    }, { expectedUpdatedAt: firstSavedAt });
  });

  it('documents側のupdatedAtが前進しても、pageはパネルのpin(ロード時の版)を逐語でupdateTranscriptionへ転送する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents-with-versions'));
    await click(getByTestId(mounted.container, 'select-first'));
    // ポーリング相当: 選択中文書のupdatedAtだけが一覧側で前進する。
    await click(getByTestId(mounted.container, 'advance-first-updated-at'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const saveSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-new-body'));
    await saveSentinelCleanup;

    expect(mocks.updateTranscription).toHaveBeenCalledWith(firstDocument.id, {
      title: firstDocument.title,
      transcription: '本文編集後',
    }, { expectedUpdatedAt: loadedVersionMarker });
    const forwardedMeta = mocks.updateTranscription.mock.calls[0][2] as {
      expectedUpdatedAt: unknown;
    };
    expect(forwardedMeta.expectedUpdatedAt).toBe(loadedVersionMarker);
    expect(forwardedMeta.expectedUpdatedAt).not.toBe(polledVersionMarker);
  });

  it('復元保存が返したupdatedAtを一覧stateへ反映し、次の保存の期待値になる', async () => {
    const restoredUpdatedAt = new Date('2026-09-01T12:00:00.000Z');
    mocks.restoreTranscription.mockResolvedValueOnce(restoredUpdatedAt);
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    await click(getByTestId(mounted.container, 'refresh-without-selected'));

    const restoreSentinelCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '保存して復元'));
    await restoreSentinelCleanup;

    await click(getByTestId(mounted.container, 'mark-dirty'));
    const secondSaveSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-current-document'));
    await secondSaveSentinelCleanup;

    expect(mocks.updateTranscription).toHaveBeenCalledWith(firstDocument.id, {
      title: '最初の文書（編集済み）',
      transcription: '最初の本文（編集済み）',
    }, { expectedUpdatedAt: restoredUpdatedAt });
  });

  it('保存後の版未確定警告は、ボタン押下では消えず、版印つきの取得成功が届いた時だけ消える', async () => {
    mocks.updateTranscription.mockResolvedValueOnce(null);
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents-with-versions'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    const saveSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-new-body'));
    await saveSentinelCleanup;

    expect(mounted.container.textContent)
      .toContain('保存は完了しましたが、他の場所で更新された可能性があります');

    // 取得が成功する前にボタン押下だけで警告を消すと、失敗時に「最新を確認済み」
    // という誤認になる。押下は再取得の要求であって確認の完了ではない。
    await click(getButtonByText(mounted.container, '最新の内容を読み込む'));
    expect(getByTestId(mounted.container, 'update-trigger').textContent).toBe('2');
    expect(mounted.container.textContent)
      .toContain('保存は完了しましたが、他の場所で更新された可能性があります');

    // 版印つきの一覧が届いた時だけ「最新を確認できる状態になった」として畳む。
    await click(getByTestId(mounted.container, 'advance-first-updated-at'));
    expect(mounted.container.textContent)
      .not.toContain('保存は完了しましたが、他の場所で更新された可能性があります');
  });

  it('版印なしの一覧が届いても版未確定警告は畳まない(clearの根拠は版印つき取得成功だけ)', async () => {
    mocks.updateTranscription.mockResolvedValueOnce(null);
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    const saveSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-new-body'));
    await saveSentinelCleanup;
    expect(mounted.container.textContent)
      .toContain('保存は完了しましたが、他の場所で更新された可能性があります');

    // 版印を持たない一覧(剥がし済みローカルsnapshot相当)の到着は「サーバの
    // 実状態を確認できた」証拠にならないため、警告を畳んではならない。
    await click(getByTestId(mounted.container, 'load-documents'));
    expect(mounted.container.textContent)
      .toContain('保存は完了しましたが、他の場所で更新された可能性があります');

    await click(getByTestId(mounted.container, 'advance-first-updated-at'));
    expect(mounted.container.textContent)
      .not.toContain('保存は完了しましたが、他の場所で更新された可能性があります');
  });

  it('版未確定警告は文書ごとに保持し、別文書の確定保存で消えない', async () => {
    mocks.updateTranscription
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Date('2026-09-01T13:00:00.000Z'));
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    const firstSaveCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-new-body'));
    await firstSaveCleanup;
    expect(mounted.container.textContent)
      .toContain('保存は完了しましたが、他の場所で更新された可能性があります');

    // 別文書を確定保存しても、最初の文書の警告は残らなければならない。
    await click(getByTestId(mounted.container, 'select-second'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    const secondSaveCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-new-body'));
    await secondSaveCleanup;
    expect(mounted.container.textContent)
      .not.toContain('保存は完了しましたが、他の場所で更新された可能性があります');

    await click(getByTestId(mounted.container, 'select-first'));
    expect(mounted.container.textContent)
      .toContain('保存は完了しましたが、他の場所で更新された可能性があります');
  });

  it('詳細パネルの最新読込要求で一覧のupdateTriggerを進める', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    expect(getByTestId(mounted.container, 'update-trigger').textContent).toBe('0');

    await click(getByTestId(mounted.container, 'request-latest'));

    expect(getByTestId(mounted.container, 'update-trigger').textContent).toBe('1');
  });

  it('dirty時のhistory.backは同期でsentinelへ保留し、画面内ダイアログの残る選択で留まる', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const beforeUnloadWhileDirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadWhileDirty);
    expect(beforeUnloadWhileDirty.defaultPrevented).toBe(true);

    const heldTraversal = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await heldTraversal;
    });

    expect(window.location.pathname).toBe('/documents');
    expect(window.history.state?.__documentsUnsavedChangesGuard?.role).toBe('sentinel');
    expect(mocks.confirm).not.toHaveBeenCalled();
    const leaveDialog = mounted.container.querySelector('dialog');
    expect(leaveDialog?.textContent).toContain('未保存の変更があります');
    expect(leaveDialog?.textContent).toContain('このページから移動しますか？');
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('true');

    await click(getButtonByText(mounted.container, 'このページに残る'));
    expect(mounted.container.querySelector('dialog')).toBeNull();
    expect(window.location.pathname).toBe('/documents');
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('true');

    const internalClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => {
      getByTestId(mounted.container, 'internal-navigation').dispatchEvent(internalClick);
      await Promise.resolve();
    });
    expect(internalClick.defaultPrevented).toBe(true);
    expect(mounted.container.querySelector('dialog')?.textContent)
      .toContain('このページから移動しますか？');
    await click(getButtonByText(mounted.container, 'このページに残る'));

    await click(getByTestId(mounted.container, 'header-navigation'));
    expect(mocks.headerNavigation).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('dialog')).not.toBeNull();
    await click(getButtonByText(mounted.container, 'このページに残る'));

    const sentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'mark-clean'));
    await sentinelCleanup;
    const beforeUnloadAfterClean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadAfterClean);
    expect(beforeUnloadAfterClean.defaultPrevented).toBe(false);

    const unguardedTraversal = waitForPopStates(1);
    window.history.back();
    await unguardedTraversal;
    expect(window.location.pathname).toBe('/history-origin');
    expect(mounted.container.querySelector('dialog')).toBeNull();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('dirty中の履歴離脱をダイアログで承認するとsentinelの手前まで二段戻る', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const heldTraversal = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await heldTraversal;
    });
    expect(window.location.pathname).toBe('/documents');

    const approvedTraversal = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await approvedTraversal;

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('dialog')).toBeNull();
    expect(window.location.pathname).toBe('/history-origin');

    await new Promise(resolve => window.setTimeout(resolve, 300));
    expect(window.location.pathname).toBe('/history-origin');
  });

  it('履歴前項目がなく承認後のgoがno-opでも250ms後に承認を解除しguardを再武装する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const nativeGo = window.history.go.bind(window.history);
    let interceptedExitDelta: number | null = null;
    vi.spyOn(window.history, 'go').mockImplementation((delta?: number) => {
      if (interceptedExitDelta === null) {
        // 履歴前項目が足りず、承認後のgoが何も遷移しない状況を再現する。
        interceptedExitDelta = delta ?? 0;
        return;
      }
      nativeGo(delta);
    });

    const heldTraversal = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await heldTraversal;
    });
    await click(getButtonByText(mounted.container, '移動する'));

    expect(interceptedExitDelta).toBe(-2);
    expect(window.location.pathname).toBe('/documents');
    expect(window.history.state?.__documentsUnsavedChangesGuard?.role).toBe('sentinel');

    await new Promise(resolve => window.setTimeout(resolve, 300));
    const guardedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guardedUnload);
    expect(guardedUnload.defaultPrevented).toBe(true);

    const guardedBackAgain = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await guardedBackAgain;
    });
    expect(mounted.container.querySelector('dialog')?.textContent)
      .toContain('このページから移動しますか？');
    await click(getButtonByText(mounted.container, 'このページに残る'));
    expect(window.location.pathname).toBe('/documents');
  });

  it('【既知制約の記録】routerが先着popstateで別routeをcommitする長距離Backは、確認前にunmountされ保留できない', async () => {
    // Next App RouterのACTION_RESTORE相当: routerのpopstate listenerはこのpageの
    // listenerより先に登録されており、別pathnameへの着地を先にcommitし得る。
    // その場合このpageは保留(forward復帰+ダイアログ)を挟む機会なくunmountされ、
    // draftは確認なしに失われる。listenerは登録順で走り、captureでも先行できない
    // ため、page内からこのraceを閉じる手段は無い。守れている範囲: 一段Back
    // (sentinel=同一URLでrouterが反応しない・支配的ケース)/リロード・クローズ
    // (beforeunload)/SPA内クリック。複数entry飛び越え+router先行commitだけが
    // この窓に残る。実ブラウザでの検証を要する制約としてここに記録する。
    const routerLikeRestore = (): void => {
      if (window.location.pathname === '/documents') return;
      const mountedPage = [...mountedPages][0];
      if (!mountedPage) return;
      mountedPage.root.unmount();
      mountedPages.delete(mountedPage);
      mountedPage.container.remove();
    };
    window.addEventListener('popstate', routerLikeRestore);
    try {
      const mounted = await mountPage();
      await click(getByTestId(mounted.container, 'load-documents'));
      await click(getByTestId(mounted.container, 'select-first'));
      await click(getByTestId(mounted.container, 'mark-dirty'));

      const landedTraversal = waitForPopStates(1);
      await act(async () => {
        window.history.go(-3);
        await landedTraversal;
      });

      // routerが先にcommit=unmount済み。保留もダイアログも起こせていない。
      expect(window.location.pathname).toBe('/history-far');
      expect(document.querySelector('[data-testid="detail-panel"]')).toBeNull();
      expect(document.querySelector('dialog')).toBeNull();
      expect(mocks.confirm).not.toHaveBeenCalled();

      // 破棄後のcleanupが例外なく完了し、以後の履歴操作を壊さないことだけは保証する。
      await new Promise(resolve => window.setTimeout(resolve, 300));
      expect(window.history.state?.__documentsUnsavedChangesGuard).toBeUndefined();
    } finally {
      window.removeEventListener('popstate', routerLikeRestore);
    }
  });

  it('sentinelを複数entry飛び越えたbackも一段ずつsentinelへ復帰し、ダイアログは一つだけ出す', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const recoveredTraversal = waitForPopStates(4);
    await act(async () => {
      window.history.go(-3);
      await recoveredTraversal;
    });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/documents');
    expect(window.history.state?.__documentsUnsavedChangesGuard?.role).toBe('sentinel');
    expect(mounted.container.querySelectorAll('dialog')).toHaveLength(1);
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('true');

    await click(getButtonByText(mounted.container, 'このページに残る'));
    expect(mounted.container.querySelector('dialog')).toBeNull();
    expect(window.location.pathname).toBe('/documents');
  });

  it('sentinel復帰の完了前に押した移動するも無視せず、復帰完了後に承認を実行する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    // 飛び越えbackの直後、復帰走行(forward×3)が終わる前にダイアログが開く。
    const landedTraversal = waitForPopStates(1);
    await act(async () => {
      window.history.go(-3);
      await landedTraversal;
    });
    expect(mounted.container.querySelector('dialog')).not.toBeNull();

    // 復帰走行中の承認クリック。無言で無視すると利用者には「押しても効かない」
    // ボタンになる。復帰完了後に自動実行され、元の飛び越え先まで戻ること。
    const recoveryAndExit = waitForPopStates(4);
    await click(getButtonByText(mounted.container, '移動する'));
    await recoveryAndExit;

    expect(window.location.pathname).toBe('/history-far');
    expect(mounted.container.querySelector('dialog')).toBeNull();
  });

  it('承認した履歴移動がquery違いの同一routeへ着地してcomponentが残る場合、ガードを再武装する', async () => {
    // 直前の履歴entryが /documents?tab=old のような同一route: 承認遷移で着地しても
    // componentはunmountされず、pathnameも変わらない。承認状態が残ると以後の
    // Backとbeforeunloadが恒久的に確認を迂回する。
    window.history.replaceState(null, '', '/documents?tab=old');
    window.history.pushState(null, '', '/documents');
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const heldTraversal = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await heldTraversal;
    });
    const approvedTraversal = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await approvedTraversal;
    expect(window.location.search).toBe('?tab=old');

    // 250msフォールバックが「遷移は起きたがcomponentが残った」を検出して再武装する。
    await new Promise(resolve => window.setTimeout(resolve, 300));

    const guardedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guardedUnload);
    expect(guardedUnload.defaultPrevented).toBe(true);
    expect(window.history.state?.__documentsUnsavedChangesGuard?.role).toBe('sentinel');

    const guardedBackAgain = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await guardedBackAgain;
    });
    expect(mounted.container.querySelector('dialog')?.textContent)
      .toContain('このページから移動しますか？');
    await click(getButtonByText(mounted.container, 'このページに残る'));
  });

  it('trailing slash違いの同一routeへの承認Back着地でも、ガードを再武装する', async () => {
    window.history.replaceState(null, '', '/documents/');
    window.history.pushState(null, '', '/documents');
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const heldTraversal = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await heldTraversal;
    });
    const approvedTraversal = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await approvedTraversal;
    expect(window.location.pathname).toBe('/documents/');

    await new Promise(resolve => window.setTimeout(resolve, 300));

    // /documents/ は /documents と同一route。厳密一致で別扱いすると再武装されず
    // 承認が残留し、以後のBackとbeforeunloadが確認を迂回する。
    const guardedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guardedUnload);
    expect(guardedUnload.defaultPrevented).toBe(true);
    expect(window.history.state?.__documentsUnsavedChangesGuard?.role).toBe('sentinel');
  });

  it('承認したBackが別routeへ着地しunmountが遅れても、着地先へsentinelを再設置せずForward履歴を壊さない', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const heldTraversal = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await heldTraversal;
    });
    const approvedTraversal = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await approvedTraversal;
    expect(window.location.pathname).toBe('/history-origin');

    // 旧pageのunmountが250msより遅いケース: 着地先は別routeなので再武装しては
    // ならない(pushStateがForward側の履歴を切り落とし、余計な履歴汚染も起きる)。
    await new Promise(resolve => window.setTimeout(resolve, 300));

    expect(window.history.state?.__documentsUnsavedChangesGuard).toBeUndefined();
    const forwardTraversal = waitForPopStates(1);
    await act(async () => {
      window.history.forward();
      await forwardTraversal;
    });
    expect(window.location.pathname).toBe('/documents');
  });

  it('複数entry飛び越えの離脱を承認すると元の飛び越え先まで同じ深さで戻る', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const recoveredTraversal = waitForPopStates(4);
    await act(async () => {
      window.history.go(-3);
      await recoveredTraversal;
    });
    expect(window.location.pathname).toBe('/documents');

    const approvedTraversal = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await approvedTraversal;

    expect(window.location.pathname).toBe('/history-far');
  });

  it('router承認時はsentinelをbaseへ戻してmarkerを除去してからclickをreplayする', async () => {
    mocks.headerNavigation.mockImplementationOnce(() => {
      window.history.pushState({ destination: 'home' }, '', '/home');
    });
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    await click(getByTestId(mounted.container, 'header-navigation'));
    expect(mocks.headerNavigation).not.toHaveBeenCalled();
    const routerCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await routerCleanup;
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.headerNavigation).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/home');
    expect(window.history.state).toEqual({ destination: 'home' });

    await unmountPage(mounted);
    const backToCleanBase = waitForPopStates(1);
    window.history.back();
    const [baseEvent] = await backToCleanBase;
    expect(window.location.pathname).toBe('/documents');
    expect(baseEvent.state?.__documentsUnsavedChangesGuard).toBeUndefined();
  });

  it('router承認後にreplay対象が再描画で消えた場合、承認を解除しガードを再武装する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    await click(getByTestId(mounted.container, 'header-navigation'));
    const routerCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    // back()のpopstateが届く前に、replay対象のリンクがDOMから消える(再描画相当)。
    getByTestId(mounted.container, 'header-navigation').remove();
    await routerCleanup;
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.headerNavigation).not.toHaveBeenCalled();
    // 遷移できないままapproval='router'が固定されるとbeforeunloadが恒久迂回になる。
    const guardedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guardedUnload);
    expect(guardedUnload.defaultPrevented).toBe(true);
    expect(window.history.state?.__documentsUnsavedChangesGuard?.role).toBe('sentinel');

    const guardedBack = waitForPopStates(2);
    await act(async () => {
      window.history.back();
      await guardedBack;
    });
    expect(mounted.container.querySelector('dialog')?.textContent)
      .toContain('このページから移動しますか？');
    await click(getButtonByText(mounted.container, 'このページに残る'));
  });

  it('router承認後250ms直前にpathnameが変わる遅い遷移ではsentinelを再設置しない', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    await click(getByTestId(mounted.container, 'header-navigation'));
    const routerCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await routerCleanup;
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.headerNavigation).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/documents');

    await new Promise(resolve => window.setTimeout(resolve, 200));
    window.history.pushState({ destination: 'slow-home' }, '', '/home');
    mocks.pathname = '/home';
    await rerenderPage(mounted);

    // 250msタイマの発火を待たず、pathname変化の時点で承認を解除しガードを再武装する。
    const unloadBeforeFallbackTimer = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadBeforeFallbackTimer);
    expect(unloadBeforeFallbackTimer.defaultPrevented).toBe(true);

    await new Promise(resolve => window.setTimeout(resolve, 100));

    expect(window.location.pathname).toBe('/home');
    expect(window.history.state).toEqual({ destination: 'slow-home' });
    expect(window.history.state?.__documentsUnsavedChangesGuard).toBeUndefined();

    await unmountPage(mounted);
    const backToCleanBase = waitForPopStates(1);
    window.history.back();
    const [baseEvent] = await backToCleanBase;
    expect(window.location.pathname).toBe('/documents');
    expect(baseEvent.state?.__documentsUnsavedChangesGuard).toBeUndefined();
  });

  it('未prefetchの遅い正常遷移(250ms超)でも、時間経過を理由にguardを履歴へ再挿入しない', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    await click(getByTestId(mounted.container, 'header-navigation'));
    const routerCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await routerCleanup;
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.headerNavigation).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/documents');

    // 遷移完了の判定は時間でなく状態(pathname変化 or unmount)。250msを超えて
    // 完了しない正常な遷移で再挿入すると、完了後の履歴後方にbase/sentinelが
    // 残り、Backで/documentsを二重に踏む。
    await new Promise(resolve => window.setTimeout(resolve, 400));
    expect(window.history.state?.__documentsUnsavedChangesGuard).toBeUndefined();

    // dirtyな間、リロード/クローズは承認状態にかかわらず常に確認する。
    const unloadDuringSlowTransition = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadDuringSlowTransition);
    expect(unloadDuringSlowTransition.defaultPrevented).toBe(true);

    // 遅い遷移が完了しても、後方の履歴にguardの痕跡が無い。
    window.history.pushState({ destination: 'slow-home' }, '', '/home');
    mocks.pathname = '/home';
    await rerenderPage(mounted);
    const backTraversal = waitForPopStates(1);
    await act(async () => {
      window.history.back();
      await backTraversal;
    });
    expect(window.location.pathname).toBe('/documents');
    expect(window.history.state?.__documentsUnsavedChangesGuard).toBeUndefined();
  });

  it('router承認後250ms以内にunmountした遷移ではsentinelを再設置せず履歴を汚さない', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    await click(getByTestId(mounted.container, 'header-navigation'));
    const routerCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '移動する'));
    await routerCleanup;
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.headerNavigation).toHaveBeenCalledOnce();

    // 250msタイマの発火前にunmountし、タイマ発火時刻を跨いで観測する。
    await unmountPage(mounted);
    await new Promise(resolve => window.setTimeout(resolve, 300));

    expect(window.history.state?.__documentsUnsavedChangesGuard).toBeUndefined();
    const backAfterUnmount = waitForPopStates(1);
    window.history.back();
    const [entryBeforeDocuments] = await backAfterUnmount;
    expect(window.location.pathname).toBe('/history-origin');
    expect(entryBeforeDocuments.state?.__documentsUnsavedChangesGuard).toBeUndefined();
  });

  it('sentinelを設置できない環境ではpopstate保留を諦め、beforeunloadとクリック監視だけへ縮退する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    // 履歴を書けない環境を再現(installGuardSessionのpushStateが失敗する)。
    vi.spyOn(window.history, 'pushState').mockImplementation(() => {
      throw new Error('history is sealed');
    });
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const beforeUnloadWhileDirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadWhileDirty);
    expect(beforeUnloadWhileDirty.defaultPrevented).toBe(true);

    const internalClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => {
      getByTestId(mounted.container, 'internal-navigation').dispatchEvent(internalClick);
      await Promise.resolve();
    });
    expect(internalClick.defaultPrevented).toBe(true);
    await click(getButtonByText(mounted.container, 'このページに残る'));

    // 縮退中でもSPA内クリックの確認は承認まで機能する(sessionなしの直接replay)。
    await click(getByTestId(mounted.container, 'header-navigation'));
    expect(mocks.headerNavigation).not.toHaveBeenCalled();
    await click(getButtonByText(mounted.container, '移動する'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.headerNavigation).toHaveBeenCalledOnce();

    // sentinelが無いのに保留(forward探索)を始めると、履歴末尾でpopstateが
    // 二度と来ず復帰フラグが永久trueになり「移動する」も無視される。
    // 縮退ではpopstate離脱は素通しし、ダイアログも出さない。
    const passthroughTraversal = waitForPopStates(1);
    await act(async () => {
      window.history.back();
      await passthroughTraversal;
    });

    expect(window.location.pathname).toBe('/history-origin');
    expect(mounted.container.querySelector('dialog')).toBeNull();
  });

  it('unmount後はdirty離脱listenerとsentinel markerをcleanupする', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    await unmountPage(mounted);
    expect(window.location.pathname).toBe('/documents');
    expect(window.history.state?.__documentsUnsavedChangesGuard).toBeUndefined();
    const beforeUnloadAfterUnmount = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadAfterUnmount);
    expect(beforeUnloadAfterUnmount.defaultPrevented).toBe(false);

    const traversalAfterUnmount = waitForPopStates(1);
    window.history.back();
    await traversalAfterUnmount;
    expect(window.location.pathname).toBe('/history-origin');
    expect(document.querySelector('dialog')).toBeNull();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('owner変更時はdirty draftを保存不能なコピー用退避欄へ残し、明示破棄まで離脱を守る', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    await click(getByTestId(mounted.container, 'refresh-without-selected'));
    expect(mounted.container.textContent)
      .toContain('一覧から消えた文書に未保存の変更があります');

    mocks.authState.user = { uid: 'owner-2' };
    await rerenderPage(mounted);

    expect(mounted.container.textContent)
      .not.toContain('一覧から消えた文書に未保存の変更があります');
    expect(mounted.container.textContent)
      .toContain('アカウント切替により未保存の変更は保存できません');
    expect(
      getByTestId(mounted.container, 'owner-change-draft-body')
        .getAttribute('readonly'),
    ).not.toBeNull();
    expect(
      (getByTestId(mounted.container, 'owner-change-draft-body') as HTMLTextAreaElement).value,
    ).toBe('未保存本文');
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId).toBe('');
    expect(getByTestId(mounted.container, 'selected-document-id').textContent).toBe('');
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('false');
    expect(mocks.detailDiscard).not.toHaveBeenCalled();
    expect(mocks.updateTranscription).not.toHaveBeenCalled();
    expect(mocks.restoreTranscription).not.toHaveBeenCalled();

    const afterOwnerChangeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterOwnerChangeUnload);
    expect(afterOwnerChangeUnload.defaultPrevented).toBe(true);

    const ownerDraftDiscardCleanup = waitForPopStates(1);
    await click(getButtonByText(mounted.container, '退避内容を破棄'));
    await ownerDraftDiscardCleanup;
    expect(mounted.container.textContent)
      .not.toContain('アカウント切替により未保存の変更は保存できません');
    const afterOwnerDraftDiscard = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterOwnerDraftDiscard);
    expect(afterOwnerDraftDiscard.defaultPrevented).toBe(false);
  });

  it('本文保存後にSidebarのstale snapshotから改名して再保存しても新本文を維持する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    const firstSaveSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-new-body'));
    await firstSaveSentinelCleanup;

    expect(mocks.updateTranscription).toHaveBeenNthCalledWith(1, firstDocument.id, {
      title: firstDocument.title,
      transcription: '本文編集後',
    }, { expectedUpdatedAt: null });

    // Sidebar側のmockは初回取得時のfirstDocumentを保持したまま、タイトルpatchだけを通知する。
    await click(getByTestId(mounted.container, 'rename-first'));

    const renamedDetail = getByTestId(mounted.container, 'detail-panel');
    expect(renamedDetail.dataset.documentTitle).toBe('改名後');
    expect(renamedDetail.dataset.documentText).toBe('本文編集後');

    await click(getByTestId(mounted.container, 'mark-dirty'));
    const secondSaveSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'save-current-document'));
    await secondSaveSentinelCleanup;

    expect(mocks.updateTranscription).toHaveBeenNthCalledWith(2, firstDocument.id, {
      title: '改名後',
      transcription: '本文編集後',
    }, { expectedUpdatedAt: null });
  });

  it('削除確定時は選択dirty状態も解消する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('true');
    const deleteSentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'delete-first'));
    await deleteSentinelCleanup;

    expect(mocks.detailDiscard).toHaveBeenCalledOnce();
    expect(getByTestId(mounted.container, 'selected-document-id').textContent).toBe('');
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('false');
    const afterDeleteUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterDeleteUnload);
    expect(afterDeleteUnload.defaultPrevented).toBe(false);
  });

  it('一覧取得成功かつ0件の場合だけホームCTAを表示し、外枠幅を維持する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'refresh-empty'));

    expect(mounted.container.textContent).toContain('ホームで文書を生成');
    expect(mounted.container.querySelector<HTMLAnchorElement>('a[href="/home"]')).not.toBeNull();
    expect(mounted.container.firstElementChild?.classList).toContain('max-w-7xl');
    expect(mounted.container.querySelector('[data-testid="detail-panel"]')).toBeNull();
    expect(latestListSidebarProps).not.toBeNull();
    expect(latestDetailPanelProps?.document ?? null).toBeNull();
  });
});

// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcription } from '@/lib/firestore';
import DocumentsPage from './page';

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

type DetailPanelProps = {
  document: Transcription | null;
  onDocumentUpdate?: (
    documentId: string,
    patch: { title: string; text: string },
  ) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
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

      ReactModule.useImperativeHandle(ref, () => ({
        save: async () => {
          const saved = await mocks.detailSave();
          if (!saved) return false;

          const currentProps = propsRef.current;
          const currentDocument = currentProps.document;
          try {
            if (currentDocument?.id) {
              await currentProps.onDocumentUpdate?.(currentDocument.id, {
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
            data-testid="save-new-body"
            onClick={() => {
              if (!props.document?.id) return;
              void props.onDocumentUpdate?.(props.document.id, {
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
              void props.onDocumentUpdate?.(props.document.id, {
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
    });
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

  it('dirty時は同一URL sentinelで実際のhistory.backを止め、キャンセル時にforward復帰する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const beforeUnloadWhileDirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadWhileDirty);
    expect(beforeUnloadWhileDirty.defaultPrevented).toBe(true);

    const cancelledTraversal = waitForPopStates(2);
    window.history.back();
    await cancelledTraversal;

    expect(window.location.pathname).toBe('/documents');
    expect(mocks.confirm).toHaveBeenCalledWith(
      '未保存の変更があります。このページから移動しますか？',
    );
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(getByTestId(mounted.container, 'detail-panel').dataset.documentId)
      .toBe(firstDocument.id);
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('true');

    const internalClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    getByTestId(mounted.container, 'internal-navigation').dispatchEvent(internalClick);
    expect(internalClick.defaultPrevented).toBe(true);

    await click(getByTestId(mounted.container, 'header-navigation'));
    expect(mocks.headerNavigation).not.toHaveBeenCalled();

    const sentinelCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'mark-clean'));
    await sentinelCleanup;
    mocks.confirm.mockClear();
    const beforeUnloadAfterClean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadAfterClean);
    expect(beforeUnloadAfterClean.defaultPrevented).toBe(false);

    const unguardedTraversal = waitForPopStates(1);
    window.history.back();
    await unguardedTraversal;
    expect(window.location.pathname).toBe('/history-origin');
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('dirty中に戻ることを承認するとsentinelの手前まで二段戻る', async () => {
    mocks.confirm.mockReturnValue(true);
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const approvedTraversal = waitForPopStates(2);
    window.history.back();
    await approvedTraversal;

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/history-origin');

    await new Promise(resolve => window.setTimeout(resolve, 300));
    expect(window.location.pathname).toBe('/history-origin');
  });

  it('履歴前項目がなく二段目backがno-opでも次taskでsentinelとdirty guardを復帰する', async () => {
    mocks.confirm.mockReturnValueOnce(true).mockReturnValue(false);
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const nativeBack = window.history.back.bind(window.history);
    let backCallCount = 0;
    vi.spyOn(window.history, 'back').mockImplementation(() => {
      backCallCount += 1;
      if (backCallCount === 2) return;
      nativeBack();
    });

    const failedApprovedTraversal = waitForPopStates(2);
    window.history.back();
    await failedApprovedTraversal;

    expect(backCallCount).toBe(2);
    expect(window.location.pathname).toBe('/documents');
    expect(window.history.state?.__documentsUnsavedChangesGuard?.role).toBe('sentinel');
    const guardedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guardedUnload);
    expect(guardedUnload.defaultPrevented).toBe(true);

    const guardedBackAgain = waitForPopStates(2);
    window.history.back();
    await guardedBackAgain;
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).toBe('/documents');
  });

  it('sentinelを複数entry飛び越えたbackもconfirm一回でforward回復する', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const recoveredTraversal = waitForPopStates(4);
    window.history.go(-3);
    await recoveredTraversal;

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/documents');
    expect(window.history.state?.__documentsUnsavedChangesGuard?.role).toBe('sentinel');
    expect(getByTestId(mounted.container, 'selected-document-dirty').textContent).toBe('true');
  });

  it('router承認時はsentinelをbaseへ戻してmarkerを除去してからclickをreplayする', async () => {
    mocks.confirm.mockReturnValue(true);
    mocks.headerNavigation.mockImplementationOnce(() => {
      window.history.pushState({ destination: 'home' }, '', '/home');
    });
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const routerCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'header-navigation'));
    await routerCleanup;
    await act(async () => {
      await Promise.resolve();
    });

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

  it('router承認後250ms直前にpathnameが変わる遅い遷移ではsentinelを再設置しない', async () => {
    mocks.confirm.mockReturnValue(true);
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const routerCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'header-navigation'));
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

  it('router承認後250ms以内にunmountした遷移ではsentinelを再設置せず履歴を汚さない', async () => {
    mocks.confirm.mockReturnValue(true);
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    const routerCleanup = waitForPopStates(1);
    await click(getByTestId(mounted.container, 'header-navigation'));
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

  it('unmount後はdirty離脱listenerとsentinel markerをcleanupする', async () => {
    const mounted = await mountPage();
    await click(getByTestId(mounted.container, 'load-documents'));
    await click(getByTestId(mounted.container, 'select-first'));
    await click(getByTestId(mounted.container, 'mark-dirty'));

    await unmountPage(mounted);
    mocks.confirm.mockClear();
    expect(window.location.pathname).toBe('/documents');
    expect(window.history.state?.__documentsUnsavedChangesGuard).toBeUndefined();
    const beforeUnloadAfterUnmount = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnloadAfterUnmount);
    expect(beforeUnloadAfterUnmount.defaultPrevented).toBe(false);

    const traversalAfterUnmount = waitForPopStates(1);
    window.history.back();
    await traversalAfterUnmount;
    expect(window.location.pathname).toBe('/history-origin');
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
    });

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
    });
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

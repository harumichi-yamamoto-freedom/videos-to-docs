// @vitest-environment jsdom

// 文書一覧の定期取得(本文つき最大100件)の負荷制御(#9)を実レンダリングで検証する。
// 非表示タブでは読取をゼロにし、表示中は30秒間隔、復帰時に即時1回取り直す。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcription } from '@/lib/firestore';
import { DOCUMENT_LIST_POLL_INTERVAL_MS, DocumentListSidebar } from './DocumentListSidebar';

const mocks = vi.hoisted(() => ({
  getTranscriptions: vi.fn(),
  deleteTranscription: vi.fn(),
  updateTranscription: vi.fn(),
}));

vi.mock('@/lib/firestore', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/firestore')>();
  return {
    ...actual,
    getTranscriptions: mocks.getTranscriptions,
    deleteTranscription: mocks.deleteTranscription,
    updateTranscription: mocks.updateTranscription,
  };
});

vi.mock('@/lib/firebase', () => ({
  db: { name: 'mock-firestore' },
  auth: { currentUser: null },
  storage: { name: 'mock-storage' },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'user-a' }, loading: false }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}));

const documentFixture: Transcription = {
  id: 'document-a',
  title: '文書A',
  fileName: 'recording.wav',
  text: '本文',
  promptName: '議事録',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T01:00:00.000Z'),
};

const expectedOwnerScope = { ownerId: 'user-a', ownerType: 'user' };

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
}

function resetDocumentVisibility(): void {
  delete (document as { hidden?: boolean }).hidden;
  delete (document as { visibilityState?: string }).visibilityState;
}

async function changeVisibility(hidden: boolean): Promise<void> {
  setDocumentHidden(hidden);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
}

async function advanceBy(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe('DocumentListSidebar 一覧取得の可視性制御', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onListStateChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mocks.getTranscriptions.mockReset();
    mocks.getTranscriptions.mockResolvedValue([documentFixture]);
    onListStateChange = vi.fn();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    resetDocumentVisibility();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <DocumentListSidebar
          onDocumentClick={vi.fn()}
          onListStateChange={onListStateChange}
        />,
      );
    });
  }

  it('非表示タブでは初回取得も定期取得も発生させず、表示に戻った時に1回だけ取り直す', async () => {
    setDocumentHidden(true);
    await mount();
    await advanceBy(DOCUMENT_LIST_POLL_INTERVAL_MS * 3);

    // 非表示の間は本文つき一覧の読取がゼロ(初回取得も表示まで保留)。
    expect(mocks.getTranscriptions).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="文書一覧を読み込み中"]')).not.toBeNull();
    expect(onListStateChange).toHaveBeenLastCalledWith({ status: 'loading' });

    await changeVisibility(false);

    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(1);
    expect(mocks.getTranscriptions).toHaveBeenCalledWith(100, expectedOwnerScope);
    expect(container.querySelector('button[aria-label="「文書A」を選択"]')).not.toBeNull();
    expect(onListStateChange).toHaveBeenLastCalledWith({ status: 'success', count: 1 });

    // 表示に戻った後は通常の周期で取り直す。
    await advanceBy(DOCUMENT_LIST_POLL_INTERVAL_MS);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(2);
  });

  it('表示中は30秒間隔で取り直し、非表示になった瞬間に止まり、復帰時に即時1回取り直して周期を仕切り直す', async () => {
    await mount();
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(1);

    // 間隔の境界: 30秒未満では取り直さず、30秒でちょうど1回。
    await advanceBy(DOCUMENT_LIST_POLL_INTERVAL_MS - 1);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(1);
    await advanceBy(1);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(2);
    expect(DOCUMENT_LIST_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);

    // 非表示になったら、どれだけ時間が経っても読取は増えない。
    await changeVisibility(true);
    await advanceBy(DOCUMENT_LIST_POLL_INTERVAL_MS * 5);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(2);

    // 復帰時は即時に1回取り直し、その時点から周期を数え直す。
    await changeVisibility(false);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(3);
    await advanceBy(DOCUMENT_LIST_POLL_INTERVAL_MS - 1);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(3);
    await advanceBy(1);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(4);
  });

  it('復帰時に取得が飛行中なら重ねて取り直さず、飛行中の結果を待つ', async () => {
    let resolveInitialFetch!: (documents: Transcription[]) => void;
    mocks.getTranscriptions.mockReturnValueOnce(new Promise(resolve => {
      resolveInitialFetch = resolve;
    }));
    await mount();
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(1);

    await changeVisibility(true);
    await changeVisibility(false);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialFetch([documentFixture]);
      await Promise.resolve();
    });
    expect(onListStateChange).toHaveBeenLastCalledWith({ status: 'success', count: 1 });
    await advanceBy(DOCUMENT_LIST_POLL_INTERVAL_MS);
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(2);
  });

  it('unmount後はvisibilitychangeでも周期でも取り直さない', async () => {
    await mount();
    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    await changeVisibility(true);
    await changeVisibility(false);
    await advanceBy(DOCUMENT_LIST_POLL_INTERVAL_MS * 3);

    expect(mocks.getTranscriptions).toHaveBeenCalledTimes(1);
  });
});

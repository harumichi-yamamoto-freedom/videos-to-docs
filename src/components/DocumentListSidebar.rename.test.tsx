// @vitest-environment jsdom

// サイドバー改名の楽観的並行性制御(C3)と、改名continuationの版印捏造防止(C4)を
// 実レンダリングで検証する。関数直呼びハーネスではrefが描画間で持続しないため、
// 「編集開始時に固定した版」を跨いで検査できるのはここだけ。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcription } from '@/lib/firestore';
import { DOCUMENT_LIST_POLL_INTERVAL_MS, DocumentListSidebar } from './DocumentListSidebar';

const mocks = vi.hoisted(() => ({
  getTranscriptions: vi.fn(),
  deleteTranscription: vi.fn(),
  updateTranscription: vi.fn(),
  updateTranscriptionTitle: vi.fn(),
}));

vi.mock('@/lib/firestore', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/firestore')>();
  return {
    ...actual,
    getTranscriptions: mocks.getTranscriptions,
    deleteTranscription: mocks.deleteTranscription,
    updateTranscription: mocks.updateTranscription,
    updateTranscriptionTitle: mocks.updateTranscriptionTitle,
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

const editStartVersion = new Date('2026-09-02T10:00:00.000Z');
const polledVersion = new Date('2026-09-02T10:00:30.000Z');

const documentAtEditStart: Transcription = {
  id: 'document-a',
  title: '文書A',
  fileName: 'recording.wav',
  text: '編集開始時の本文',
  promptName: '議事録',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: editStartVersion,
};

const documentAfterPoll: Transcription = {
  ...documentAtEditStart,
  text: '別writerが更新した本文',
  updatedAt: polledVersion,
};

function findButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`${label} ボタンがありません`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('DocumentListSidebar 改名の楽観的並行性制御', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onDocumentsChange: ReturnType<typeof vi.fn>;
  let onDocumentUpdated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mocks.getTranscriptions.mockReset();
    mocks.getTranscriptions.mockResolvedValue([documentAtEditStart]);
    mocks.deleteTranscription.mockReset();
    mocks.updateTranscription.mockReset();
    mocks.updateTranscription.mockResolvedValue(null);
    mocks.updateTranscriptionTitle.mockReset();
    onDocumentsChange = vi.fn();
    onDocumentUpdated = vi.fn();
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mountAndStartRename(): Promise<void> {
    await act(async () => {
      root.render(
        <DocumentListSidebar
          onDocumentClick={vi.fn()}
          onDocumentsChange={onDocumentsChange}
          onDocumentUpdated={onDocumentUpdated}
        />,
      );
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    await act(async () => {
      findButtonByLabel(container, '「文書A」のタイトルを編集').click();
    });
  }

  async function pollAdvancesToOtherWriter(): Promise<void> {
    const fetchCallsBeforePoll = mocks.getTranscriptions.mock.calls.length;
    mocks.getTranscriptions.mockResolvedValueOnce([documentAfterPoll]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCUMENT_LIST_POLL_INTERVAL_MS);
    });
    // 定期取得が実際に着弾した証人。間隔が伸びて空振りすると、以降の
    // 「版が前進しても」の検査が何も前進していない状態で緑になる。
    expect(mocks.getTranscriptions.mock.calls.length).toBe(fetchCallsBeforePoll + 1);
  }

  async function typeTitleAndSave(nextTitle: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('input[id^="document-title-"]');
    if (!input) throw new Error('タイトル入力がありません');
    await act(async () => {
      setInputValue(input, nextTitle);
    });
    await act(async () => {
      findButtonByLabel(container, 'タイトルを保存').click();
      await Promise.resolve();
    });
  }

  it('改名はポーリングで版が前進しても、編集開始時に固定した版を期待値として渡す', async () => {
    await mountAndStartRename();
    await pollAdvancesToOtherWriter();
    await typeTitleAndSave('改名後のタイトル');

    expect(mocks.updateTranscription).toHaveBeenCalledWith('document-a', {
      title: '改名後のタイトル',
    }, { expectedUpdatedAt: editStartVersion });
    expect(mocks.updateTranscriptionTitle).not.toHaveBeenCalled();
  });

  it('改名成功後に同版の古い読みが来ても「改名後タイトル+他者版印」の捏造ペアを親へ公開しない', async () => {
    await mountAndStartRename();
    await pollAdvancesToOtherWriter();
    const fetchCallsBeforeSave = mocks.getTranscriptions.mock.calls.length;
    // 改名直後の取り直しがcommit前の断面(同じV3)を返す最悪ケース。
    // 行の版印を温存してタイトルだけpatchすると、local参照が同版判定で温存され
    // 「改名後タイトル+V3」の捏造がそのまま親へ公開され続ける。
    mocks.getTranscriptions.mockResolvedValueOnce([documentAfterPoll]);
    await typeTitleAndSave('改名後のタイトル');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onDocumentUpdated).toHaveBeenCalledWith('document-a', {
      title: '改名後のタイトル',
    });
    // 実状態の取り直し(静かな再取得)が走っている。
    expect(mocks.getTranscriptions.mock.calls.length)
      .toBeGreaterThan(fetchCallsBeforeSave);

    const lastPublishedDocuments = onDocumentsChange.mock.calls.at(-1)?.[0] as Transcription[];
    const publishedRow = lastPublishedDocuments.find(row => row.id === 'document-a');
    expect(publishedRow).toBeDefined();
    const isFabricatedPair = publishedRow?.title === '改名後のタイトル'
      && publishedRow?.updatedAt === polledVersion;
    expect(isFabricatedPair).toBe(false);
  });

  it('改名競合後は取り直した最新版が期待値になり、案内どおりの再試行が成功できる', async () => {
    const serverVersion = new Date('2026-09-02T10:01:00.000Z');
    const { TranscriptionConflictError } = await import('@/lib/firestore');
    mocks.updateTranscription
      .mockRejectedValueOnce(new TranscriptionConflictError())
      .mockResolvedValueOnce(null);
    await mountAndStartRename();
    // 競合catchが予約する取り直しは、サーバの最新版(V2)を返す。
    mocks.getTranscriptions.mockResolvedValueOnce([{
      ...documentAtEditStart,
      title: '別の場所で変えたタイトル',
      updatedAt: serverVersion,
    }]);
    await typeTitleAndSave('競合する改名');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // 基準前進は競合表示(+内容確認の案内)とセットでのみ起こる=同意の射程内。
    expect(container.textContent)
      .toContain('他の場所で更新されています。最新の状態を取得しました。内容を確認してから、もう一度お試しください。');

    // 編集は維持されたまま、競合検査の基準が最新版へ前進している。
    await act(async () => {
      findButtonByLabel(container, 'タイトルを保存').click();
      await Promise.resolve();
    });

    expect(mocks.updateTranscription).toHaveBeenNthCalledWith(2, 'document-a', {
      title: '競合する改名',
    }, { expectedUpdatedAt: serverVersion });
  });

  it('競合表示のない失敗では取り直しも基準前進もせず、再試行は編集開始時の版のまま', async () => {
    // 競合経路の無条件な基準前進は「競合を見せた後の再試行」という同意の射程に
    // 限る設計。競合以外の失敗で基準が動くなら、その同意なしに未見版を採り得る。
    mocks.updateTranscription
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce(null);
    await mountAndStartRename();
    await pollAdvancesToOtherWriter();
    const fetchCallsBeforeSave = mocks.getTranscriptions.mock.calls.length;
    await typeTitleAndSave('失敗する改名');

    expect(container.textContent)
      .toContain('タイトルを更新できませんでした。入力内容は保持されています。');
    expect(container.textContent).not.toContain('他の場所で更新されています');
    expect(mocks.getTranscriptions.mock.calls.length).toBe(fetchCallsBeforeSave);

    await act(async () => {
      findButtonByLabel(container, 'タイトルを保存').click();
      await Promise.resolve();
    });
    expect(mocks.updateTranscription).toHaveBeenNthCalledWith(2, 'document-a', {
      title: '失敗する改名',
    }, { expectedUpdatedAt: editStartVersion });
  });

  it('剥がした版印の行から始めた再編集は、自セッションの取り直しで基準が埋まり偽競合しない', async () => {
    const renamedServerVersion = new Date('2026-09-02T10:02:00.000Z');
    mocks.updateTranscription.mockResolvedValue(null);
    await mountAndStartRename();
    // 改名成功が予約する一覧の取り直しを保留し、剥がした版印の窓を再現する。
    let resolveSuccessReload!: (documents: Transcription[]) => void;
    mocks.getTranscriptions.mockReturnValueOnce(new Promise(resolve => {
      resolveSuccessReload = resolve;
    }));
    await typeTitleAndSave('改名後のタイトル');

    // 取り直し着弾前の再編集開始(行は版印なし)。このセッション自身が基準の
    // 種付け取得を予約し、その着弾がサーバ版を基準に据える。
    mocks.getTranscriptions.mockResolvedValueOnce([{
      ...documentAtEditStart,
      title: '改名後のタイトル',
      updatedAt: renamedServerVersion,
    }]);
    await act(async () => {
      findButtonByLabel(container, '「改名後のタイトル」のタイトルを編集').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await typeTitleAndSave('さらに改名');

    expect(mocks.updateTranscription).toHaveBeenNthCalledWith(2, 'document-a', {
      title: 'さらに改名',
    }, { expectedUpdatedAt: renamedServerVersion });

    resolveSuccessReload([{
      ...documentAtEditStart,
      title: 'さらに改名',
      updatedAt: renamedServerVersion,
    }]);
  });

  it('種付け取得が編集開始時と違うタイトルの第三者版を返したら、基準に採らず競合へ流す', async () => {
    // strip窓の再編集中に第三者Wが同じ文書を改名すると、種付け取得はWの版を
    // 積んで着弾する。利用者が一度も見ていないW版を基準に採ると、初回保存が
    // 競合検査素通りでWの改名を無警告上書きする(Fable probe実測)。
    const thirdPartyVersion = new Date('2026-09-02T10:04:00.000Z');
    mocks.updateTranscription.mockResolvedValue(null);
    await mountAndStartRename();
    // 改名成功のsuccess-reloadを保留し、strip窓を開いたままにする。
    let resolveSuccessReload!: (documents: Transcription[]) => void;
    mocks.getTranscriptions.mockReturnValueOnce(new Promise(resolve => {
      resolveSuccessReload = resolve;
    }));
    await typeTitleAndSave('改名後のタイトル');

    // 再編集開始(行はstrip済み)→ 種付け取得が予約されるが、その結果は
    // 第三者Wの改名(タイトルが編集開始時に見ていた値と不一致)。
    mocks.getTranscriptions.mockResolvedValueOnce([{
      ...documentAtEditStart,
      title: 'Wの改名タイトル',
      updatedAt: thirdPartyVersion,
    }]);
    await act(async () => {
      findButtonByLabel(container, '「改名後のタイトル」のタイトルを編集').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await typeTitleAndSave('S2の改名');

    const s2Meta = mocks.updateTranscription.mock.calls[1][2] as {
      expectedUpdatedAt: unknown;
    };
    // 見ていない版を採ればW版=競合素通り。据置(null)ならサーバのW版印と
    // 不一致で正しく競合として止まる。
    expect(s2Meta.expectedUpdatedAt).not.toBe(thirdPartyVersion);
    expect(s2Meta.expectedUpdatedAt).toBeNull();

    resolveSuccessReload([{
      ...documentAtEditStart,
      title: 'Wの改名タイトル',
      updatedAt: thirdPartyVersion,
    }]);
  });

  it('閉じた編集セッションが予約した取り直しは、次のセッションの基準へ別writer版を書き込まない', async () => {
    // ABA: S1改名が競合→S1の取り直しが飛行中→S1を閉じてS2で再編集→別writer版
    // V_tがS1の取り直しで着弾。セッション世代検査が無いと、S2の基準がV_tへ進み
    // S2保存が別writerの変更を無警告上書きする。
    const thirdPartyVersion = new Date('2026-09-02T10:03:00.000Z');
    const { TranscriptionConflictError } = await import('@/lib/firestore');
    mocks.updateTranscription
      .mockRejectedValueOnce(new TranscriptionConflictError())
      .mockResolvedValueOnce(null);
    await mountAndStartRename();

    let resolveConflictReload!: (documents: Transcription[]) => void;
    mocks.getTranscriptions.mockReturnValueOnce(new Promise(resolve => {
      resolveConflictReload = resolve;
    }));
    await typeTitleAndSave('S1の改名');

    // S1を閉じ、S2として同じ文書の編集を開き直す(行は編集開始版のまま)。
    await act(async () => {
      findButtonByLabel(container, 'タイトル編集をキャンセル').click();
    });
    await act(async () => {
      findButtonByLabel(container, '「文書A」のタイトルを編集').click();
    });

    // S1が予約した取り直しが、別writerのV_tを積んで遅れて着弾する。
    await act(async () => {
      resolveConflictReload([{
        ...documentAtEditStart,
        title: '別writerのタイトル',
        updatedAt: thirdPartyVersion,
      }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await typeTitleAndSave('S2の改名');

    const s2Meta = mocks.updateTranscription.mock.calls[1][2] as {
      expectedUpdatedAt: unknown;
    };
    expect(s2Meta.expectedUpdatedAt).not.toBe(thirdPartyVersion);
    expect(s2Meta.expectedUpdatedAt).toBe(editStartVersion);
  });

  it('改名の競合は上書きせず、一覧更新を促すエラーで伝える', async () => {
    const { TranscriptionConflictError } = await import('@/lib/firestore');
    mocks.updateTranscription.mockRejectedValueOnce(new TranscriptionConflictError());
    await mountAndStartRename();
    await typeTitleAndSave('競合する改名');

    expect(container.textContent)
      .toContain('他の場所で更新されています。最新の状態を取得しました。内容を確認してから、もう一度お試しください。');
    // 入力は保持され、編集を続けられる。
    expect(container.querySelector('input[id^="document-title-"]')).not.toBeNull();
    expect(onDocumentUpdated).not.toHaveBeenCalled();
  });
});

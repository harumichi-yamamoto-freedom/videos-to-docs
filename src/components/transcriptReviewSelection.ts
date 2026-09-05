'use client';

/**
 * 要確認候補の「選択」と、パネル ⇄ 本文の移動要求を繋ぐ小さなストア（仕様 B3）。
 *
 * 候補カード（TranscriptReviewPanel）と本文の段落バッジ（transcriptMarkdownComponents）は別コンポーネントで、
 * 間に居る DocumentDetailPanel はテスト都合で新しいフックを足せない（素の関数呼び出しでテストされる）。
 * TranscriptPlayer と同じ「モジュール内シングルトン + useSyncExternalStore」で繋ぐ（同時に開く文書は常に 1 本）。
 *
 * 🔴 状態と要求は文書 ID 付き。別文書へ切り替えた直後に、前文書の要求が新文書の同じ行・同じ ID へ届かないようにする。
 * 🔴 選ぶだけでは音声を再生しない（再生は候補カードの「音声を再生」だけ・仕様 B3）。
 */
import { useSyncExternalStore } from 'react';

export interface TranscriptReviewSelectionSnapshot {
    documentId: string | null;
    /** 選択中の候補（カードの強調と前後移動の基準）。null = 未選択 */
    selectedPhraseId: string | null;
    /** 本文の段落バッジ → パネル: 「この候補のカードを表示してフォーカスせよ」 */
    revealRequest: { phraseId: string; nonce: number } | null;
    /** パネル → 本文: 「この開始行（1 始まり）の段落へ移動せよ」 */
    paragraphRequest: { line: number; nonce: number } | null;
}

type Listener = () => void;

const INITIAL_SNAPSHOT: TranscriptReviewSelectionSnapshot = {
    documentId: null,
    selectedPhraseId: null,
    revealRequest: null,
    paragraphRequest: null,
};

const createTranscriptReviewSelectionStore = () => {
    let state: TranscriptReviewSelectionSnapshot = INITIAL_SNAPSHOT;
    let nonce = 0;
    const listeners = new Set<Listener>();

    const emit = (): void => {
        for (const listener of [...listeners]) listener();
    };
    const set = (next: TranscriptReviewSelectionSnapshot): void => {
        state = next;
        emit();
    };

    return {
        subscribe: (listener: Listener): (() => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: (): TranscriptReviewSelectionSnapshot => state,
        /** カードを選ぶ（フォーカス移動・再生はしない）。段落の移動先の強調は解く */
        select: (documentId: string, phraseId: string | null): void => {
            if (
                state.documentId === documentId
                && state.selectedPhraseId === phraseId
                && state.revealRequest === null
                && state.paragraphRequest === null
            ) return;
            set({ documentId, selectedPhraseId: phraseId, revealRequest: null, paragraphRequest: null });
        },
        /** 本文の段落バッジから。パネルはこの候補を表示（必要なら展開）してフォーカスを渡す */
        reveal: (documentId: string, phraseId: string): void => {
            nonce += 1;
            set({ documentId, selectedPhraseId: phraseId, revealRequest: { phraseId, nonce }, paragraphRequest: null });
        },
        /** カードの「本文の該当段落へ移動」から。本文側の該当段落が 1 回だけ寄せてフォーカスを受ける */
        moveToParagraph: (documentId: string, line: number, phraseId: string): void => {
            nonce += 1;
            set({ documentId, selectedPhraseId: phraseId, revealRequest: null, paragraphRequest: { line, nonce } });
        },
        /**
         * 文書の切替・パネルの破棄。`documentId` を渡すと、その文書の状態だけを捨てる
         * （別文書の状態が既に載っている＝新しい文書側が先に触っている＝なら壊さない）。
         */
        clear: (documentId?: string): void => {
            if (state === INITIAL_SNAPSHOT) return;
            if (documentId !== undefined && state.documentId !== null && state.documentId !== documentId) return;
            set(INITIAL_SNAPSHOT);
        },
        /** テスト用。状態と採番を初期化する */
        reset: (): void => {
            nonce = 0;
            state = INITIAL_SNAPSHOT;
            emit();
        },
    };
};

export const transcriptReviewSelection = createTranscriptReviewSelectionStore();

export const useTranscriptReviewSelection = (): TranscriptReviewSelectionSnapshot =>
    useSyncExternalStore(
        transcriptReviewSelection.subscribe,
        transcriptReviewSelection.getSnapshot,
        transcriptReviewSelection.getSnapshot,
    );

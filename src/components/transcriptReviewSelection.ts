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
 * 🔴 段落への移動要求は「同じ要求を 1 回だけ処理する」。処理済みの採番（`consumedNonce`）をストアで持ち、
 *    本文側の段落が再マウントされても（親の再描画・文書の再表示）同じ要求を再処理しない。
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
    /**
     * 本文側が処理済みの `paragraphRequest.nonce`。null = 未処理。
     * 同じ要求は 1 回だけ処理する（段落の再マウントを跨いで残る。新しい要求は採番が進むので必ず未処理になる）
     */
    consumedNonce: number | null;
}

type Listener = () => void;

const INITIAL_SNAPSHOT: TranscriptReviewSelectionSnapshot = {
    documentId: null,
    selectedPhraseId: null,
    revealRequest: null,
    paragraphRequest: null,
    consumedNonce: null,
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
            set({
                documentId,
                selectedPhraseId: phraseId,
                revealRequest: null,
                paragraphRequest: null,
                consumedNonce: state.consumedNonce,
            });
        },
        /** 本文の段落バッジから。パネルはこの候補を表示（必要なら展開）してフォーカスを渡す */
        reveal: (documentId: string, phraseId: string): void => {
            nonce += 1;
            set({
                documentId,
                selectedPhraseId: phraseId,
                revealRequest: { phraseId, nonce },
                paragraphRequest: null,
                consumedNonce: state.consumedNonce,
            });
        },
        /**
         * カードの「本文の該当段落へ移動」から。本文側の該当段落が 1 回だけ寄せてフォーカスを受ける。
         * 採番を進めるので、直前の要求が処理済み（consumedNonce）でも新しい要求は必ず未処理になる
         */
        moveToParagraph: (documentId: string, line: number, phraseId: string): void => {
            nonce += 1;
            set({
                documentId,
                selectedPhraseId: phraseId,
                revealRequest: null,
                paragraphRequest: { line, nonce },
                consumedNonce: state.consumedNonce,
            });
        },
        /**
         * 本文側が移動要求を処理した印。同じ nonce の要求は以後（段落が再マウントされても）再処理しない。
         * 🔴 要求（paragraphRequest）自体は残す＝移動先の強調は、別の候補を選ぶ／文書を切り替えるまで続く
         */
        consumeParagraphRequest: (nonce: number): void => {
            if (state.consumedNonce === nonce) return;
            set({ ...state, consumedNonce: nonce });
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

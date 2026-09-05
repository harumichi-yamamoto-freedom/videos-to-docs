/**
 * 要確認候補の選択ストア（仕様 B3）の錠。
 * 「同じ移動要求を 1 回だけ処理する」ための処理済み採番（consumedNonce）を中心に見る。
 * fixture は全て合成（架空の文書 ID・架空の phraseId）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transcriptReviewSelection } from './transcriptReviewSelection';

const DOC_A = 'doc-synthetic-a';
const DOC_B = 'doc-synthetic-b';

beforeEach(() => {
    transcriptReviewSelection.reset();
});

afterEach(() => {
    transcriptReviewSelection.reset();
});

describe('移動要求の処理済み採番（consumedNonce）', () => {
    it('初期状態では未処理（null）', () => {
        expect(transcriptReviewSelection.getSnapshot()).toEqual({
            documentId: null, selectedPhraseId: null, revealRequest: null, paragraphRequest: null, consumedNonce: null,
        });
    });

    it('moveToParagraph は未処理の新しい要求を出し、consumeParagraphRequest で処理済みになる', () => {
        transcriptReviewSelection.moveToParagraph(DOC_A, 7, 'p-7');
        const first = transcriptReviewSelection.getSnapshot();
        expect(first.paragraphRequest).toEqual({ line: 7, nonce: 1 });
        expect(first.consumedNonce).toBeNull();

        transcriptReviewSelection.consumeParagraphRequest(1);
        const consumed = transcriptReviewSelection.getSnapshot();
        expect(consumed.consumedNonce).toBe(1);
        // 🔴 要求そのものは残す（移動先の強調は別の候補を選ぶまで続く）
        expect(consumed.paragraphRequest).toEqual({ line: 7, nonce: 1 });
        expect(consumed.selectedPhraseId).toBe('p-7');
    });

    it('同じ nonce を二度 consume しても通知しない（購読側の無駄な再描画を起こさない）', () => {
        transcriptReviewSelection.moveToParagraph(DOC_A, 7, 'p-7');
        transcriptReviewSelection.consumeParagraphRequest(1);
        const listener = vi.fn();
        const unsubscribe = transcriptReviewSelection.subscribe(listener);
        const before = transcriptReviewSelection.getSnapshot();
        transcriptReviewSelection.consumeParagraphRequest(1);
        expect(listener).not.toHaveBeenCalled();
        expect(transcriptReviewSelection.getSnapshot()).toBe(before);
        unsubscribe();
    });

    it('🔴 処理済みの後に出した新しい要求は採番が進み、必ず未処理になる（同じ段落への再ジャンプも含む）', () => {
        transcriptReviewSelection.moveToParagraph(DOC_A, 7, 'p-7');
        transcriptReviewSelection.consumeParagraphRequest(1);

        transcriptReviewSelection.moveToParagraph(DOC_A, 7, 'p-7');
        const again = transcriptReviewSelection.getSnapshot();
        expect(again.paragraphRequest).toEqual({ line: 7, nonce: 2 });
        // 処理済みは据え置き＝新しい nonce(2) と一致しない＝未処理
        expect(again.consumedNonce).toBe(1);
        expect(again.paragraphRequest?.nonce).not.toBe(again.consumedNonce);
    });

    it('select / reveal は要求を消すが処理済み採番は据え置く（次の要求は採番が進むので影響しない）', () => {
        transcriptReviewSelection.moveToParagraph(DOC_A, 7, 'p-7');
        transcriptReviewSelection.consumeParagraphRequest(1);

        transcriptReviewSelection.select(DOC_A, 'p-1');
        expect(transcriptReviewSelection.getSnapshot().paragraphRequest).toBeNull();
        expect(transcriptReviewSelection.getSnapshot().consumedNonce).toBe(1);

        transcriptReviewSelection.reveal(DOC_A, 'p-3');
        expect(transcriptReviewSelection.getSnapshot().revealRequest).toEqual({ phraseId: 'p-3', nonce: 2 });
        expect(transcriptReviewSelection.getSnapshot().paragraphRequest).toBeNull();
        expect(transcriptReviewSelection.getSnapshot().consumedNonce).toBe(1);

        // reveal で採番が進んだ後の移動要求（nonce 3）も未処理
        transcriptReviewSelection.moveToParagraph(DOC_A, 1, 'p-1');
        expect(transcriptReviewSelection.getSnapshot().paragraphRequest).toEqual({ line: 1, nonce: 3 });
        expect(transcriptReviewSelection.getSnapshot().consumedNonce).toBe(1);
    });

    it('select は同じ内容なら通知しない（処理済み採番を含めて状態が同じ）', () => {
        transcriptReviewSelection.select(DOC_A, 'p-1');
        const listener = vi.fn();
        const unsubscribe = transcriptReviewSelection.subscribe(listener);
        transcriptReviewSelection.select(DOC_A, 'p-1');
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('clear（文書の切替・パネルの破棄）と reset で処理済み採番も初期化される', () => {
        transcriptReviewSelection.moveToParagraph(DOC_A, 7, 'p-7');
        transcriptReviewSelection.consumeParagraphRequest(1);

        // 別文書の clear は壊さない
        transcriptReviewSelection.clear(DOC_B);
        expect(transcriptReviewSelection.getSnapshot().consumedNonce).toBe(1);

        transcriptReviewSelection.clear(DOC_A);
        expect(transcriptReviewSelection.getSnapshot()).toEqual({
            documentId: null, selectedPhraseId: null, revealRequest: null, paragraphRequest: null, consumedNonce: null,
        });

        transcriptReviewSelection.moveToParagraph(DOC_A, 3, 'p-3');
        transcriptReviewSelection.consumeParagraphRequest(2);
        transcriptReviewSelection.reset();
        expect(transcriptReviewSelection.getSnapshot().consumedNonce).toBeNull();
        // reset は採番も戻す
        transcriptReviewSelection.moveToParagraph(DOC_A, 3, 'p-3');
        expect(transcriptReviewSelection.getSnapshot().paragraphRequest).toEqual({ line: 3, nonce: 1 });
    });
});

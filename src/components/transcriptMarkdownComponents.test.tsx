// @vitest-environment jsdom

/**
 * 本文段落（transcriptMarkdownComponents）× 再生追従 × 候補ジャンプの錠（仕様 B3「候補移動と追従を区別」）。
 *
 * 🔴 候補ジャンプは追従を「一時停止」するだけで、利用者の永続設定 follow を書き換えない。
 *    書き換える実装（setFollow(false)）には 2 つの回帰があった:
 *    (a) 文書 A でジャンプ → 文書 B へ切替後も追従が戻らない（attach の終了処理は follow を持ち越す）。
 *    (b) ジャンプ effect が段落の再マウントで再発火し、利用者が追従を再開しても再び切られる。
 * fixture は全て合成（架空の会話・架空の ID）。実データ・鍵は使わない。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptPlayer, transcriptPlayback } from './TranscriptPlayer';
import { transcriptReviewSelection } from './transcriptReviewSelection';
import { createTranscriptMarkdownComponents } from './transcriptMarkdownComponents';

// ---------------------------------------------------------------------------
// 合成 fixture
// ---------------------------------------------------------------------------

/** 文書 A（1 行目・3 行目・5 行目=欠落注記・7 行目が段落） */
const TRANSCRIPT_A = [
    '[00:12](#t=12) **お客様** いえ、こちらこそ。',
    '',
    '[00:30](#t=30) **営業** 本日はお時間ありがとうございます。',
    '',
    '　　　⚠ 01:20:00 〜 01:45:00 は文字起こしできませんでした。［再試行］',
    '',
    '[02:00](#t=120) **営業** それでランディの画面なんですけれども。',
].join('\n');
const DOC_A = 'doc-synthetic-a';
const ANCHORS_A: ReadonlyMap<number, readonly string[]> = new Map([
    [1, ['p-1']],
    [3, ['p-3']],
    [7, ['p-7']],
]);

/** 文書 B（別の会話・1 行目・3 行目・5 行目が段落） */
const TRANSCRIPT_B = [
    '[00:12](#t=12) **司会** 別の文書の冒頭です。',
    '',
    '[00:30](#t=30) **参加者** 二つ目の段落です。',
    '',
    '[02:00](#t=120) **司会** 三つ目の段落です。',
].join('\n');
const DOC_B = 'doc-synthetic-b';
const ANCHORS_B: ReadonlyMap<number, readonly string[]> = new Map([
    [1, ['q-1']],
    [3, ['q-3']],
    [5, ['q-5']],
]);

// ---------------------------------------------------------------------------
// 描画の道具
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let scrollIntoView: ReturnType<typeof vi.fn>;

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const originalPlay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play');
const originalPause = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause');

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(async () => undefined) });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn(() => undefined) });
});

afterAll(() => {
    if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
    if (originalPlay) Object.defineProperty(HTMLMediaElement.prototype, 'play', originalPlay);
    else delete (HTMLMediaElement.prototype as Partial<HTMLMediaElement>).play;
    if (originalPause) Object.defineProperty(HTMLMediaElement.prototype, 'pause', originalPause);
    else delete (HTMLMediaElement.prototype as Partial<HTMLMediaElement>).pause;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
    transcriptPlayback.reset();
    transcriptReviewSelection.reset();
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
    transcriptPlayback.reset();
    transcriptReviewSelection.reset();
});

async function render(element: React.ReactNode): Promise<void> {
    await act(async () => {
        root.render(<>{element}</>);
    });
}

async function click(element: Element | null | undefined): Promise<void> {
    if (!element) throw new Error('要素が見つかりません');
    await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

interface ViewOptions {
    documentId: string;
    markdown: string;
    anchors: ReadonlyMap<number, readonly string[]>;
    /** 本文の key。変えると本文（段落）だけが再マウントされる（親の再描画の再現） */
    bodyKey: string;
    /** プレイヤーの key。変えるとプレイヤーが再マウント（attach の終了 → 再 attach）される（文書切替の再現） */
    playerKey: string;
    audioUrl: string;
}

/** 本文（段落バッジ付き）＋プレイヤー。パネルは置かず、移動要求はストアへ直接出す */
function view({ documentId, markdown, anchors, bodyKey, playerKey, audioUrl }: ViewOptions): React.ReactElement {
    return (
        <div>
            <ReactMarkdown
                key={bodyKey}
                remarkPlugins={[remarkGfm]}
                components={createTranscriptMarkdownComponents({
                    markdown,
                    reviewAnchors: { documentId, anchorsByLine: anchors },
                })}
            >
                {markdown}
            </ReactMarkdown>
            <TranscriptPlayer key={playerKey} audioUrl={audioUrl} durationSec={3600} />
        </div>
    );
}

const VIEW_A: ViewOptions = {
    documentId: DOC_A, markdown: TRANSCRIPT_A, anchors: ANCHORS_A,
    bodyKey: 'body-a', playerKey: 'player-a', audioUrl: 'https://example.test/a.m4a',
};
const VIEW_B: ViewOptions = {
    documentId: DOC_B, markdown: TRANSCRIPT_B, anchors: ANCHORS_B,
    bodyKey: 'body-b', playerKey: 'player-b', audioUrl: 'https://example.test/b.m4a',
};

const paragraph = (line: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`p[data-review-line="${line}"]`);
const activeLine = (): string | null =>
    container.querySelector('[data-transcript-active="true"]')?.getAttribute('data-review-line') ?? null;
const followButton = (): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>('button[aria-pressed]');
const playback = () => transcriptPlayback.getSnapshot();
/** scrollIntoView が「どの要素に対して」呼ばれたか（呼び出しの this） */
const scrolledElements = (): unknown[] => scrollIntoView.mock.contexts;

/** 再生位置の更新（音声要素の timeupdate 相当） */
async function tick(sec: number): Promise<void> {
    await act(async () => {
        transcriptPlayback.patch({ currentSec: sec });
    });
}

/** 候補カードの「本文の該当段落へ移動」相当 */
async function jump(documentId: string, line: number, phraseId: string): Promise<void> {
    await act(async () => {
        transcriptReviewSelection.moveToParagraph(documentId, line, phraseId);
    });
}

// ---------------------------------------------------------------------------
// 追従の通常動作
// ---------------------------------------------------------------------------

describe('再生追従の通常動作', () => {
    it('follow ON では再生中の段落へ寄せ、follow OFF では強調だけ続けてスクロールしない', async () => {
        await render(view(VIEW_A));
        expect(playback()).toMatchObject({ ready: true, follow: true, followPausedByJump: false });

        scrollIntoView.mockClear();
        await tick(30);
        expect(activeLine()).toBe('3');
        expect(scrolledElements()).toContain(paragraph(3));

        await click(followButton());
        expect(playback()).toMatchObject({ follow: false, followPausedByJump: false });
        scrollIntoView.mockClear();
        await tick(120);
        expect(activeLine()).toBe('7');
        expect(scrollIntoView).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 候補ジャンプと追従の区別（仕様 B3）
// ---------------------------------------------------------------------------

describe('候補ジャンプと再生追従の区別（仕様 B3）', () => {
    it('🔴 ジャンプは追従を一時停止する: 次の時刻更新で引き戻されず、永続の follow は書き換えない', async () => {
        await render(view(VIEW_A));
        await tick(30);
        expect(activeLine()).toBe('3');

        scrollIntoView.mockClear();
        await jump(DOC_A, 1, 'p-1');
        const target = paragraph(1)!;
        expect(target.getAttribute('data-review-target')).toBe('true');
        expect(document.activeElement).toBe(target);
        // ジャンプ先への 1 回だけ（再生中の 3 行目へは寄せ直さない）
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrolledElements()).toEqual([target]);

        // 🔴 follow は書き換えない（追従トグルは押されたまま）。一時停止だけが立ち、要求は処理済みになる
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: true });
        expect(followButton()?.getAttribute('aria-pressed')).toBe('true');
        const selection = transcriptReviewSelection.getSnapshot();
        expect(selection.paragraphRequest).not.toBeNull();
        expect(selection.consumedNonce).toBe(selection.paragraphRequest?.nonce);

        // 次の時刻更新（120 秒 → 7 行目が再生中）でも、ジャンプ先から引き戻されない
        scrollIntoView.mockClear();
        await tick(120);
        expect(activeLine()).toBe('7');
        expect(scrollIntoView).not.toHaveBeenCalled();
        // 再生中の強調とジャンプ先の強調は別の段落に別の色で付く
        expect(paragraph(7)?.className).toContain('bg-purple-50/70');
        expect(target.className).toContain('ring-amber-400');
        expect(target.getAttribute('data-transcript-active')).toBeNull();
    });

    it('追従トグルで一時停止が解ける（OFF は永続設定として止まり、ON で再生中の段落へ戻る）', async () => {
        await render(view(VIEW_A));
        await tick(30);
        await jump(DOC_A, 1, 'p-1');
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: true });

        // 1 回目: 追従 OFF（永続設定）。一時停止も解ける
        await click(followButton());
        expect(playback()).toMatchObject({ follow: false, followPausedByJump: false });
        scrollIntoView.mockClear();
        await tick(120);
        expect(activeLine()).toBe('7');
        expect(scrollIntoView).not.toHaveBeenCalled();

        // 2 回目: 追従 ON → 再生中の段落へ寄せる
        scrollIntoView.mockClear();
        await click(followButton());
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: false });
        expect(scrolledElements()).toContain(paragraph(7));
    });

    it('シーク（時刻リンク＝利用者が再生位置を動かした）で一時停止が解け、追従に戻る', async () => {
        await render(view(VIEW_A));
        await tick(30);
        await jump(DOC_A, 1, 'p-1');
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: true });

        scrollIntoView.mockClear();
        await click(container.querySelector('a[data-timestamp-sec="120"]'));
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: false, currentSec: 120 });
        expect(activeLine()).toBe('7');
        expect(scrolledElements()).toContain(paragraph(7));
    });

    it('別の候補への新しいジャンプ（採番が進む）は処理され、追従を再び一時停止する', async () => {
        await render(view(VIEW_A));
        await tick(30);
        await jump(DOC_A, 1, 'p-1');
        // 追従を再開（OFF → ON）
        await click(followButton());
        await click(followButton());
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: false });

        scrollIntoView.mockClear();
        await jump(DOC_A, 7, 'p-7');
        expect(document.activeElement).toBe(paragraph(7));
        expect(scrolledElements()).toContain(paragraph(7));
        expect(paragraph(7)?.getAttribute('data-review-target')).toBe('true');
        expect(paragraph(1)?.getAttribute('data-review-target')).toBeNull();
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: true });
        const selection = transcriptReviewSelection.getSnapshot();
        expect(selection.consumedNonce).toBe(selection.paragraphRequest?.nonce);
    });

    // 回帰(a): setFollow(false) 版では follow=false が attach の終了処理で持ち越され、文書 B でも追従が戻らなかった
    it('🔴 回帰(a): 文書 A でジャンプ → 文書 B へ切替（プレイヤー再 attach）→ B の通常再生で追従が効く', async () => {
        await render(view(VIEW_A));
        await tick(30);
        expect(activeLine()).toBe('3');
        await jump(DOC_A, 1, 'p-1');
        expect(document.activeElement).toBe(paragraph(1));
        // ジャンプ中は追従が止まっている（A の時刻更新では寄せない）
        scrollIntoView.mockClear();
        await tick(120);
        expect(activeLine()).toBe('7');
        expect(scrollIntoView).not.toHaveBeenCalled();

        // 文書 B へ切替: パネルは破棄時に A の選択・要求を捨て（TranscriptReviewPanel の cleanup と同じ）、
        // 本文とプレイヤーは key が変わって再マウント（プレイヤーの attach 終了 → 再 attach）
        scrollIntoView.mockClear();
        await act(async () => {
            transcriptReviewSelection.clear(DOC_A);
            root.render(<>{view(VIEW_B)}</>);
        });
        expect(container.querySelector('p[data-review-line="5"]')?.textContent).toContain('三つ目の段落');
        // 🔴 一時停止は文書切替で解け、永続の follow は保持される
        expect(playback()).toMatchObject({ ready: true, follow: true, followPausedByJump: false, currentSec: 0 });
        expect(container.querySelector('[data-review-target]')).toBeNull();
        expect(scrollIntoView).not.toHaveBeenCalled();

        // B の通常再生: 追従が効く
        await tick(30);
        expect(activeLine()).toBe('3');
        expect(container.querySelector('[data-transcript-active="true"]')?.textContent).toContain('二つ目の段落');
        expect(scrolledElements()).toContain(paragraph(3));
    });

    // 回帰(b): 依存 [targetNonce] だけのジャンプ effect は段落の再マウントで再発火し、setFollow(false) で追従を再び切っていた
    it('🔴 回帰(b): ジャンプ → 追従を再開 → 段落の再マウントで同じ要求が残っていても、追従を再び止めず再処理しない', async () => {
        await render(view(VIEW_A));
        await tick(30);
        await jump(DOC_A, 1, 'p-1');
        expect(document.activeElement).toBe(paragraph(1));
        const nonce = transcriptReviewSelection.getSnapshot().paragraphRequest?.nonce ?? null;
        expect(nonce).not.toBeNull();
        // ジャンプ中は追従が止まっている
        scrollIntoView.mockClear();
        await tick(120);
        expect(activeLine()).toBe('7');
        expect(scrollIntoView).not.toHaveBeenCalled();

        // 利用者が追従を ON にする（追従トグル相当）→ 再生中の 7 行目へ寄せる
        scrollIntoView.mockClear();
        await act(async () => {
            transcriptPlayback.setFollow(true);
        });
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: false });
        expect(scrolledElements()).toContain(paragraph(7));

        // 親の再描画で本文（段落）が再マウントされる。移動要求（同じ nonce）はストアに残ったまま
        scrollIntoView.mockClear();
        await render(view({ ...VIEW_A, bodyKey: 'body-a-remounted' }));
        expect(transcriptReviewSelection.getSnapshot().paragraphRequest?.nonce).toBe(nonce);

        // 🔴 同じ要求を再処理しない: 追従は再び止められず（follow も一時停止も動かない）、ジャンプ先へのフォーカス・寄せも起こさない
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: false });
        expect(document.activeElement).not.toBe(paragraph(1));
        expect(scrolledElements()).not.toContain(paragraph(1));
        expect(transcriptReviewSelection.getSnapshot().consumedNonce).toBe(nonce);
        // 移動先の強調自体は残る（別の候補を選ぶ／文書を切り替えるまで）
        expect(paragraph(1)?.getAttribute('data-review-target')).toBe('true');

        // 追従は生きている: 次の時刻更新で再生中の段落へ寄せる
        scrollIntoView.mockClear();
        await tick(30);
        expect(activeLine()).toBe('3');
        expect(scrolledElements()).toContain(paragraph(3));
        expect(playback()).toMatchObject({ follow: true, followPausedByJump: false });
    });
});

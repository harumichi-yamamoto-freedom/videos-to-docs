// @vitest-environment jsdom

/**
 * 「要確認箇所」パネル（仕様 B3）の錠。
 * fixture は全て合成（架空の会話・架空の ID）。実データ・鍵は使わない。
 */
import { createHash } from 'node:crypto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAudioDownloadURL } = vi.hoisted(() => ({
    getAudioDownloadURL: vi.fn<(path: string) => Promise<string>>(),
}));
vi.mock('@/lib/storage', () => ({ getAudioDownloadURL }));

// 🔴 hashTranscriptText だけを差し替え可能な形にする（他は実物のまま）。
//    「照合前はバッジ無し」を観測するテストは、crypto.subtle の解決が act の flush に入るか否かの
//    時間依存でフレークになる。そのテストだけ、解決タイミングを手で制御できる deferred に差し替える。
vi.mock('@/lib/transcriptDocument', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/transcriptDocument')>();
    return { ...actual, hashTranscriptText: vi.fn(actual.hashTranscriptText) };
});

/** テスト用の手動解決 Promise（モジュール直下・どの describe からも使える） */
function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

import type { ReviewCandidate, TranscriptReview } from '@/lib/transcriptReviewContract';
import { hashTranscriptText, reviewAnchorsByLine } from '@/lib/transcriptDocument';
import { TranscriptPlayer, transcriptPlayback } from './TranscriptPlayer';
import { transcriptReviewSelection } from './transcriptReviewSelection';
import { createTranscriptMarkdownComponents } from './transcriptMarkdownComponents';
import { TranscriptAudioBar, TranscriptAwareMarkdown } from './TranscriptDocumentView';
import {
    REVIEW_PAGE_SIZE,
    TranscriptReviewPanel,
    describeReviewAudioStatus,
    describeReviewReasons,
    describeUnavailableReason,
    formatConfidence,
    formatReviewTimeRange,
    speakTimestamp,
    type TranscriptReviewPanelProps,
} from './TranscriptReviewPanel';

// ---------------------------------------------------------------------------
// 合成 fixture
// ---------------------------------------------------------------------------

/** 生成 Markdown（1 行目・3 行目・5 行目=欠落注記・7 行目が段落） */
const TRANSCRIPT = [
    '[00:12](#t=12) **お客様** いえ、こちらこそ。',
    '',
    '[00:30](#t=30) **営業** 本日はお時間ありがとうございます。',
    '',
    '　　　⚠ 01:20:00 〜 01:45:00 は文字起こしできませんでした。［再試行］',
    '',
    '[02:00](#t=120) **営業** それでランディの画面なんですけれども。',
].join('\n');

const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const DOC_ID = 'doc-synthetic-1';

const CANDIDATES: ReviewCandidate[] = [
    // 保存順はわざと時刻順にしない（UI 側で並べ直すことの錠）
    {
        phraseId: 'p-7', reasons: ['low_confidence'], excerpt: 'それでランディの画面なんですけれども', excerptTruncated: false,
        confidence: 0.62, recognitionStatus: 'Success', speaker: '営業', startSec: 120.4, endSec: 123.9, paragraphStartLine: 7,
    },
    {
        phraseId: 'p-9', reasons: ['recognition_status'], excerpt: '', excerptTruncated: false,
        recognitionStatus: 'NoMatch', speaker: 'お客様',
    },
    {
        phraseId: 'p-1', reasons: ['low_confidence', 'unknown_confidence'], excerpt: 'いえ、こちらこそ', excerptTruncated: false,
        confidence: 0.4, speaker: 'お客様', startSec: 12.2, endSec: 14, paragraphStartLine: 1,
    },
    {
        phraseId: 'p-3', reasons: ['low_confidence'], excerpt: 'ほ'.repeat(300), excerptTruncated: true,
        confidence: 0.7, recognitionStatus: 'Success', speaker: '営業', startSec: 30, endSec: 31, paragraphStartLine: 3,
    },
];

const review = (overrides: Partial<TranscriptReview> = {}): TranscriptReview => ({
    version: 1,
    threshold: 0.75,
    sourceTextHash: sha256(TRANSCRIPT),
    sourceJobId: 'job-synthetic-1',
    summary: {
        totalPhrases: 12, lowConfidence: 3, recognitionFlagged: 1, candidateTotal: 4,
        unknownConfidence: 0, unknownRecognitionStatus: 0, noTimeCandidates: 1, savedCandidates: 4,
    },
    availability: 'complete',
    candidates: CANDIDATES,
    ...overrides,
});

const manyCandidates = (count: number): ReviewCandidate[] =>
    Array.from({ length: count }, (_, index) => ({
        phraseId: `m-${index}`,
        reasons: ['low_confidence'] as ReviewCandidate['reasons'],
        excerpt: `候補 ${index}`,
        excerptTruncated: false,
        confidence: 0.5,
        startSec: index * 10,
        endSec: index * 10 + 5,
    }));

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
    getAudioDownloadURL.mockReset();
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

/** 本文ハッシュの非同期計算を待つ（同じ本文はキャッシュされた同じ Promise） */
async function settleHash(text: string): Promise<void> {
    await act(async () => {
        await hashTranscriptText(text);
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

async function click(element: Element | null | undefined): Promise<void> {
    if (!element) throw new Error('要素が見つかりません');
    await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

function findButton(text: string, scope: ParentNode = container): HTMLButtonElement | null {
    return Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.trim() === text) ?? null;
}

function panelProps(overrides: Partial<TranscriptReviewPanelProps> = {}): TranscriptReviewPanelProps {
    return {
        documentId: DOC_ID,
        review: review(),
        bodyText: TRANSCRIPT,
        bodyState: 'view',
        canEdit: true,
        onEditBody: vi.fn(),
        ...overrides,
    };
}

const panel = (): HTMLElement | null => container.querySelector('[data-testid="transcript-review-panel"]');
const toggle = (): HTMLButtonElement | null => container.querySelector('button[aria-expanded]');
const cards = (): HTMLLIElement[] => Array.from(container.querySelectorAll<HTMLLIElement>('li[data-review-card]'));
const card = (phraseId: string): HTMLLIElement | null => container.querySelector(`li[data-review-card="${phraseId}"]`);
const playButton = (phraseId: string): HTMLButtonElement | null =>
    card(phraseId)?.querySelector<HTMLButtonElement>('button[aria-label$="音声を再生"], button[aria-label="音声を再生（時刻情報なし）"]') ?? null;
const moveButton = (phraseId: string): HTMLButtonElement | null => findButton('本文の該当段落へ移動', card(phraseId) ?? container);

async function renderExpanded(overrides: Partial<TranscriptReviewPanelProps> = {}): Promise<TranscriptReviewPanelProps> {
    const props = panelProps(overrides);
    await render(<TranscriptReviewPanel {...props} />);
    await click(toggle());
    return props;
}

// ---------------------------------------------------------------------------
// 文言（純関数）
// ---------------------------------------------------------------------------

describe('文言の純関数', () => {
    it('理由ラベルは「要確認（…）」で、複数は「・」区切り。未知の理由コードは読み飛ばす', () => {
        expect(describeReviewReasons(['low_confidence'])).toBe('要確認（低信頼）');
        expect(describeReviewReasons(['low_confidence', 'unknown_confidence'])).toBe('要確認（低信頼・認識状態不明）');
        expect(describeReviewReasons(['recognition_status', 'empty_text'])).toBe('要確認（認識結果を確認・認識テキストなし）');
        expect(describeReviewReasons(['future_reason' as never])).toBe('要確認');
        expect(describeReviewReasons(undefined)).toBe('要確認');
        expect(describeReviewReasons('low_confidence' as never)).toBe('要確認');
    });

    it('時刻表示は整数秒の見た目・内部は小数秒。時刻なしは「時刻情報なし」', () => {
        expect(formatReviewTimeRange(120.4, 123.9)).toBe('02:00〜02:03');
        expect(formatReviewTimeRange(12.2, 12.9)).toBe('00:12');
        expect(formatReviewTimeRange(12, undefined)).toBe('00:12');
        expect(formatReviewTimeRange(null, 5)).toBe('時刻情報なし');
        expect(speakTimestamp(754)).toBe('12分34秒');
        expect(speakTimestamp(3723.4)).toBe('1時間2分3秒');
    });

    it('信頼度は数値のときだけ小数 2 桁。％や「正答率」にしない', () => {
        expect(formatConfidence(0.62)).toBe('0.62');
        expect(formatConfidence(undefined)).toBeNull();
        expect(formatConfidence(Number.NaN)).toBeNull();
    });

    it('unavailable の理由コードは短い注記に、未知コードはコードのまま添える', () => {
        expect(describeUnavailableReason('no_phrases')).toContain('句が無く');
        expect(describeUnavailableReason('storage_budget')).toContain('保存上限');
        expect(describeUnavailableReason('internal_error')).toContain('作成に失敗');
        expect(describeUnavailableReason('mystery')).toContain('理由コード: mystery');
        expect(describeUnavailableReason(undefined)).toBe('信頼度情報を保存できませんでした。');
    });

    it('音声の状態文言: 読み込み中・再生不可・再生拒否。ready と none は無言', () => {
        expect(describeReviewAudioStatus({ audio: 'loading', playbackBlocked: false })).toContain('音声を読み込んでいます');
        expect(describeReviewAudioStatus({ audio: 'unavailable', playbackBlocked: false }))
            .toBe('音声を再生できません。本文の確認・編集はできます。');
        expect(describeReviewAudioStatus({ audio: 'ready', playbackBlocked: true })).toContain('プレイヤーの再生ボタン');
        expect(describeReviewAudioStatus({ audio: 'ready', playbackBlocked: false })).toBeNull();
        expect(describeReviewAudioStatus({ audio: 'none', playbackBlocked: false })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 状態の出し分け（仕様 B3 の表）
// ---------------------------------------------------------------------------

describe('状態の出し分け', () => {
    it('🔴 review の無い旧文書: 「信頼度情報がありません」。候補 0 件・評価済みに見せない・操作ボタンを出さない', async () => {
        await render(<TranscriptReviewPanel {...panelProps({ review: undefined })} />);
        const text = panel()?.textContent ?? '';
        expect(panel()?.getAttribute('data-review-state')).toBe('missing');
        expect(text).toContain('この文書には信頼度情報がありません');
        expect(text).toContain('候補が 0 件という意味ではありません');
        expect(text).not.toContain('生成時の候補');
        expect(text).not.toContain('自動判定の要確認候補はありません');
        expect(container.querySelector('button')).toBeNull();
    });

    it('🔴 availability=unavailable: summary の数字を描かず、理由に応じた短い注記', async () => {
        await render(<TranscriptReviewPanel {...panelProps({
            review: review({
                availability: 'unavailable', unavailableReason: 'storage_budget', candidates: [],
                summary: { ...review().summary, candidateTotal: 99 },
            }),
        })} />);
        const text = panel()?.textContent ?? '';
        expect(panel()?.getAttribute('data-review-state')).toBe('unavailable');
        expect(text).toContain('信頼度情報がありません');
        expect(text).toContain('保存上限');
        expect(text).not.toContain('99');
        expect(text).not.toContain('生成時の候補');
    });

    it('🔴 評価済みで候補 0 件: 「自動判定の要確認候補はありません。内容の正確さを保証するものではありません。」', async () => {
        await render(<TranscriptReviewPanel {...panelProps({
            review: review({ candidates: [], summary: { ...review().summary, candidateTotal: 0, savedCandidates: 0 } }),
        })} />);
        const text = panel()?.textContent ?? '';
        expect(text).toContain('要確認箇所：生成時の候補 0 箇所');
        expect(text).toContain('自動判定の要確認候補はありません。内容の正確さを保証するものではありません。');
        expect(text).not.toContain('問題なし');
        expect(toggle()).toBeNull();
    });

    it('未評価句がある: 信頼度／認識状態不明の件数を添え、0 件でも「全句に問題なし」としない', async () => {
        await render(<TranscriptReviewPanel {...panelProps({
            review: review({
                candidates: [],
                summary: { ...review().summary, candidateTotal: 0, savedCandidates: 0, unknownConfidence: 2, unknownRecognitionStatus: 1 },
            }),
        })} />);
        const text = panel()?.textContent ?? '';
        expect(text).toContain('信頼度不明 2 句・認識状態不明 1 句');
        expect(text).toContain('全句に問題が無いという意味ではありません');
    });

    it('見出しは「生成時の候補 N 箇所」（「残り N」ではない）＋断定しない説明。既定は折りたたみ', async () => {
        await render(<TranscriptReviewPanel {...panelProps()} />);
        const text = panel()?.textContent ?? '';
        expect(text).toContain('要確認箇所：生成時の候補 4 箇所');
        expect(text).toContain('音声認識の信頼度などをもとにした候補です。誤りと断定するものではありません。');
        expect(text).not.toContain('残り');
        expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
        const regionId = toggle()?.getAttribute('aria-controls');
        expect(regionId).toBeTruthy();
        expect(document.getElementById(regionId!)?.hidden).toBe(true);

        await click(toggle());
        expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
        expect(document.getElementById(regionId!)?.hidden).toBe(false);
    });

    it('partial: 「候補 N 箇所のうち先頭 K 箇所を表示しています」', async () => {
        await render(<TranscriptReviewPanel {...panelProps({
            review: review({ availability: 'partial', summary: { ...review().summary, candidateTotal: 30, savedCandidates: 4 } }),
        })} />);
        expect(panel()?.textContent).toContain('候補 30 箇所のうち先頭 4 箇所を表示しています。');
        expect(panel()?.textContent).toContain('生成時の候補 30 箇所');
    });
});

// ---------------------------------------------------------------------------
// 候補カード
// ---------------------------------------------------------------------------

describe('候補カード', () => {
    it('時刻順（時刻なしは末尾）。見出しに候補番号・時刻・話者・理由。抜粋は引用として強調', async () => {
        await renderExpanded();
        expect(cards().map(element => element.getAttribute('data-review-card'))).toEqual(['p-1', 'p-3', 'p-7', 'p-9']);

        const first = card('p-1')!;
        const heading = first.querySelector('h4')!;
        expect(heading.textContent).toContain('候補 1 / 4');
        expect(heading.textContent).toContain('00:12〜00:14');
        expect(heading.textContent).toContain('話者 お客様');
        expect(heading.textContent).toContain('要確認（低信頼・認識状態不明）');
        expect(first.getAttribute('aria-labelledby')).toBe(heading.id);
        expect(first.tabIndex).toBe(-1);

        const excerpt = first.querySelector('[data-review-excerpt]')!;
        expect(excerpt.textContent).toContain('「いえ、こちらこそ」');
        expect(excerpt.className).toContain('bg-amber-50');
    });

    it('抜粋が省略されていれば省略と分かる注記、無ければ「認識テキストなし」', async () => {
        await renderExpanded();
        expect(card('p-3')?.querySelector('[data-review-excerpt]')?.textContent).toContain('抜粋は上限で省略しています');
        expect(card('p-9')?.querySelector('[data-review-excerpt]')?.textContent).toContain('認識テキストなし');
    });

    it('confidence は詳細を開いたときだけ「認識信頼度 0.62（判定の参考値…）」。％や正答率にしない', async () => {
        await renderExpanded();
        const details = card('p-7')?.querySelector('details');
        expect(details).not.toBeNull();
        expect(details?.textContent).toContain('認識信頼度');
        expect(details?.textContent).toContain('0.62（判定の参考値');
        expect(details?.textContent).toContain('認識状態');
        expect(details?.textContent).toContain('Success');
        expect(card('p-7')?.textContent).not.toContain('%');
        expect(card('p-7')?.textContent).not.toContain('正答率');
        // 見出し側（詳細の外）には数値を出さない
        expect(card('p-7')?.querySelector('h4')?.textContent).not.toContain('0.62');
    });

    it('🔴 時刻不明の候補: 「時刻情報なし」。再生と本文移動は無効、抜粋は出る', async () => {
        transcriptPlayback.setAudio('ready');
        await settleHash(TRANSCRIPT);
        await renderExpanded();
        await settleHash(TRANSCRIPT);
        const noTime = card('p-9')!;
        expect(noTime.querySelector('h4')?.textContent).toContain('時刻情報なし');
        expect(playButton('p-9')?.disabled).toBe(true);
        expect(playButton('p-9')?.title).toContain('時刻情報がないため');
        expect(moveButton('p-9')?.disabled).toBe(true);
        expect(noTime.querySelector('[data-review-excerpt]')).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 音声（既存の seek 経路へ接続・状態の出し分け）
// ---------------------------------------------------------------------------

describe('音声の再生', () => {
    it('🔴 音声 ready のとき「[mm:ss]から音声を再生」は既存 seek 経路で小数秒を渡す。選択だけでは再生しない', async () => {
        await render(
            <div>
                <TranscriptReviewPanel {...panelProps()} />
                <TranscriptPlayer audioUrl="https://example.test/synthetic.m4a" durationSec={600} />
            </div>,
        );
        expect(transcriptPlayback.getSnapshot().audio).toBe('loading');
        await act(async () => {
            container.querySelector('audio')!.dispatchEvent(new Event('loadedmetadata'));
        });
        expect(transcriptPlayback.getSnapshot().audio).toBe('ready');
        await click(toggle());

        // 選ぶだけ（フォーカス）では再生しない
        await act(async () => {
            card('p-1')!.focus();
        });
        expect(transcriptReviewSelection.getSnapshot().selectedPhraseId).toBe('p-1');
        expect(transcriptPlayback.getSnapshot().playing).toBe(false);
        expect(transcriptPlayback.getSnapshot().currentSec).toBe(0);

        const button = playButton('p-1')!;
        expect(button.disabled).toBe(false);
        expect(button.textContent).toContain('00:12から音声を再生');
        expect(button.getAttribute('aria-label')).toBe('0分12秒から音声を再生');
        await click(button);
        expect(transcriptPlayback.getSnapshot().currentSec).toBe(12.2);
        expect(transcriptPlayback.getSnapshot().playing).toBe(true);
        // 見た目は整数秒（jsdom の音声要素は duration を持たないので総尺は見ない）
        expect(container.querySelector('[data-testid="transcript-player-time"]')?.textContent).toMatch(/^00:12 \//);
    });

    it('🔴 音声の読み込み中: 「音声を読み込んでいます」・再生ボタンは無効', async () => {
        transcriptPlayback.setAudio('loading');
        await renderExpanded();
        expect(container.querySelector('[data-testid="transcript-review-audio-note"]')?.textContent)
            .toContain('音声を読み込んでいます');
        expect(playButton('p-1')?.disabled).toBe(true);
        expect(playButton('p-1')?.title).toBe('音声を読み込んでいます');
    });

    it('🔴 音声なし・URL 取得失敗・ロード失敗: 「音声を再生できません。本文の確認・編集はできます。」', async () => {
        transcriptPlayback.setAudio('unavailable', 'url_failed');
        await renderExpanded();
        expect(container.querySelector('[data-testid="transcript-review-audio-note"]')?.textContent)
            .toBe('音声を再生できません。本文の確認・編集はできます。');
        expect(playButton('p-1')?.disabled).toBe(true);
        // 本文移動・抜粋・編集導線は残る
        expect(card('p-1')?.querySelector('[data-review-excerpt]')).not.toBeNull();
        expect(findButton('本文を編集')).not.toBeNull();
    });

    it('再生がブラウザに拒否された: 再生済みに見せず、プレイヤーの操作を案内する', async () => {
        transcriptPlayback.setAudio('ready');
        transcriptPlayback.patch({ playbackBlocked: true, playing: false });
        await renderExpanded();
        expect(container.querySelector('[data-testid="transcript-review-audio-note"]')?.textContent)
            .toContain('プレイヤーの再生ボタン');
    });

    it('時刻を持つ候補が無ければ音声の注記を出さない', async () => {
        transcriptPlayback.setAudio('unavailable', 'no_audio');
        await renderExpanded({ review: review({ candidates: [CANDIDATES[1]], summary: { ...review().summary, candidateTotal: 1 } }) });
        expect(container.querySelector('[data-testid="transcript-review-audio-note"]')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 本文との照合（ハッシュ）と編集の扱い
// ---------------------------------------------------------------------------

describe('本文との照合', () => {
    it('🔴 表示本文のハッシュが一致: 「本文の該当段落へ移動」が有効になり、押すと段落への移動要求が出る', async () => {
        await renderExpanded();
        await settleHash(TRANSCRIPT);
        expect(container.querySelector('[data-testid="transcript-review-anchor-note"]')).toBeNull();
        expect(moveButton('p-1')?.disabled).toBe(false);
        expect(moveButton('p-7')?.disabled).toBe(false);

        await click(moveButton('p-7'));
        const snapshot = transcriptReviewSelection.getSnapshot();
        expect(snapshot.documentId).toBe(DOC_ID);
        expect(snapshot.selectedPhraseId).toBe('p-7');
        expect(snapshot.paragraphRequest?.line).toBe(7);
    });

    it('🔴 ハッシュ不一致（編集済み）: 「本文は編集されています。以下は生成時の要確認候補です。」。移動は無効、抜粋と再生は残る', async () => {
        transcriptPlayback.setAudio('ready');
        const edited = `${TRANSCRIPT}\n\n[03:00](#t=180) **営業** 追記した段落。`;
        await renderExpanded({ bodyText: edited });
        await settleHash(edited);
        expect(container.querySelector('[data-testid="transcript-review-anchor-note"]')?.textContent)
            .toBe('本文は編集されています。以下は生成時の要確認候補です。');
        expect(moveButton('p-1')?.disabled).toBe(true);
        expect(moveButton('p-1')?.title).toContain('本文が編集されている');
        expect(playButton('p-1')?.disabled).toBe(false);
        expect(card('p-1')?.querySelector('[data-review-excerpt]')?.textContent).toContain('いえ、こちらこそ');
        expect(panel()?.textContent).toContain('生成時の候補 4 箇所');
    });

    it('🔴 編集モード中: 本文アンカーを無効化し、確定後に照合すると案内。「本文を編集」は出さない', async () => {
        await renderExpanded({ bodyState: 'editing' });
        await settleHash(TRANSCRIPT);
        expect(container.querySelector('[data-testid="transcript-review-anchor-note"]')?.textContent)
            .toContain('本文を編集中です');
        expect(moveButton('p-1')?.disabled).toBe(true);
        expect(moveButton('p-1')?.title).toContain('編集中は本文へ移動できません');
        expect(findButton('本文を編集')).toBeNull();
    });

    it('アンカーの無い候補は一致していても移動できない（推測しない）', async () => {
        await renderExpanded();
        await settleHash(TRANSCRIPT);
        expect(moveButton('p-9')?.disabled).toBe(true);
        expect(moveButton('p-9')?.title).toContain('生成時に確定していません');
    });

    // Major3: paragraphStartLine はあるが時刻が無効（startSec===null）な候補（PR2 で音声長超の句は
    // 時刻が除去されつつアンカーは付与され得る）。B3「時刻不明は再生と本文移動を無効」。
    it('🔴 段落アンカーはあるが時刻が無い候補: ハッシュ一致でも本文移動は無効（再生も無効）', async () => {
        transcriptPlayback.setAudio('ready');
        const anchoredNoTime: ReviewCandidate = {
            phraseId: 'p-anchored-notime',
            reasons: ['recognition_status'],
            excerpt: '時刻は消えたが段落は分かる句',
            excerptTruncated: false,
            recognitionStatus: 'NoMatch',
            speaker: '営業',
            paragraphStartLine: 7,
            // startSec なし（時刻情報のない候補）
        };
        await renderExpanded({ review: review({ candidates: [CANDIDATES[2], anchoredNoTime] }) });
        await settleHash(TRANSCRIPT);

        // 時刻あり＋アンカーあり＋ハッシュ一致（p-1）は従来どおり移動できる
        expect(moveButton('p-1')?.disabled).toBe(false);

        // アンカーはあるが時刻なし: 再生も本文移動も無効。理由を「時刻なし」と分けて表示する
        expect(card('p-anchored-notime')?.querySelector('h4')?.textContent).toContain('時刻情報なし');
        expect(playButton('p-anchored-notime')?.disabled).toBe(true);
        const move = moveButton('p-anchored-notime');
        expect(move?.disabled).toBe(true);
        expect(move?.title).toContain('時刻情報がないため');
    });

    it('sourceTextHash の無い壊れた review では移動を出さないが候補は読める', async () => {
        await renderExpanded({ review: review({ sourceTextHash: '' }) });
        await settleHash(TRANSCRIPT);
        expect(moveButton('p-1')?.disabled).toBe(true);
        expect(cards()).toHaveLength(4);
    });
});

// ---------------------------------------------------------------------------
// 操作: 前後移動・さらに表示・本文を編集・閲覧専用
// ---------------------------------------------------------------------------

describe('操作', () => {
    it('前の候補／次の候補: 選択とフォーカスが移り、端では無効。選択だけでは再生しない', async () => {
        transcriptPlayback.setAudio('ready');
        await renderExpanded();
        const previous = findButton('前の候補')!;
        const next = findButton('次の候補')!;
        expect(previous.disabled).toBe(true);
        expect(next.disabled).toBe(false);

        await click(next);
        expect(transcriptReviewSelection.getSnapshot().selectedPhraseId).toBe('p-1');
        expect(document.activeElement).toBe(card('p-1'));
        expect(card('p-1')?.getAttribute('aria-current')).toBe('true');
        expect(findButton('前の候補')?.disabled).toBe(true);

        await click(findButton('次の候補'));
        expect(document.activeElement).toBe(card('p-3'));
        expect(card('p-1')?.getAttribute('aria-current')).toBeNull();
        expect(findButton('前の候補')?.disabled).toBe(false);

        await click(findButton('次の候補'));
        await click(findButton('次の候補'));
        expect(document.activeElement).toBe(card('p-9'));
        expect(findButton('次の候補')?.disabled).toBe(true);

        await click(findButton('前の候補'));
        expect(document.activeElement).toBe(card('p-7'));
        expect(transcriptPlayback.getSnapshot().playing).toBe(false);
    });

    it('長い一覧は 20 件ずつ「さらに表示」。次の候補への移動は必要なカードを展開する', async () => {
        const total = 45;
        await renderExpanded({
            review: review({ candidates: manyCandidates(total), summary: { ...review().summary, candidateTotal: total, savedCandidates: total } }),
        });
        expect(cards()).toHaveLength(REVIEW_PAGE_SIZE);
        const more = findButton(`さらに表示（残り ${total - REVIEW_PAGE_SIZE} 件）`);
        expect(more).not.toBeNull();
        await click(more);
        expect(cards()).toHaveLength(REVIEW_PAGE_SIZE * 2);
        await click(findButton(`さらに表示（残り ${total - REVIEW_PAGE_SIZE * 2} 件）`));
        expect(cards()).toHaveLength(total);
        expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('さらに表示'))).toBe(false);
    });

    it('表示範囲の末尾を選んだ状態で「次の候補」を押すと、次のカードが展開されてフォーカスを受ける', async () => {
        const total = 45;
        await renderExpanded({
            review: review({ candidates: manyCandidates(total), summary: { ...review().summary, candidateTotal: total, savedCandidates: total } }),
        });
        await act(async () => {
            transcriptReviewSelection.select(DOC_ID, `m-${REVIEW_PAGE_SIZE - 1}`);
        });
        expect(card(`m-${REVIEW_PAGE_SIZE}`)).toBeNull();
        await click(findButton('次の候補'));
        expect(card(`m-${REVIEW_PAGE_SIZE}`)).not.toBeNull();
        expect(document.activeElement).toBe(card(`m-${REVIEW_PAGE_SIZE}`));
        expect(cards()).toHaveLength(REVIEW_PAGE_SIZE + 1);
    });

    it('「本文を編集」は既存の全文編集へ渡す（onEditBody）。閲覧専用（canEdit=false）では出さない', async () => {
        const props = await renderExpanded();
        await click(findButton('本文を編集'));
        expect(props.onEditBody).toHaveBeenCalledTimes(1);

        await render(<TranscriptReviewPanel {...panelProps({ canEdit: false })} />);
        await click(toggle());
        expect(findButton('本文を編集')).toBeNull();
        // 確認・再生の操作は残る
        expect(cards()).toHaveLength(4);
        expect(playButton('p-1')).not.toBeNull();
    });

    it('🔴 文書を切り替える（パネルが破棄される）と、その文書の候補選択・移動要求は捨てられる', async () => {
        await renderExpanded();
        await settleHash(TRANSCRIPT);
        await click(findButton('次の候補'));
        await click(moveButton('p-1'));
        expect(transcriptReviewSelection.getSnapshot().selectedPhraseId).toBe('p-1');
        expect(transcriptReviewSelection.getSnapshot().paragraphRequest).not.toBeNull();

        await render(<TranscriptReviewPanel key="other" {...panelProps({ documentId: 'doc-synthetic-2', review: undefined })} />);
        expect(transcriptReviewSelection.getSnapshot()).toEqual({
            documentId: null, selectedPhraseId: null, revealRequest: null, paragraphRequest: null, consumedNonce: null,
        });
    });
});

// ---------------------------------------------------------------------------
// 本文（段落バッジ）との往復
// ---------------------------------------------------------------------------

describe('本文の段落バッジとの往復', () => {
    const anchors = () => ({ documentId: DOC_ID, anchorsByLine: reviewAnchorsByLine(CANDIDATES) });

    function bodyAndPanel(): React.ReactElement {
        return (
            <div>
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={createTranscriptMarkdownComponents({ markdown: TRANSCRIPT, reviewAnchors: anchors() })}
                >
                    {TRANSCRIPT}
                </ReactMarkdown>
                <TranscriptReviewPanel {...panelProps()} />
            </div>
        );
    }

    it('アンカーのある段落だけに「要確認 N 箇所」バッジ（選択不可・印刷非表示）。段落全体を誤り扱いしない', async () => {
        await render(bodyAndPanel());
        const badges = Array.from(container.querySelectorAll<HTMLElement>('[data-review-badge]'));
        expect(badges.map(badge => badge.getAttribute('data-review-badge'))).toEqual(['1', '3', '7']);
        expect(badges[0].className).toContain('select-none');
        expect(badges[0].className).toContain('print:hidden');
        expect(badges[0].textContent).toBe('要確認 1 箇所');
        expect(container.querySelector('p[data-review-line="3"]')?.textContent).not.toContain('誤り');
        // 時刻リンクの段落自体は tabIndex=-1 で移動先になれる
        expect(container.querySelector<HTMLElement>('p[data-review-line="7"]')?.tabIndex).toBe(-1);
    });

    it('🔴 段落バッジ → パネルが展開し、該当カードにフォーカスと選択が移る（再生はしない）', async () => {
        transcriptPlayback.setAudio('ready');
        await render(bodyAndPanel());
        expect(toggle()?.getAttribute('aria-expanded')).toBe('false');

        await click(container.querySelector('[data-review-badge="7"] button'));
        expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(card('p-7'));
        expect(card('p-7')?.getAttribute('aria-current')).toBe('true');
        expect(transcriptPlayback.getSnapshot().playing).toBe(false);
    });

    it('🔴 「本文の該当段落へ移動」→ 段落がフォーカスを受けて寄せられ、再生中の紫とは別の強調が付く', async () => {
        await render(bodyAndPanel());
        await click(toggle());
        await settleHash(TRANSCRIPT);
        scrollIntoView.mockClear();

        await click(moveButton('p-7'));
        const paragraph = container.querySelector<HTMLElement>('p[data-review-line="7"]')!;
        expect(document.activeElement).toBe(paragraph);
        expect(paragraph.getAttribute('data-review-target')).toBe('true');
        expect(paragraph.className).toContain('ring-amber-400');
        expect(paragraph.className).not.toContain('bg-purple-50/70');
        expect(paragraph.getAttribute('data-transcript-active')).toBeNull();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        // 他の段落は移動先にならない
        expect(container.querySelector('p[data-review-line="1"]')?.getAttribute('data-review-target')).toBeNull();

        // 別の候補を選ぶと移動先の強調は解ける
        await act(async () => {
            card('p-1')!.focus();
        });
        expect(paragraph.getAttribute('data-review-target')).toBeNull();
    });

    // Major2: 再生追従中に候補へジャンプ → 次の時刻更新で追従がジャンプ先から引き戻す不具合。
    // B3「候補移動と再生中段落の追従を区別」。ジャンプで追従を「一時停止」し（🔴 永続の follow は書き換えない。
    // 書き換えると文書切替後も追従が戻らず、再開しても段落の再マウントで再び切られる）、利用者の明示操作（追従トグル・シーク）で戻す。
    // 一時停止の解除・段落の再マウント・文書切替の錠は transcriptMarkdownComponents.test.tsx。
    it('🔴 再生追従中に候補へジャンプ→次の時刻更新で引き戻されない（追従を一時停止・follow は書き換えない・「音声を再生」で戻る）', async () => {
        await render(
            <div>
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={createTranscriptMarkdownComponents({ markdown: TRANSCRIPT, reviewAnchors: anchors() })}
                >
                    {TRANSCRIPT}
                </ReactMarkdown>
                <TranscriptReviewPanel {...panelProps()} />
                <TranscriptPlayer audioUrl="https://example.test/a.m4a" durationSec={3600} />
            </div>,
        );
        await click(toggle());
        await settleHash(TRANSCRIPT);
        // 音声要素がメタデータを読めた＝候補カードの「音声を再生」が押せる
        await act(async () => {
            container.querySelector('audio')!.dispatchEvent(new Event('loadedmetadata'));
        });
        expect(transcriptPlayback.getSnapshot().audio).toBe('ready');

        // 追従中: 30 秒 → 3 行目が現在行としてスクロール追従する
        await act(async () => {
            transcriptPlayback.patch({ currentSec: 30 });
        });
        expect(container.querySelector('[data-transcript-active="true"]')?.getAttribute('data-review-line')).toBe('3');

        // 候補 p-1（1 行目）へ移動＝ジャンプ。ジャンプ先へ寄せ、フォーカスは維持し、以後の追従は一時停止
        scrollIntoView.mockClear();
        await click(moveButton('p-1'));
        const target = container.querySelector<HTMLElement>('p[data-review-line="1"]')!;
        expect(target.getAttribute('data-review-target')).toBe('true');
        expect(document.activeElement).toBe(target);
        expect(scrollIntoView).toHaveBeenCalledTimes(1); // ジャンプの 1 回だけ
        // 🔴 永続の follow は書き換えない（追従トグルは押されたまま）。一時停止だけが立つ
        expect(transcriptPlayback.getSnapshot()).toMatchObject({ follow: true, followPausedByJump: true });
        expect(container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('true');

        // 次の時刻更新（120 秒 → 7 行目が現在行）でも、ジャンプ先から引き戻されない
        scrollIntoView.mockClear();
        await act(async () => {
            transcriptPlayback.patch({ currentSec: 120 });
        });
        expect(container.querySelector('[data-transcript-active="true"]')?.getAttribute('data-review-line')).toBe('7');
        expect(scrollIntoView).not.toHaveBeenCalled();

        // 候補カードの「音声を再生」（＝シーク: 利用者が再生位置を動かした）で一時停止が解け、通常の追従に戻る
        scrollIntoView.mockClear();
        await click(playButton('p-3'));
        expect(transcriptPlayback.getSnapshot()).toMatchObject({ follow: true, followPausedByJump: false, currentSec: 30 });
        expect(container.querySelector('[data-transcript-active="true"]')?.getAttribute('data-review-line')).toBe('3');
        expect(scrollIntoView).toHaveBeenCalled();
    });

    it('別文書の移動要求には反応しない（文書 ID で照合）', async () => {
        await render(bodyAndPanel());
        scrollIntoView.mockClear();
        await act(async () => {
            transcriptReviewSelection.moveToParagraph('doc-synthetic-other', 7, 'p-7');
        });
        expect(container.querySelector('p[data-review-line="7"]')?.getAttribute('data-review-target')).toBeNull();
        expect(scrollIntoView).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// TranscriptAwareMarkdown: ハッシュ一致のときだけ段落バッジ
// ---------------------------------------------------------------------------

describe('TranscriptAwareMarkdown の段落バッジ', () => {
    it('🔴 表示本文のハッシュが review.sourceTextHash と一致するときだけバッジを描く', async () => {
        // このテストだけの本文（他のテストでハッシュがキャッシュ済みだと「照合前」を観測できない）
        const body = `${TRANSCRIPT}\n\n[04:00](#t=240) **営業** 照合テスト用の固有の段落。`;
        const matching = review({ sourceTextHash: sha256(body) });
        // 🔴 「照合前」を決定的に観測するため、最初のハッシュ計算だけ手動解決の Promise に差し替える。
        //    実 crypto.subtle は act の flush に入るか否かで解決タイミングが揺れ、「照合前はバッジ無し」がフレークになる。
        const pending = makeDeferred<string>();
        vi.mocked(hashTranscriptText).mockReturnValueOnce(pending.promise);
        await render(<TranscriptAwareMarkdown markdown={body} documentId={DOC_ID} review={matching} />);
        // 照合前はバッジ無し（ハッシュは保留中で決定的）
        expect(container.querySelector('[data-review-badge]')).toBeNull();
        await act(async () => { pending.resolve(sha256(body)); await pending.promise; });
        expect(container.querySelectorAll('[data-review-badge]')).toHaveLength(3);

        // 編集後（不一致）は実装の実ハッシュで照合（mockOnce は消費済み＝以降は実物）
        const edited = body.replace('こちらこそ', 'こちらこそ、');
        await render(<TranscriptAwareMarkdown markdown={edited} documentId={DOC_ID} review={matching} />);
        await settleHash(edited);
        expect(container.querySelector('[data-review-badge]')).toBeNull();
        // 時刻リンク自体は引き続き動く
        expect(container.querySelector('a[data-timestamp-sec="12"]')).not.toBeNull();
    });

    it('documentId が無ければ照合しない（バッジ無し）', async () => {
        await render(<TranscriptAwareMarkdown markdown={TRANSCRIPT} review={review()} />);
        await settleHash(TRANSCRIPT);
        expect(container.querySelector('[data-review-badge]')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// TranscriptAudioBar: URL 取得の loading / 失敗 / 再試行 / メディアエラー
// ---------------------------------------------------------------------------

describe('TranscriptAudioBar の音声状態', () => {
    const audioDocument = { text: TRANSCRIPT, audioStoragePath: 'audio/synthetic-user/synthetic.m4a' };

    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
        let resolve!: (value: T) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    it('🔴 URL 取得中は loading（帯は「読み込んでいます」）、取得できたらプレイヤーが載る', async () => {
        const pending = deferred<string>();
        getAudioDownloadURL.mockReturnValueOnce(pending.promise);
        await render(<TranscriptAudioBar document={audioDocument} />);
        expect(transcriptPlayback.getSnapshot().audio).toBe('loading');
        expect(container.querySelector('[data-testid="transcript-audio-status"]')?.textContent).toContain('音声を読み込んでいます');
        expect(container.querySelector('[data-testid="transcript-player"]')).toBeNull();

        await act(async () => {
            pending.resolve('https://example.test/synthetic.m4a');
            await pending.promise;
        });
        expect(container.querySelector('[data-testid="transcript-player"]')).not.toBeNull();
        expect(container.querySelector('audio')?.getAttribute('src')).toBe('https://example.test/synthetic.m4a');
        // 音声要素はまだメタデータを読めていない
        expect(transcriptPlayback.getSnapshot().audio).toBe('loading');
        await act(async () => {
            container.querySelector('audio')!.dispatchEvent(new Event('loadedmetadata'));
        });
        expect(transcriptPlayback.getSnapshot().audio).toBe('ready');
    });

    it('🔴 URL 取得失敗: 「音声を再生できません」と再試行。再試行は URL の再取得だけ（submit は呼ばない）', async () => {
        getAudioDownloadURL.mockRejectedValueOnce(new Error('storage/object-not-found'));
        await render(<TranscriptAudioBar document={audioDocument} />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(transcriptPlayback.getSnapshot().audio).toBe('unavailable');
        expect(transcriptPlayback.getSnapshot().audioReason).toBe('url_failed');
        const strip = container.querySelector('[data-testid="transcript-audio-status"]');
        expect(strip?.textContent).toContain('音声を再生できません。本文の確認・編集はできます。');
        expect(getAudioDownloadURL).toHaveBeenCalledTimes(1);

        getAudioDownloadURL.mockResolvedValueOnce('https://example.test/synthetic.m4a');
        await click(findButton('音声の取得を再試行'));
        await act(async () => {
            await Promise.resolve();
        });
        expect(getAudioDownloadURL).toHaveBeenCalledTimes(2);
        expect(getAudioDownloadURL).toHaveBeenLastCalledWith(audioDocument.audioStoragePath);
        expect(container.querySelector('[data-testid="transcript-player"]')).not.toBeNull();
    });

    it('音声要素のロード失敗: プレイヤーを状態表示に差し替え、再試行できる', async () => {
        getAudioDownloadURL.mockResolvedValue('https://example.test/synthetic.m4a');
        await render(<TranscriptAudioBar document={audioDocument} />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(container.querySelector('audio')).not.toBeNull();

        await act(async () => {
            container.querySelector('audio')!.dispatchEvent(new Event('error'));
        });
        expect(container.querySelector('[data-testid="transcript-player"]')).toBeNull();
        expect(container.querySelector('[data-testid="transcript-audio-status"]')?.textContent).toContain('音声を再生できません');
        expect(transcriptPlayback.getSnapshot().audio).toBe('unavailable');
        expect(transcriptPlayback.getSnapshot().audioReason).toBe('media_failed');

        await click(findButton('音声の取得を再試行'));
        await act(async () => {
            await Promise.resolve();
        });
        expect(container.querySelector('[data-testid="transcript-player"]')).not.toBeNull();
        expect(getAudioDownloadURL).toHaveBeenCalledTimes(2);
    });

    it('文字起こしだが音声参照が無い: 帯は出さず、状態は unavailable（no_audio）', async () => {
        await render(<TranscriptAudioBar document={{ text: TRANSCRIPT }} />);
        expect(container.innerHTML).toBe('');
        expect(transcriptPlayback.getSnapshot().audio).toBe('unavailable');
        expect(transcriptPlayback.getSnapshot().audioReason).toBe('no_audio');
        expect(getAudioDownloadURL).not.toHaveBeenCalled();
    });

    it('🔴 時刻リンクの無い通常の文書では何もしない（音声があっても）', async () => {
        await render(<TranscriptAudioBar document={{ text: '# 議事録\n\n本文。', audioStoragePath: 'audio/u/a.mp3' }} />);
        expect(container.innerHTML).toBe('');
        expect(transcriptPlayback.getSnapshot().audio).toBe('none');
        expect(getAudioDownloadURL).not.toHaveBeenCalled();
    });

    it('時刻リンクが消えた本文でも review に有効時刻があれば音声 UI を出す', async () => {
        getAudioDownloadURL.mockResolvedValue('https://example.test/synthetic.m4a');
        await render(<TranscriptAudioBar document={{ text: '編集で時刻リンクを全部消した本文。', audioStoragePath: 'audio/u/a.mp3', transcriptReview: review() }} />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(container.querySelector('[data-testid="transcript-player"]')).not.toBeNull();
    });

    it('🔴 別文書へ切り替えたら前文書の音声は載せず、状態も新文書のものに置き直す', async () => {
        const first = deferred<string>();
        getAudioDownloadURL.mockReturnValueOnce(first.promise);
        await render(<TranscriptAudioBar document={audioDocument} />);

        const second = deferred<string>();
        getAudioDownloadURL.mockReturnValueOnce(second.promise);
        await render(<TranscriptAudioBar document={{ ...audioDocument, audioStoragePath: 'audio/synthetic-user/other.m4a' }} />);
        expect(transcriptPlayback.getSnapshot().audio).toBe('loading');

        // 前文書の URL が遅れて届いても載せない
        await act(async () => {
            first.resolve('https://example.test/first.m4a');
            await first.promise;
        });
        expect(container.querySelector('audio')).toBeNull();

        await act(async () => {
            second.resolve('https://example.test/other.m4a');
            await second.promise;
        });
        expect(container.querySelector('audio')?.getAttribute('src')).toBe('https://example.test/other.m4a');
    });
});

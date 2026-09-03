// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptPlayer, transcriptPlayback } from './TranscriptPlayer';
import {
    collectTranscriptSpeakers,
    countSpeakerLabelOccurrences,
    createTranscriptMarkdownComponents,
    parseClockDisplay,
    renameSpeakerLabel,
} from './transcriptMarkdownComponents';

const TRANSCRIPT = [
    '[00:12](#t=12) **お客様** いえ、こちらこそ。',
    '',
    '[00:30](#t=30) **営業** 本日はお時間ありがとうございます。',
    '',
    '　　　⚠ 01:20:00 〜 01:45:00 は文字起こしできませんでした。［再試行］',
    '',
    '[02:00](#t=120) **営業** それでランディの画面なんですけれども。',
].join('\n');

let container: HTMLDivElement;
let root: Root;
let scrollIntoView: ReturnType<typeof vi.fn>;

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollIntoView',
);
const originalPlay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play');
const originalPause = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause');

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
        configurable: true,
        value: vi.fn(async () => undefined),
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
        configurable: true,
        value: vi.fn(() => undefined),
    });
});

afterAll(() => {
    if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
        delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    if (originalPlay) {
        Object.defineProperty(HTMLMediaElement.prototype, 'play', originalPlay);
    } else {
        delete (HTMLMediaElement.prototype as Partial<HTMLMediaElement>).play;
    }
    if (originalPause) {
        Object.defineProperty(HTMLMediaElement.prototype, 'pause', originalPause);
    } else {
        delete (HTMLMediaElement.prototype as Partial<HTMLMediaElement>).pause;
    }
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
    transcriptPlayback.reset();
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: scrollIntoView,
    });
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
});

async function render(element: React.ReactNode): Promise<void> {
    await act(async () => {
        root.render(<>{element}</>);
    });
}

function transcriptView(
    markdown: string,
    options: {
        audioUrl?: string | null;
        onRename?: (from: string, to: string) => void;
        onRetryGap?: (gap: { startSec: number; endSec: number }) => void;
    } = {},
): React.ReactElement {
    const { audioUrl, onRename, onRetryGap } = options;
    return (
        <div>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={createTranscriptMarkdownComponents({ markdown, onRename, onRetryGap })}
            >
                {markdown}
            </ReactMarkdown>
            <TranscriptPlayer audioUrl={audioUrl} durationSec={3600} />
        </div>
    );
}

function findByText(selector: string, text: string): HTMLElement | null {
    return (
        Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
            candidate => candidate.textContent?.trim() === text,
        ) ?? null
    );
}

async function click(element: Element | null): Promise<void> {
    if (!element) throw new Error('要素が見つかりません');
    await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

describe('TranscriptPlayer', () => {
    // 🔴 回帰の錠: 音声が無い文書の見た目を 1px も変えない
    it('音声が無い文書では何も描画しない', async () => {
        await render(<TranscriptPlayer audioUrl={undefined} />);
        expect(container.innerHTML).toBe('');

        await render(<TranscriptPlayer audioUrl={null} />);
        expect(container.innerHTML).toBe('');

        await render(<TranscriptPlayer audioUrl="   " />);
        expect(container.innerHTML).toBe('');
    });

    it('音声がある文書では、下部固定の細い帯として出る', async () => {
        await render(<TranscriptPlayer audioUrl="https://example.test/a.m4a" durationSec={125} />);
        const bar = container.querySelector('[data-testid="transcript-player"]');
        expect(bar).not.toBeNull();
        expect(bar?.className).toContain('sticky');
        expect(bar?.className).toContain('bottom-0');
        // 印刷・PDF には出さない（既存の出力を変えない）
        expect(bar?.className).toContain('print:hidden');
        expect(container.querySelector('[data-testid="transcript-player-time"]')?.textContent)
            .toBe('00:00 / 02:05');
        expect(container.querySelector('input[aria-label="再生位置"]')).not.toBeNull();
    });

    it('再生と一時停止を切り替えられる', async () => {
        await render(<TranscriptPlayer audioUrl="https://example.test/a.m4a" durationSec={60} />);
        await click(container.querySelector('button[aria-label="再生"]'));
        expect(transcriptPlayback.getSnapshot().playing).toBe(true);
        await click(container.querySelector('button[aria-label="一時停止"]'));
        expect(transcriptPlayback.getSnapshot().playing).toBe(false);
    });
});

describe('時刻リンク', () => {
    it('#t=12 のリンクはクリックで再生位置が変わる', async () => {
        await render(transcriptView(TRANSCRIPT, { audioUrl: 'https://example.test/a.m4a' }));
        const link = container.querySelector<HTMLAnchorElement>('a[data-timestamp-sec="12"]');
        expect(link).not.toBeNull();
        expect(link?.textContent).toBe('00:12');

        await click(link);

        expect(transcriptPlayback.getSnapshot().currentSec).toBe(12);
        expect(container.querySelector('[data-testid="transcript-player-time"]')?.textContent)
            .toBe('00:12 / 1:00:00');
    });

    it('通常のリンクは既存の挙動のまま', async () => {
        const markdown = '[会社の案内](https://example.com/about) を見てください。';
        await render(transcriptView(markdown, { audioUrl: 'https://example.test/a.m4a' }));
        const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/about"]');
        expect(link).not.toBeNull();
        expect(link?.className).toBe('text-blue-600 hover:text-blue-800 underline');
        expect(link?.getAttribute('target')).toBe('_blank');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link?.getAttribute('data-timestamp-sec')).toBeNull();
    });

    it('壊れた #t= は例外にならず、クリックできないだけ', async () => {
        const markdown = '[??:??](#t=あ) **営業** 編集で壊れた行。';
        await expect(
            render(transcriptView(markdown, { audioUrl: 'https://example.test/a.m4a' })),
        ).resolves.toBeUndefined();

        const broken = container.querySelector('[data-timestamp="broken"]');
        expect(broken).not.toBeNull();
        expect(broken?.tagName).toBe('SPAN');
        expect(container.querySelector('a[data-timestamp-sec]')).toBeNull();

        await click(broken);
        expect(transcriptPlayback.getSnapshot().currentSec).toBe(0);
    });

    it('音声が無い文書では時刻リンクを押しても何も起きない', async () => {
        await render(transcriptView(TRANSCRIPT, { audioUrl: null }));
        await click(container.querySelector('a[data-timestamp-sec="12"]'));
        expect(transcriptPlayback.getSnapshot().currentSec).toBe(0);
        expect(transcriptPlayback.getSnapshot().ready).toBe(false);
    });
});

describe('再生中の行の追従', () => {
    it('再生中の行を淡くハイライトし、スクロールで追従する', async () => {
        await render(transcriptView(TRANSCRIPT, { audioUrl: 'https://example.test/a.m4a' }));
        scrollIntoView.mockClear();

        await act(async () => {
            transcriptPlayback.seek(30);
        });

        const active = container.querySelector('[data-transcript-active="true"]');
        expect(active?.textContent).toContain('本日はお時間ありがとうございます。');
        expect(active?.className).toContain('bg-purple-50/70');
        expect(scrollIntoView).toHaveBeenCalled();
    });

    it('追従を止められる', async () => {
        await render(transcriptView(TRANSCRIPT, { audioUrl: 'https://example.test/a.m4a' }));

        const followButton = container.querySelector<HTMLButtonElement>('button[aria-pressed]');
        expect(followButton?.getAttribute('aria-pressed')).toBe('true');
        await click(followButton);
        expect(
            container.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed'),
        ).toBe('false');

        scrollIntoView.mockClear();
        await act(async () => {
            transcriptPlayback.seek(120);
        });

        // 行のハイライトは続くが、勝手にスクロールはしない
        expect(container.querySelector('[data-transcript-active="true"]')?.textContent)
            .toContain('ランディの画面');
        expect(scrollIntoView).not.toHaveBeenCalled();
    });
});

describe('話者ラベルの改名', () => {
    it('その場で入力でき、変更箇所数が事前に出て、onRename が呼ばれる', async () => {
        const onRename = vi.fn();
        await render(transcriptView(TRANSCRIPT, { audioUrl: 'https://example.test/a.m4a', onRename }));

        const label = findByText('button', '営業');
        expect(label).not.toBeNull();
        await click(label);

        // 別画面・モーダルへ飛ばさず、その場で入力欄になる
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        const input = container.querySelector<HTMLInputElement>('input[aria-label="話者「営業」の名前"]');
        expect(input).not.toBeNull();

        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
            )?.set;
            setter?.call(input, '田中');
            input?.dispatchEvent(new Event('input', { bubbles: true }));
        });

        // 適用前に「何箇所が変わるか」を見せる（本文の営業は 2 箇所）
        expect(container.textContent).toContain('2箇所が変わります');
        expect(onRename).not.toHaveBeenCalled();

        await click(findByText('button', '変更'));
        expect(onRename).toHaveBeenCalledTimes(1);
        expect(onRename).toHaveBeenCalledWith('営業', '田中');
    });

    it('取り消せる（キャンセルでは onRename を呼ばない）', async () => {
        const onRename = vi.fn();
        await render(transcriptView(TRANSCRIPT, { audioUrl: 'https://example.test/a.m4a', onRename }));

        await click(findByText('button', 'お客様'));
        await click(findByText('button', 'キャンセル'));

        expect(onRename).not.toHaveBeenCalled();
        expect(container.querySelector('input[aria-label="話者「お客様」の名前"]')).toBeNull();
        expect(findByText('button', 'お客様')).not.toBeNull();
    });

    it('onRename が無ければ、話者ラベルはただの強調のまま', async () => {
        await render(transcriptView(TRANSCRIPT, { audioUrl: 'https://example.test/a.m4a' }));
        expect(findByText('button', '営業')).toBeNull();
        expect(findByText('strong', '営業')).not.toBeNull();
    });
});

describe('欠落の注記', () => {
    it('事実として置かれ、再試行を押せる', async () => {
        const onRetryGap = vi.fn();
        await render(transcriptView(TRANSCRIPT, { audioUrl: 'https://example.test/a.m4a', onRetryGap }));

        const note = Array.from(container.querySelectorAll('p')).find(candidate =>
            candidate.textContent?.includes('文字起こしできませんでした'),
        );
        expect(note).not.toBeNull();
        // 赤や感嘆符で埋めない
        expect(note?.className).toContain('text-gray-500');
        expect(note?.className).not.toContain('red');

        await click(findByText('button', '再試行'));
        expect(onRetryGap).toHaveBeenCalledWith({ startSec: 4800, endSec: 6300 });
    });
});

describe('本文の読み取り（純関数）', () => {
    it('話者ラベルを出現順に拾う', () => {
        expect(collectTranscriptSpeakers(TRANSCRIPT)).toEqual(['お客様', '営業']);
        expect(collectTranscriptSpeakers('')).toEqual([]);
    });

    it('改名の影響箇所を数える', () => {
        expect(countSpeakerLabelOccurrences(TRANSCRIPT, '営業')).toBe(2);
        expect(countSpeakerLabelOccurrences(TRANSCRIPT, 'お客様')).toBe(1);
        expect(countSpeakerLabelOccurrences(TRANSCRIPT, '居ない人')).toBe(0);
    });

    it('話者位置だけを置換し、本文中の同じ語には触らない', () => {
        const markdown = '[00:00](#t=0) **営業** 営業の話をします。';
        expect(renameSpeakerLabel(markdown, '営業', '田中')).toBe(
            '[00:00](#t=0) **田中** 営業の話をします。',
        );
        expect(renameSpeakerLabel(markdown, '営業', '営業')).toBe(markdown);
        expect(renameSpeakerLabel(markdown, '営業', '')).toBe(markdown);
    });

    it('時刻表示を秒に戻す（読めなければ null）', () => {
        expect(parseClockDisplay('00:12')).toBe(12);
        expect(parseClockDisplay('1:20:00')).toBe(4800);
        expect(parseClockDisplay('あ:い')).toBeNull();
        expect(parseClockDisplay('12')).toBeNull();
    });
});

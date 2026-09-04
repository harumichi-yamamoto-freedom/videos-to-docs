/**
 * 文字起こしの配線が、**文字起こし以外の文書に一切影響しない**ことの錠。
 *
 * 🔴 これが本命の回帰テスト。
 * `audioStoragePath` は「音声から生成したすべての文書」に入っているので、
 * それを条件にプレイヤーを出すと**既存の議事録文書の見た目が変わる**。
 * 条件は「本文に時刻リンクがあるか」でなければならない（設計 §6.5-3）。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// TranscriptDocumentView は storage 経由で firebase を引くので、SDK 初期化だけ差し替える
vi.mock('@/lib/storage', () => ({
    getAudioDownloadURL: vi.fn(async () => 'https://example.com/a.mp3'),
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { TranscriptPlayer } from './TranscriptPlayer';
import { TranscriptAwareMarkdown } from './TranscriptDocumentView';
import { createTranscriptMarkdownComponents } from './transcriptMarkdownComponents';
import { MarkdownDocument } from './MarkdownDocument';
import { parseTranscriptTimestamps } from '@/lib/transcriptMerge';
import { shouldEnableTranscriptUi } from '@/lib/transcriptDocument';

/** 通常の議事録（音声から生成されたが、時刻リンクは持たない） */
const ORDINARY_DOCUMENT = `# 商談メモ

## 要約
土地探しと資金計画について打ち合わせた。

- 予算はおよそ1億2,000万円
- 次回までに資金計画を提出する

詳しくは [社内資料](https://example.com/doc) を参照。
`;

/** 文字起こし文書（時刻リンクを持つ） */
const TRANSCRIPT_DOCUMENT = `[00:00](#t=0) **営業** 本日はお忙しい中ありがとうございます。

[00:12](#t=12) **お客様** いえ、こちらこそ。
`;

describe('配線の条件は「音声の有無」ではなく「時刻リンクの有無」', () => {
    it('🔴 通常の議事録には時刻リンクが無く、上書きの対象にならない', () => {
        expect(parseTranscriptTimestamps(ORDINARY_DOCUMENT)).toHaveLength(0);
    });

    it('文字起こし文書には時刻リンクがある', () => {
        expect(parseTranscriptTimestamps(TRANSCRIPT_DOCUMENT).length).toBeGreaterThan(0);
    });

    it('🔴 音声を持つ通常の議事録は対象外 — audioStoragePath を条件にしていないことの錠', () => {
        // これが本命。誰かが判定を「音声があるか」に変えると、この 1 件が落ちる。
        const ordinaryWithAudio = {
            id: 'doc-1', title: 'メモ', fileName: 'a.mp3', promptName: '議事録',
            text: ORDINARY_DOCUMENT, audioStoragePath: 'audio/user-1/a.mp3',
        } as Parameters<typeof shouldEnableTranscriptUi>[0];
        expect(shouldEnableTranscriptUi(ordinaryWithAudio)).toBe(false);
    });

    it('音声を持たない文字起こし文書は対象 — 条件は本文であって音声ではない', () => {
        const transcriptWithoutAudio = {
            id: 'doc-2', title: '文字起こし', fileName: 'b.mp3', promptName: '全文文字起こし',
            text: TRANSCRIPT_DOCUMENT,
        } as Parameters<typeof shouldEnableTranscriptUi>[0];
        expect(shouldEnableTranscriptUi(transcriptWithoutAudio)).toBe(true);
    });

    it.each([
        ['null', null],
        ['本文なし', { id: 'x', title: 't', fileName: 'f', promptName: 'p' }],
    ])('%s は対象外（例外にしない）', (_label, doc) => {
        expect(shouldEnableTranscriptUi(doc as Parameters<typeof shouldEnableTranscriptUi>[0])).toBe(false);
    });
});

describe('🔴 回帰: 通常の文書の描画が 1 文字も変わらない', () => {
    it('components を渡さない描画と、既定の描画が完全一致する', () => {
        const before = renderToStaticMarkup(<MarkdownDocument markdown={ORDINARY_DOCUMENT} />);
        const after = renderToStaticMarkup(
            <MarkdownDocument markdown={ORDINARY_DOCUMENT} components={undefined} />,
        );
        expect(after).toBe(before);
    });

    it('通常の文書のリンクは、既存の見た目（青・下線・新規タブ）のまま', () => {
        const html = renderToStaticMarkup(<MarkdownDocument markdown={ORDINARY_DOCUMENT} />);
        expect(html).toContain('text-blue-600');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    it('🔴 文字起こしの上書きを当てても、通常のリンクの見た目は変わらない', () => {
        // 上書きは `#t=` のリンクだけを別扱いにする。それ以外は既定のまま。
        const components = createTranscriptMarkdownComponents({ markdown: ORDINARY_DOCUMENT });
        const html = renderToStaticMarkup(
            <MarkdownDocument markdown={ORDINARY_DOCUMENT} components={components} />,
        );
        expect(html).toContain('text-blue-600');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });
});

describe('🔴 回帰: 音声が無ければプレイヤーは存在ごと消える', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['空文字', ''],
        ['空白のみ', '   '],
    ])('audioUrl が %s のとき、何も描画しない', (_label, audioUrl) => {
        expect(renderToStaticMarkup(<TranscriptPlayer audioUrl={audioUrl} />)).toBe('');
    });

    it('audioUrl があるときだけ描画される', () => {
        const html = renderToStaticMarkup(<TranscriptPlayer audioUrl="https://example.com/a.mp3" />);
        expect(html).not.toBe('');
    });
});

describe('文字起こし文書では、時刻リンクが操作可能になる', () => {
    it('#t= のリンクは通常リンクの青・下線にしない（読みを邪魔しない）', () => {
        const components = createTranscriptMarkdownComponents({ markdown: TRANSCRIPT_DOCUMENT });
        const html = renderToStaticMarkup(
            <MarkdownDocument markdown={TRANSCRIPT_DOCUMENT} components={components} />,
        );
        // 時刻は淡色・等幅で出す。通常リンクの装飾を持ち込まない。
        expect(html).toContain('00:00');
        expect(html).not.toContain('text-blue-600');
    });

    it('onRename を渡さなければ、話者ラベルはただの強調に戻る', () => {
        const components = createTranscriptMarkdownComponents({ markdown: TRANSCRIPT_DOCUMENT });
        const html = renderToStaticMarkup(
            <MarkdownDocument markdown={TRANSCRIPT_DOCUMENT} components={components} />,
        );
        expect(html).not.toContain('<button');
    });

    it('onRename を渡すと、話者ラベルが押せるようになる', () => {
        const components = createTranscriptMarkdownComponents({
            markdown: TRANSCRIPT_DOCUMENT,
            onRename: vi.fn(),
        });
        const html = renderToStaticMarkup(
            <MarkdownDocument markdown={TRANSCRIPT_DOCUMENT} components={components} />,
        );
        expect(html).toContain('<button');
    });
});

describe('🔴 回帰: TranscriptAwareMarkdown は通常の文書を素通しする', () => {
    it('時刻リンクの無い文書は、上書きを当てない描画と完全一致する', () => {
        const plain = renderToStaticMarkup(<MarkdownDocument markdown={ORDINARY_DOCUMENT} />);
        const through = renderToStaticMarkup(<TranscriptAwareMarkdown markdown={ORDINARY_DOCUMENT} />);
        expect(through).toBe(plain);
    });

    it('時刻リンクのある文書では描画が変わる（上書きが当たっている証人）', () => {
        const plain = renderToStaticMarkup(<MarkdownDocument markdown={TRANSCRIPT_DOCUMENT} />);
        const through = renderToStaticMarkup(<TranscriptAwareMarkdown markdown={TRANSCRIPT_DOCUMENT} />);
        expect(through).not.toBe(plain);
    });
});

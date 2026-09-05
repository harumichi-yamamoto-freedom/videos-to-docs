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

// ---------------------------------------------------------------------------
// 仕様 B3（要確認箇所）で足した判定と描画の錠
// ---------------------------------------------------------------------------

import {
    reviewAnchorsByLine,
    shouldShowTranscriptReviewPanel,
} from '@/lib/transcriptDocument';
import type { TranscriptReview } from '@/lib/transcriptReviewContract';

/** 合成の要確認データ。本文 1 行目・3 行目に段落アンカーを持つ */
const SYNTHETIC_REVIEW: TranscriptReview = {
    version: 1,
    threshold: 0.75,
    sourceTextHash: '0'.repeat(64),
    sourceJobId: 'job-synthetic',
    summary: {
        totalPhrases: 2, lowConfidence: 2, recognitionFlagged: 0, candidateTotal: 2,
        unknownConfidence: 0, unknownRecognitionStatus: 0, noTimeCandidates: 0, savedCandidates: 2,
    },
    availability: 'complete',
    candidates: [
        { phraseId: 'p-0', reasons: ['low_confidence'], excerpt: '本日はお忙しい中', excerptTruncated: false, confidence: 0.5, startSec: 0.2, endSec: 3, paragraphStartLine: 1 },
        { phraseId: 'p-1', reasons: ['low_confidence'], excerpt: 'いえ、こちらこそ', excerptTruncated: false, confidence: 0.6, startSec: 12.4, endSec: 14, paragraphStartLine: 3 },
    ],
};

describe('音声 UI の有効化: 本文の時刻リンクが無くても review の有効時刻で有効化する（仕様 B3）', () => {
    it('🔴 音声を持つ通常の議事録は、review が無ければ引き続き対象外', () => {
        expect(shouldEnableTranscriptUi({ text: ORDINARY_DOCUMENT, audioStoragePath: 'audio/user-1/a.mp3' })).toBe(false);
    });

    it('編集で時刻リンクが全て消えた本文でも、review に有効時刻の候補があれば対象', () => {
        expect(shouldEnableTranscriptUi({ text: ORDINARY_DOCUMENT, transcriptReview: SYNTHETIC_REVIEW })).toBe(true);
    });

    it('review があっても有効時刻の候補が無ければ対象外（audioStoragePath だけで有効化しない）', () => {
        const noTime: TranscriptReview = {
            ...SYNTHETIC_REVIEW,
            candidates: [{ phraseId: 'p-0', reasons: ['recognition_status'], excerpt: '', excerptTruncated: false }],
        };
        expect(shouldEnableTranscriptUi({ text: ORDINARY_DOCUMENT, audioStoragePath: 'audio/user-1/a.mp3', transcriptReview: noTime })).toBe(false);
    });
});

describe('要確認パネルを置く文書', () => {
    it('🔴 時刻リンクの無い通常の議事録には置かない（見た目を変えない）', () => {
        expect(shouldShowTranscriptReviewPanel({ text: ORDINARY_DOCUMENT, audioStoragePath: 'audio/user-1/a.mp3' })).toBe(false);
    });

    it('review を持つ文書・review の無い文字起こし文書には置く。処理中には置かない', () => {
        expect(shouldShowTranscriptReviewPanel({ text: ORDINARY_DOCUMENT, transcriptReview: SYNTHETIC_REVIEW })).toBe(true);
        expect(shouldShowTranscriptReviewPanel({ text: TRANSCRIPT_DOCUMENT })).toBe(true);
        expect(shouldShowTranscriptReviewPanel({ text: TRANSCRIPT_DOCUMENT, status: 'processing', transcriptReview: SYNTHETIC_REVIEW })).toBe(false);
    });
});

describe('🔴 回帰: 段落バッジは本文ハッシュの照合が済むまで描かない', () => {
    it('review を渡しても照合前（SSR）は review 無しの描画と完全一致する', () => {
        const without = renderToStaticMarkup(<TranscriptAwareMarkdown markdown={TRANSCRIPT_DOCUMENT} />);
        const withReview = renderToStaticMarkup(
            <TranscriptAwareMarkdown markdown={TRANSCRIPT_DOCUMENT} documentId="doc-1" review={SYNTHETIC_REVIEW} />,
        );
        expect(withReview).toBe(without);
        expect(withReview).not.toContain('要確認');
    });

    it('通常の議事録に review を付けても、本文の描画は既定と完全一致する（アンカー行が無い）', () => {
        const plain = renderToStaticMarkup(<MarkdownDocument markdown={ORDINARY_DOCUMENT} />);
        const through = renderToStaticMarkup(
            <TranscriptAwareMarkdown markdown={ORDINARY_DOCUMENT} documentId="doc-1" review={SYNTHETIC_REVIEW} />,
        );
        expect(through).toBe(plain);
    });

    it('アンカーを明示的に渡したときだけ、該当段落に選択不可・印刷非表示のバッジが付く', () => {
        const components = createTranscriptMarkdownComponents({
            markdown: TRANSCRIPT_DOCUMENT,
            reviewAnchors: { documentId: 'doc-1', anchorsByLine: reviewAnchorsByLine(SYNTHETIC_REVIEW.candidates) },
        });
        const html = renderToStaticMarkup(<MarkdownDocument markdown={TRANSCRIPT_DOCUMENT} components={components} />);
        expect(html).toContain('data-review-line="1"');
        expect(html).toContain('data-review-line="3"');
        expect(html).toContain('要確認 1 箇所');
        expect(html).toContain('select-none');
        expect(html).toContain('print:hidden');
        // PDF 用の描画（MarkdownDocument 単体）には出ない
        expect(renderToStaticMarkup(<MarkdownDocument markdown={TRANSCRIPT_DOCUMENT} />)).not.toContain('要確認');
    });
});

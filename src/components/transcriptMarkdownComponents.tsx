'use client';

/**
 * P1: 文字起こし文書のための `react-markdown` components 上書き（設計 §6.5）。
 *
 * 🔴 これは「文字起こし専用画面」を作るためのものではない。通常の文書ビューに、
 *    時刻リンク・話者名・欠落注記の 3 点だけを足す上書きである。
 *    それ以外の要素は一切上書きしない＝他の文書と同じ見た目・同じ操作のまま。
 *
 * 🔴 利用者は本文を自由に編集できる。壊れた行は「単に押せない」だけにし、例外は投げない。
 *
 * 仕様 B3（要確認箇所）で足したもの: 生成時に確定した段落アンカー（`paragraphStartLine`）と
 * 描画ノードの元ソース行（`node.position.start.line`）が一致する段落に「要確認 N 箇所」のバッジを付け、
 * 候補カードからの「本文の該当段落へ移動」を受ける。
 * 🔴 アンカーは呼び出し側が「表示本文のハッシュが review.sourceTextHash と一致する」ときだけ渡す。
 *    ここでは本文の文字列検索・最寄り時刻・同じ #t= の先頭一致でアンカーを推測しない（仕様 B2）。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import type { Element as HastElement } from 'hast';
import { formatTimestamp, parseTimestampHref, parseTranscriptTimestamps } from '@/lib/transcriptMerge';
import {
    scrollBehaviorForMotion,
    transcriptPlayback,
    useTranscriptPlayback,
} from '@/components/TranscriptPlayer';
import {
    transcriptReviewSelection,
    useTranscriptReviewSelection,
} from '@/components/transcriptReviewSelection';

/**
 * 通常リンクの見た目。MarkdownDocument.tsx の `a` と同一にする。
 * （あちらは module-private なので import できない。値を変えるときは両方を揃えること）
 */
const BASE_LINK_CLASS = 'text-blue-600 hover:text-blue-800 underline';

/** 時刻の見た目。行頭に淡色・等幅・小さく。本文の色とサイズには触れない */
const TIMESTAMP_CLASS =
    'mr-1.5 align-baseline font-mono text-xs tabular-nums text-gray-400 no-underline';

// ---------------------------------------------------------------------------
// 本文から読み取るもの（すべて graceful degradation）
// ---------------------------------------------------------------------------

/** 「時刻リンク + **話者名**」の形で始まる行だけを話者行とみなす */
const SPEAKER_LINE = /^(\[[^\]\n]*\]\(#t=[^)\s]*\)[ \t]+)\*\*([^*\n]+)\*\*/gm;

/** 本文に出てくる話者ラベルを、出現順に重複なく拾う */
export const collectTranscriptSpeakers = (markdown: string): string[] => {
    if (typeof markdown !== 'string' || markdown === '') return [];
    const found: string[] = [];
    SPEAKER_LINE.lastIndex = 0;
    let matched = SPEAKER_LINE.exec(markdown);
    while (matched !== null) {
        const label = matched[2];
        if (!found.includes(label)) found.push(label);
        matched = SPEAKER_LINE.exec(markdown);
    }
    return found;
};

/** 改名したときに何箇所が変わるか。適用前に必ず利用者へ見せる数 */
export const countSpeakerLabelOccurrences = (markdown: string, label: string): number => {
    if (typeof markdown !== 'string' || label === '') return 0;
    let count = 0;
    SPEAKER_LINE.lastIndex = 0;
    let matched = SPEAKER_LINE.exec(markdown);
    while (matched !== null) {
        if (matched[2] === label) count += 1;
        matched = SPEAKER_LINE.exec(markdown);
    }
    return count;
};

/** 話者ラベルの一括置換。話者位置のものだけを置き換え、本文中の同じ語には触らない */
export const renameSpeakerLabel = (markdown: string, from: string, to: string): string => {
    if (typeof markdown !== 'string' || from === '' || to === '' || from === to) return markdown;
    return markdown.replace(SPEAKER_LINE, (full, prefix: string, label: string) =>
        label === from ? `${prefix}**${to}**` : full,
    );
};

/** `01:20:00` / `12:34` を秒へ。読めなければ null */
export const parseClockDisplay = (display: string): number | null => {
    const parts = display.trim().split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    let total = 0;
    for (const part of parts) {
        if (!/^\d+$/.test(part)) return null;
        total = total * 60 + Number(part);
    }
    return Number.isFinite(total) ? total : null;
};

/**
 * 欠落注記の 1 行。`　　　⚠ 00:12 〜 00:20 は文字起こしできませんでした。［再試行］`
 * 🔴 事実として置くだけ。赤や感嘆符で埋めない
 */
const GAP_NOTE =
    /^[\s　]*⚠[\s　]*([\d:]+)[\s　]*〜[\s　]*([\d:]+)[\s　]*は文字起こしできませんでした。[\s　]*［再試行］[\s　]*$/;

export interface TranscriptGap {
    startSec: number;
    endSec: number;
}

const nodeText = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const candidate = node as { type?: string; value?: string; children?: unknown[] };
    if (candidate.type === 'text') return typeof candidate.value === 'string' ? candidate.value : '';
    if (Array.isArray(candidate.children)) return candidate.children.map(nodeText).join('');
    return '';
};

/** 段落の先頭が時刻リンクなら、その秒。そうでなければ null */
const leadingTimestampSec = (node: HastElement | undefined): number | null => {
    const first = node?.children?.[0];
    if (!first || typeof first !== 'object') return null;
    const element = first as HastElement;
    if (element.type !== 'element' || element.tagName !== 'a') return null;
    const href = element.properties?.href;
    return typeof href === 'string' ? parseTimestampHref(href) : null;
};

/** 描画ノードの元ソース上の開始行（1 始まり）。無ければ null（アンカーを付けない） */
const sourceStartLine = (node: HastElement | undefined): number | null => {
    const line = node?.position?.start?.line;
    return typeof line === 'number' && Number.isInteger(line) && line >= 1 ? line : null;
};

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

/** 段落に付く要確認アンカー（呼び出し側がハッシュ一致を確認したときだけ渡される） */
export interface TranscriptReviewParagraphAnchor {
    documentId: string;
    /** 段落の開始行（1 始まり）。候補カードからの移動要求はこの行で照合する */
    line: number;
    /** この段落に属する候補の phraseId（表示順） */
    phraseIds: readonly string[];
}

/**
 * 段落の「要確認 N 箇所」バッジ。押すと候補カード側がその候補を表示してフォーカスを受ける。
 * 🔴 段落全体を誤り扱いする表現にしない。色だけでなく文言で区別する。
 * 🔴 選択不可（select-none）・印刷非表示: 本文のコピー・PDF に操作 UI を混ぜない。
 */
function ReviewParagraphBadge({ anchor }: { anchor: TranscriptReviewParagraphAnchor }): React.ReactElement {
    const count = anchor.phraseIds.length;
    return (
        <span
            className="ml-2 inline-flex select-none align-baseline print:hidden"
            data-review-badge={anchor.line}
        >
            <button
                type="button"
                onClick={() => transcriptReviewSelection.reveal(anchor.documentId, anchor.phraseIds[0])}
                aria-label={`この段落の要確認候補 ${count} 箇所を、要確認箇所の一覧で表示`}
                title="要確認箇所の一覧で該当の候補を表示"
                className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium leading-none text-amber-900 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
                要確認 {count} 箇所
            </button>
        </span>
    );
}

/**
 * 再生中の行。淡くハイライトし、追従が入なら画面内へ寄せる。
 * 本文の色とサイズは他の文書と同じまま（背景だけを足す）。
 *
 * 要確認アンカーを持つ行は、候補カードからの移動要求（同じ文書・同じ開始行）を受けて
 * 1 回だけ寄せてフォーカスを受ける。🔴 これは再生中の追従とは別（追従の入切に関係なく動き、色も分ける）。
 */
function TranscriptLine({
    startSec,
    nextSec,
    reviewAnchor,
    children,
    ...rest
}: {
    startSec: number;
    nextSec: number | null;
    reviewAnchor: TranscriptReviewParagraphAnchor | null;
    children?: React.ReactNode;
} & React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement {
    const { currentSec, follow, ready } = useTranscriptPlayback();
    const selection = useTranscriptReviewSelection();
    const ref = useRef<HTMLParagraphElement | null>(null);
    const active =
        ready && currentSec >= startSec && (nextSec === null || currentSec < nextSec);
    const targetNonce =
        reviewAnchor !== null
            && selection.documentId === reviewAnchor.documentId
            && selection.paragraphRequest !== null
            && selection.paragraphRequest.line === reviewAnchor.line
            ? selection.paragraphRequest.nonce
            : null;
    const isTarget = targetNonce !== null;

    useEffect(() => {
        if (!active || !follow) return;
        const element = ref.current;
        // 🔴 追従は利用者が止められる。止めているときはここへ来ない
        if (element && typeof element.scrollIntoView === 'function') {
            element.scrollIntoView({ block: 'center', behavior: scrollBehaviorForMotion() });
        }
    }, [active, follow]);

    useEffect(() => {
        if (targetNonce === null) return;
        // 🔴 候補ジャンプ中は再生追従を止める（次の時刻更新でジャンプ先から引き戻さない）。
        //    B3「選択した候補の移動と再生中段落の追従は区別する」。利用者が「追従」を押し直すと再開する。
        //    追従スクロールとジャンプは別動作なので、ジャンプ先のフォーカス・寄せはこの後そのまま行う。
        transcriptPlayback.setFollow(false);
        const element = ref.current;
        if (!element) return;
        // 候補からの移動。フォーカスを渡してから寄せる（動きを減らす設定ではアニメーションなし）
        if (typeof element.focus === 'function') element.focus({ preventScroll: true });
        if (typeof element.scrollIntoView === 'function') {
            element.scrollIntoView({ block: 'center', behavior: scrollBehaviorForMotion() });
        }
    }, [targetNonce]);

    return (
        <p
            ref={ref}
            data-transcript-active={active ? 'true' : undefined}
            aria-current={active ? 'location' : undefined}
            tabIndex={reviewAnchor ? -1 : undefined}
            data-review-line={reviewAnchor ? reviewAnchor.line : undefined}
            data-review-target={isTarget ? 'true' : undefined}
            className={[
                'mb-4 leading-relaxed',
                active ? '-mx-2 rounded-md bg-purple-50/70 px-2' : '',
                reviewAnchor ? 'rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500' : '',
                isTarget ? 'ring-2 ring-amber-400 ring-offset-2' : '',
            ].filter(Boolean).join(' ')}
            {...rest}
        >
            {children}
            {reviewAnchor && <ReviewParagraphBadge anchor={reviewAnchor} />}
        </p>
    );
}

/** 欠落注記。目立たせすぎず、［再試行］だけは押せる形にする */
function GapNote({
    gap,
    display,
    onRetryGap,
}: {
    gap: TranscriptGap;
    display: { start: string; end: string };
    onRetryGap?: (gap: TranscriptGap) => void;
}): React.ReactElement {
    return (
        <p className="mb-4 pl-6 text-sm leading-relaxed text-gray-500">
            <span aria-hidden="true" className="mr-1.5">⚠</span>
            <span className="font-mono text-xs tabular-nums">
                {display.start} 〜 {display.end}
            </span>
            <span> は文字起こしできませんでした。</span>
            {onRetryGap ? (
                <button
                    type="button"
                    onClick={() => onRetryGap(gap)}
                    className="ml-1 rounded px-1 text-sm font-medium text-purple-700 underline decoration-dotted underline-offset-2 hover:bg-purple-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                >
                    再試行
                </button>
            ) : (
                <span className="ml-1">［再試行］</span>
            )}
        </p>
    );
}

/**
 * 話者ラベル。押すとその場で入力欄になる。
 * 🔴 設定画面・モーダル・別タブへ飛ばさない。適用前に「何箇所変わるか」を見せ、取り消せる。
 */
function SpeakerLabel({
    label,
    occurrences,
    onRename,
}: {
    label: string;
    occurrences: number;
    onRename: (from: string, to: string) => void;
}): React.ReactElement {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(label);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (editing) inputRef.current?.focus();
    }, [editing]);

    const close = (): void => {
        setEditing(false);
        setDraft(label);
    };

    const nextLabel = draft.trim();
    const canApply = nextLabel !== '' && nextLabel !== label;

    const apply = (): void => {
        if (!canApply) return;
        onRename(label, nextLabel);
        setEditing(false);
    };

    if (!editing) {
        return (
            <button
                type="button"
                onClick={() => {
                    setDraft(label);
                    setEditing(true);
                }}
                title="話者名を変更"
                className="rounded font-bold text-gray-900 underline decoration-dotted decoration-gray-300 underline-offset-4 hover:bg-purple-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            >
                {label}
            </button>
        );
    }

    return (
        <span className="relative inline-flex items-center gap-1 align-baseline">
            <input
                ref={inputRef}
                value={draft}
                aria-label={`話者「${label}」の名前`}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        apply();
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        close();
                    }
                }}
                className="w-28 rounded-md border border-purple-300 px-1.5 py-0.5 text-sm font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            <span className="text-xs font-normal text-gray-500">
                {canApply ? `${occurrences}箇所が変わります` : '変更なし'}
            </span>
            <button
                type="button"
                onClick={apply}
                disabled={!canApply}
                className="rounded-md bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 hover:bg-purple-200 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            >
                変更
            </button>
            <button
                type="button"
                onClick={close}
                className="rounded-md px-2 py-0.5 text-xs font-medium text-gray-500 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            >
                キャンセル
            </button>
        </span>
    );
}

// ---------------------------------------------------------------------------
// components 上書き本体
// ---------------------------------------------------------------------------

/** 要確認候補の段落アンカー。呼び出し側が本文ハッシュの一致を確認したときだけ渡す */
export interface TranscriptReviewAnchorOptions {
    documentId: string;
    /** 段落開始行（1 始まり）→ その段落に属する候補の phraseId（表示順） */
    anchorsByLine: ReadonlyMap<number, readonly string[]>;
}

export interface TranscriptMarkdownComponentsOptions {
    /** 表示している本文。話者ラベルの検出と「何箇所変わるか」の算出に使う */
    markdown: string;
    /** 話者改名。実際の保存は呼び出し側（このコンポーネントは呼ぶところまで） */
    onRename?: (from: string, to: string) => void;
    /** 欠落区間の再試行 */
    onRetryGap?: (gap: TranscriptGap) => void;
    /** 要確認候補の段落バッジ。渡さなければ本文の描画は従来どおり */
    reviewAnchors?: TranscriptReviewAnchorOptions;
}

export const createTranscriptMarkdownComponents = ({
    markdown,
    onRename,
    onRetryGap,
    reviewAnchors,
}: TranscriptMarkdownComponentsOptions): Components => {
    const timestamps = parseTranscriptTimestamps(markdown)
        .map(entry => entry.sec)
        .sort((a, b) => a - b);
    const speakers = collectTranscriptSpeakers(markdown);

    const nextTimestampAfter = (sec: number): number | null => {
        for (const candidate of timestamps) {
            if (candidate > sec) return candidate;
        }
        return null;
    };

    const anchorFor = (node: HastElement | undefined): TranscriptReviewParagraphAnchor | null => {
        if (!reviewAnchors) return null;
        const line = sourceStartLine(node);
        if (line === null) return null;
        const phraseIds = reviewAnchors.anchorsByLine.get(line);
        if (!phraseIds || phraseIds.length === 0) return null;
        return { documentId: reviewAnchors.documentId, line, phraseIds };
    };

    return {
        a: ({ href, children, node, ...rest }) => {
            const raw = typeof href === 'string' ? href : '';
            if (raw.trim().startsWith('#t=')) {
                const sec = parseTimestampHref(raw);
                // 🔴 壊れた `#t=` は例外にせず、押せないただの文字として置く
                if (sec === null) {
                    return (
                        <span data-timestamp="broken" className={TIMESTAMP_CLASS}>
                            {children}
                        </span>
                    );
                }
                return (
                    <a
                        href={raw}
                        data-timestamp-sec={sec}
                        title={`${formatTimestamp(sec)} から再生`}
                        onClick={event => {
                            event.preventDefault();
                            transcriptPlayback.seek(sec);
                        }}
                        className={`${TIMESTAMP_CLASS} hover:text-purple-600`}
                    >
                        {children}
                    </a>
                );
            }
            // 通常のリンクは既存の挙動のまま
            void node;
            return (
                <a className={BASE_LINK_CLASS} target="_blank" rel="noopener noreferrer" href={href} {...rest}>
                    {children}
                </a>
            );
        },

        p: ({ node, children, ...rest }) => {
            const text = nodeText(node);
            const gap = GAP_NOTE.exec(text);
            if (gap) {
                const startSec = parseClockDisplay(gap[1]);
                const endSec = parseClockDisplay(gap[2]);
                return (
                    <GapNote
                        display={{ start: gap[1], end: gap[2] }}
                        gap={{ startSec: startSec ?? 0, endSec: endSec ?? 0 }}
                        onRetryGap={startSec !== null && endSec !== null ? onRetryGap : undefined}
                    />
                );
            }

            const startSec = leadingTimestampSec(node);
            if (startSec === null) {
                // 文字起こし行でない段落は、他の文書とまったく同じ
                return <p className="mb-4 leading-relaxed" {...rest}>{children}</p>;
            }
            return (
                <TranscriptLine
                    startSec={startSec}
                    nextSec={nextTimestampAfter(startSec)}
                    reviewAnchor={anchorFor(node)}
                    {...rest}
                >
                    {children}
                </TranscriptLine>
            );
        },

        strong: ({ node, children, ...rest }) => {
            const label = nodeText(node);
            if (onRename && label !== '' && speakers.includes(label)) {
                return (
                    <SpeakerLabel
                        label={label}
                        occurrences={countSpeakerLabelOccurrences(markdown, label)}
                        onRename={onRename}
                    />
                );
            }
            return <strong className="font-bold text-gray-900" {...rest}>{children}</strong>;
        },
    };
};

export default createTranscriptMarkdownComponents;

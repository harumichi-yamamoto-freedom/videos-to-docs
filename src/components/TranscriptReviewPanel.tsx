'use client';

/**
 * 「要確認箇所」パネル（仕様 B3）。完成した文字起こし文書の本文上部に置く折りたたみ式の一覧。
 *
 * 🔴 これは「再試行」ではない。バッチは部分再実行できないので、生成時に保存した候補
 *    （低信頼・認識結果要確認の句）を**可視化**し、既存の音声シークと全文編集へ導線を繋ぐだけ。
 * 🔴 「低信頼＝誤り」「候補なし＝正確」と読める表現を使わない。件数は「残り N」ではなく「生成時の候補 N 箇所」。
 * 🔴 本文への移動・段落バッジは、表示本文の SHA-256 が `review.sourceTextHash` と一致する間だけ有効。
 *    編集モード中はハッシュを取らず（毎キー再ハッシュしない）、表示本文が確定してから照合する。
 *
 * `DocumentDetailPanel` から独立したコンポーネントにしているのは TranscriptDocumentView と同じ理由
 * （パネル本体のテストは素の関数呼び出しで、ここで使うフックはそこでは走らない）。
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, FileText, Locate, Play } from 'lucide-react';
import { formatTimestamp } from '@/lib/transcriptMerge';
import {
    hashTranscriptText,
    orderReviewCandidates,
    type OrderedReviewCandidate,
} from '@/lib/transcriptDocument';
import type { ReviewReason, TranscriptReview } from '@/lib/transcriptReviewContract';
import {
    scrollBehaviorForMotion,
    transcriptPlayback,
    useTranscriptPlayback,
    type TranscriptAudioStatus,
    type TranscriptPlaybackSnapshot,
} from '@/components/TranscriptPlayer';
import {
    transcriptReviewSelection,
    useTranscriptReviewSelection,
} from '@/components/transcriptReviewSelection';

// ---------------------------------------------------------------------------
// 文言（純関数・テストで直接検査する）
// ---------------------------------------------------------------------------

/** 一覧の描画分割。保存上限（200 件）とは別の、画面上の分割 */
export const REVIEW_PAGE_SIZE = 20;

const REASON_LABELS: Readonly<Record<ReviewReason, string>> = {
    low_confidence: '低信頼',
    recognition_status: '認識結果を確認',
    empty_text: '認識テキストなし',
    unknown_confidence: '認識状態不明',
};

/** 候補の理由ラベル。「要確認（低信頼・認識状態不明）」の形。未知の理由コードは読み飛ばす（保存データを信じすぎない） */
export const describeReviewReasons = (reasons: readonly ReviewReason[] | undefined): string => {
    const list: readonly unknown[] = Array.isArray(reasons) ? reasons : [];
    const labels: string[] = [];
    for (const reason of list) {
        if (typeof reason !== 'string') continue;
        const label = (REASON_LABELS as Readonly<Record<string, string | undefined>>)[reason];
        if (typeof label === 'string' && !labels.includes(label)) labels.push(label);
    }
    return labels.length > 0 ? `要確認（${labels.join('・')}）` : '要確認';
};

/** 「12:34〜12:41」。終端が無い／同じ表示なら開始だけ。時刻が無ければ「時刻情報なし」 */
export const formatReviewTimeRange = (startSec: number | null, endSec: number | undefined): string => {
    if (startSec === null) return '時刻情報なし';
    const start = formatTimestamp(startSec);
    if (typeof endSec === 'number' && Number.isFinite(endSec) && endSec >= startSec) {
        const end = formatTimestamp(endSec);
        if (end !== start) return `${start}〜${end}`;
    }
    return start;
};

/** 読み上げ用の時刻。「12分34秒」「1時間2分3秒」 */
export const speakTimestamp = (sec: number): string => {
    const total = Math.floor(Math.max(0, sec));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${hours > 0 ? `${hours}時間` : ''}${minutes}分${seconds}秒`;
};

/** 認識信頼度の表示。数値でなければ出さない（0 埋め・％換算をしない） */
export const formatConfidence = (confidence: number | undefined): string | null =>
    typeof confidence === 'number' && Number.isFinite(confidence) ? confidence.toFixed(2) : null;

/** `availability === 'unavailable'` の理由コード → 短い注記 */
export const describeUnavailableReason = (reason: string | undefined): string => {
    switch (reason) {
        case 'no_phrases':
            return '認識結果に句が無く、信頼度を評価できませんでした。';
        case 'storage_budget':
            return '候補データが保存上限を超えたため、この文書には保存されていません。';
        case 'internal_error':
            return '候補データの作成に失敗したため、この文書には保存されていません。';
        default:
            return reason
                ? `信頼度情報を保存できませんでした（理由コード: ${reason}）。`
                : '信頼度情報を保存できませんでした。';
    }
};

/** 音声の状態 → 候補カードの上に出す 1 行。案内が要らない状態では null */
export const describeReviewAudioStatus = (
    playback: Pick<TranscriptPlaybackSnapshot, 'audio' | 'playbackBlocked'>,
): string | null => {
    if (playback.playbackBlocked) {
        return 'ブラウザが再生を開始しませんでした。下部のプレイヤーの再生ボタンで再生してください。';
    }
    switch (playback.audio) {
        case 'loading':
            return '音声を読み込んでいます。読み込みが終わると各候補から再生できます。';
        case 'unavailable':
            return '音声を再生できません。本文の確認・編集はできます。';
        default:
            return null;
    }
};

const countOf = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

// ---------------------------------------------------------------------------
// 本文ハッシュのフック（パネルと本文の両方が使う。同じ本文の計算はキャッシュで 1 回）
// ---------------------------------------------------------------------------

/**
 * `text` の SHA-256（hex）。`enabled` が false の間は計算せず null（編集モード中はここで止める）。
 * 計算が終わるまで・別の本文に変わった直後も null（照合前としてアンカーを無効に保つ）。
 */
export function useTranscriptTextHash(text: string, enabled: boolean): string | null {
    const [known, setKnown] = useState<{ text: string; hash: string } | null>(null);
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        void hashTranscriptText(text)
            .then(hash => {
                if (!cancelled) setKnown({ text, hash });
            })
            .catch(() => {
                // 照合不能。アンカーは無効のまま（本文の閲覧・編集・再生には影響しない）
            });
        return () => {
            cancelled = true;
        };
    }, [text, enabled]);
    return enabled && known !== null && known.text === text ? known.hash : null;
}

// ---------------------------------------------------------------------------
// パネル
// ---------------------------------------------------------------------------

export type TranscriptReviewBodyState = 'view' | 'editing';

/** 本文アンカーの状態。`match` のときだけ「本文の該当段落へ移動」と段落バッジが有効 */
export type TranscriptReviewAnchorState = 'none' | 'editing' | 'pending' | 'match' | 'mismatch';

export interface TranscriptReviewPanelProps {
    /** 文書 ID。選択・移動要求・非同期の破棄をこの単位で行う */
    documentId: string;
    /** 保存された要確認データ。旧文書では undefined */
    review: TranscriptReview | null | undefined;
    /** 表示中の本文（表示モードでは保存済み本文）。ハッシュ照合にだけ使う */
    bodyText: string;
    /** `editing` の間は本文アンカーを無効にし、再ハッシュしない */
    bodyState: TranscriptReviewBodyState;
    /** 「本文を編集」を出すか（編集権限があり保存中でない）。閲覧専用では false */
    canEdit: boolean;
    /** 「本文を編集」＝既存の全文編集へ移る（新しいエディタは作らない） */
    onEditBody?: () => void;
    className?: string;
}

const PANEL_CLASS = 'rounded-xl border border-gray-200 bg-white shadow-sm print:hidden';
const SMALL_BUTTON_CLASS =
    'inline-flex min-h-8 items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500';

export function TranscriptReviewPanel({
    documentId,
    review,
    bodyText,
    bodyState,
    canEdit,
    onEditBody,
    className,
}: TranscriptReviewPanelProps): React.ReactElement {
    const headingId = useId();
    const regionId = useId();
    const [expanded, setExpanded] = useState(false);
    const [visibleCount, setVisibleCount] = useState(REVIEW_PAGE_SIZE);
    const [focusRequest, setFocusRequest] = useState<{ phraseId: string; nonce: number } | null>(null);
    const cardRefs = useRef(new Map<string, HTMLLIElement>());
    const playback = useTranscriptPlayback();
    const selection = useTranscriptReviewSelection();

    const hasReview = Boolean(review && typeof review === 'object');
    const unavailable = hasReview && review?.availability === 'unavailable';
    const ordered = useMemo(
        () => (hasReview && !unavailable ? orderReviewCandidates(review?.candidates) : []),
        [hasReview, unavailable, review],
    );
    const sourceHash = hasReview && typeof review?.sourceTextHash === 'string' && review.sourceTextHash !== ''
        ? review.sourceTextHash
        : null;
    const bodyHash = useTranscriptTextHash(bodyText, bodyState === 'view' && sourceHash !== null);
    const anchorState: TranscriptReviewAnchorState =
        sourceHash === null ? 'none'
            : bodyState === 'editing' ? 'editing'
                : bodyHash === null ? 'pending'
                    : bodyHash === sourceHash ? 'match'
                        : 'mismatch';
    const anchorsEnabled = anchorState === 'match';

    const selectedPhraseId = selection.documentId === documentId ? selection.selectedPhraseId : null;
    const selectedIndex = selectedPhraseId === null
        ? -1
        : ordered.findIndex(entry => entry.candidate.phraseId === selectedPhraseId);

    // 文書の切替（key が変わり破棄される）で、この文書の選択・要求を捨てる
    useEffect(() => () => {
        transcriptReviewSelection.clear(documentId);
    }, [documentId]);

    /** カードを選び、必要なら展開・追加表示して、描画後にフォーカスを渡す（音声は再生しない） */
    const focusCandidate = useCallback((index: number): void => {
        const entry = ordered[index];
        if (!entry) return;
        transcriptReviewSelection.select(documentId, entry.candidate.phraseId);
        setExpanded(true);
        setVisibleCount(count => Math.max(count, index + 1));
        setFocusRequest(previous => ({ phraseId: entry.candidate.phraseId, nonce: (previous?.nonce ?? 0) + 1 }));
    }, [documentId, ordered]);

    // 本文の段落バッジからの表示要求（この文書のものだけ）。ストアの購読で受け、同じ要求は 1 回だけ処理する
    useEffect(() => {
        let handledNonce: number | null = null;
        const handleRequest = (): void => {
            const snapshot = transcriptReviewSelection.getSnapshot();
            const request = snapshot.documentId === documentId ? snapshot.revealRequest : null;
            if (!request || request.nonce === handledNonce) return;
            handledNonce = request.nonce;
            const index = ordered.findIndex(entry => entry.candidate.phraseId === request.phraseId);
            if (index < 0) return;
            setExpanded(true);
            setVisibleCount(count => Math.max(count, index + 1));
            setFocusRequest(previous => ({ phraseId: request.phraseId, nonce: (previous?.nonce ?? 0) + 1 }));
        };
        return transcriptReviewSelection.subscribe(handleRequest);
    }, [documentId, ordered]);

    // 展開・追加表示と同じ描画でカードが出るので、その後にフォーカスを渡す
    useEffect(() => {
        if (!focusRequest) return;
        const element = cardRefs.current.get(focusRequest.phraseId);
        if (!element) return;
        element.focus({ preventScroll: true });
        if (typeof element.scrollIntoView === 'function') {
            element.scrollIntoView({ block: 'nearest', behavior: scrollBehaviorForMotion() });
        }
    }, [focusRequest]);

    const registerCard = useCallback((phraseId: string, element: HTMLLIElement | null): void => {
        if (element) cardRefs.current.set(phraseId, element);
        else cardRefs.current.delete(phraseId);
    }, []);

    const panelClass = `${PANEL_CLASS} ${className ?? ''}`.trim();

    // --- 信頼度情報が無い（旧文書）／保存できなかった（unavailable）: summary を描かず、0 件に見せない ---
    if (!hasReview || unavailable) {
        return (
            <section
                aria-labelledby={headingId}
                data-testid="transcript-review-panel"
                data-review-state={unavailable ? 'unavailable' : 'missing'}
                className={`${panelClass} px-4 py-3`}
            >
                <h3 id={headingId} className="text-sm font-semibold text-gray-800">
                    要確認箇所：この文書には信頼度情報がありません
                </h3>
                <p className="mt-1 text-xs text-gray-600">
                    {unavailable
                        ? describeUnavailableReason(review?.unavailableReason)
                        : '生成時に信頼度情報が保存されていないため、自動判定の候補は表示できません。'}
                    {' '}候補が 0 件という意味ではありません。本文の確認・編集はこれまでどおり行えます。
                </p>
            </section>
        );
    }

    const summary = review?.summary;
    const total = countOf(summary?.candidateTotal, ordered.length);
    const unknownConfidence = countOf(summary?.unknownConfidence, 0);
    const unknownStatus = countOf(summary?.unknownRecognitionStatus, 0);
    const partial = review?.availability === 'partial' || ordered.length < total;
    const visible = ordered.slice(0, visibleCount);
    const remaining = ordered.length - visible.length;
    const hasPlayable = ordered.some(entry => entry.startSec !== null);
    const audioNote = hasPlayable ? describeReviewAudioStatus(playback) : null;
    const anchorNote =
        anchorState === 'editing'
            ? '本文を編集中です。本文の該当段落への移動は、表示に戻って本文が確定すると再確認します。'
            : anchorState === 'mismatch'
                ? '本文は編集されています。以下は生成時の要確認候補です。'
                : anchorState === 'pending'
                    ? '本文を照合しています…'
                    : null;
    const canGoPrevious = ordered.length > 0 && selectedIndex > 0;
    const canGoNext = ordered.length > 0 && selectedIndex < ordered.length - 1;

    return (
        <section
            aria-labelledby={headingId}
            data-testid="transcript-review-panel"
            data-review-state="ready"
            className={panelClass}
        >
            <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                    <h3 id={headingId} className="text-sm font-semibold text-gray-800">
                        要確認箇所：生成時の候補 {total} 箇所
                    </h3>
                    <p className="mt-1 text-xs text-gray-600">
                        音声認識の信頼度などをもとにした候補です。誤りと断定するものではありません。
                    </p>
                    {total === 0 && (
                        <p className="mt-1 text-xs text-gray-700">
                            自動判定の要確認候補はありません。内容の正確さを保証するものではありません。
                        </p>
                    )}
                    {(unknownConfidence > 0 || unknownStatus > 0) && (
                        <p className="mt-1 text-xs text-gray-600">
                            自動判定できなかった句があります（信頼度不明 {unknownConfidence} 句・認識状態不明 {unknownStatus} 句）。
                            候補が 0 件でも、全句に問題が無いという意味ではありません。
                        </p>
                    )}
                    {partial && ordered.length > 0 && (
                        <p className="mt-1 text-xs text-gray-600">
                            候補 {total} 箇所のうち先頭 {ordered.length} 箇所を表示しています。
                        </p>
                    )}
                </div>
                {ordered.length > 0 && (
                    <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={regionId}
                        onClick={() => setExpanded(value => !value)}
                        className={SMALL_BUTTON_CLASS}
                    >
                        {expanded
                            ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                            : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                        <span>{expanded ? '閉じる' : '開く'}</span>
                    </button>
                )}
            </div>

            {ordered.length > 0 && (
                <div id={regionId} hidden={!expanded} className="border-t border-gray-100 px-4 py-3">
                    {anchorNote && (
                        <p role="status" data-testid="transcript-review-anchor-note" className="mb-2 text-xs text-gray-700">
                            {anchorNote}
                        </p>
                    )}
                    {audioNote && (
                        <p role="status" data-testid="transcript-review-audio-note" className="mb-2 text-xs text-gray-700">
                            {audioNote}
                        </p>
                    )}
                    <ol aria-label="要確認候補の一覧" className="space-y-3">
                        {visible.map((entry, index) => (
                            <ReviewCandidateCard
                                key={entry.candidate.phraseId}
                                entry={entry}
                                position={index + 1}
                                total={ordered.length}
                                documentId={documentId}
                                selected={entry.candidate.phraseId === selectedPhraseId}
                                anchorState={anchorState}
                                anchorsEnabled={anchorsEnabled}
                                audioStatus={playback.audio}
                                threshold={review?.threshold}
                                registerRef={registerCard}
                            />
                        ))}
                    </ol>
                    {remaining > 0 && (
                        <button
                            type="button"
                            onClick={() => setVisibleCount(count => count + REVIEW_PAGE_SIZE)}
                            className={`${SMALL_BUTTON_CLASS} mt-3`}
                        >
                            さらに表示（残り {remaining} 件）
                        </button>
                    )}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-2" role="group" aria-label="候補の移動">
                            <button
                                type="button"
                                disabled={!canGoPrevious}
                                onClick={() => focusCandidate(selectedIndex - 1)}
                                className={SMALL_BUTTON_CLASS}
                            >
                                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>前の候補</span>
                            </button>
                            <button
                                type="button"
                                disabled={!canGoNext}
                                onClick={() => focusCandidate(selectedIndex + 1)}
                                className={SMALL_BUTTON_CLASS}
                            >
                                <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>次の候補</span>
                            </button>
                        </div>
                        {canEdit && bodyState === 'view' && onEditBody && (
                            <button
                                type="button"
                                onClick={onEditBody}
                                className={SMALL_BUTTON_CLASS}
                            >
                                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>本文を編集</span>
                            </button>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}

// ---------------------------------------------------------------------------
// 候補カード
// ---------------------------------------------------------------------------

interface ReviewCandidateCardProps {
    entry: OrderedReviewCandidate;
    position: number;
    total: number;
    documentId: string;
    selected: boolean;
    anchorState: TranscriptReviewAnchorState;
    anchorsEnabled: boolean;
    audioStatus: TranscriptAudioStatus;
    threshold: number | undefined;
    registerRef: (phraseId: string, element: HTMLLIElement | null) => void;
}

function ReviewCandidateCard({
    entry,
    position,
    total,
    documentId,
    selected,
    anchorState,
    anchorsEnabled,
    audioStatus,
    threshold,
    registerRef,
}: ReviewCandidateCardProps): React.ReactElement {
    const { candidate, startSec } = entry;
    const headingId = useId();
    const reasonLabel = describeReviewReasons(candidate.reasons);
    const timeLabel = formatReviewTimeRange(startSec, candidate.endSec);
    const speaker = typeof candidate.speaker === 'string' && candidate.speaker !== '' ? candidate.speaker : null;
    const excerpt = typeof candidate.excerpt === 'string' ? candidate.excerpt : '';
    const truncated = candidate.excerptTruncated === true;
    const confidence = formatConfidence(candidate.confidence);
    const recognitionStatus = typeof candidate.recognitionStatus === 'string' && candidate.recognitionStatus !== ''
        ? candidate.recognitionStatus
        : null;
    const thresholdLabel = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold.toFixed(2) : null;

    const canPlay = startSec !== null && audioStatus === 'ready';
    const playTitle = startSec === null
        ? '時刻情報がないため再生できません'
        : audioStatus === 'loading'
            ? '音声を読み込んでいます'
            : audioStatus !== 'ready'
                ? '音声を再生できません'
                : undefined;

    const line = candidate.paragraphStartLine;
    const hasAnchor = typeof line === 'number' && Number.isInteger(line) && line >= 1;
    const canMove = hasAnchor && anchorsEnabled;
    const moveTitle = !hasAnchor
        ? 'この候補の本文位置は生成時に確定していません'
        : anchorState === 'editing'
            ? '編集中は本文へ移動できません（表示に戻ると再確認します）'
            : anchorState === 'mismatch'
                ? '本文が編集されているため移動できません'
                : anchorState === 'pending'
                    ? '本文を照合しています'
                    : anchorState === 'none'
                        ? '本文の照合情報がありません'
                        : undefined;

    return (
        <li
            ref={element => registerRef(candidate.phraseId, element)}
            tabIndex={-1}
            aria-labelledby={headingId}
            aria-current={selected ? 'true' : undefined}
            data-review-card={candidate.phraseId}
            data-review-selected={selected ? 'true' : undefined}
            onFocus={() => transcriptReviewSelection.select(documentId, candidate.phraseId)}
            className={`rounded-lg border p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 ${
                selected ? 'border-purple-300 bg-purple-50/40' : 'border-gray-200 bg-white'
            }`}
        >
            <h4 id={headingId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-gray-800">
                <span>候補 {position} / {total}</span>
                <span className="font-mono text-xs font-normal tabular-nums text-gray-600">{timeLabel}</span>
                {speaker && <span className="text-xs font-normal text-gray-600">話者 {speaker}</span>}
                <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                    {reasonLabel}
                </span>
                {selected && <span className="text-xs font-normal text-purple-700">選択中</span>}
            </h4>
            <blockquote
                data-review-excerpt
                className="mt-2 rounded-md border-l-4 border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-gray-900"
            >
                {excerpt !== ''
                    ? <span>「{excerpt}{truncated ? '…' : ''}」</span>
                    : <span className="text-gray-600">認識テキストなし</span>}
                {truncated && (
                    <span className="mt-1 block text-xs text-gray-600">
                        抜粋は上限で省略しています（認識結果が途切れているとは限りません）。
                    </span>
                )}
            </blockquote>
            {(confidence !== null || recognitionStatus !== null) && (
                <details className="mt-2 text-xs text-gray-600">
                    <summary className="cursor-pointer select-none">詳細</summary>
                    <dl className="mt-1 space-y-0.5">
                        {confidence !== null && (
                            <div>
                                <dt className="inline font-medium">認識信頼度</dt>
                                {' '}
                                <dd className="inline">
                                    {confidence}（判定の参考値{thresholdLabel ? `・判定に用いた閾値 ${thresholdLabel}` : ''}）
                                </dd>
                            </div>
                        )}
                        {recognitionStatus !== null && (
                            <div>
                                <dt className="inline font-medium">認識状態</dt>
                                {' '}
                                <dd className="inline">{recognitionStatus}</dd>
                            </div>
                        )}
                    </dl>
                </details>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={!canPlay}
                    title={playTitle}
                    aria-label={startSec === null ? '音声を再生（時刻情報なし）' : `${speakTimestamp(startSec)}から音声を再生`}
                    onClick={() => {
                        if (startSec === null) return;
                        transcriptReviewSelection.select(documentId, candidate.phraseId);
                        transcriptPlayback.seek(startSec);
                    }}
                    className={SMALL_BUTTON_CLASS}
                >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{startSec === null ? '時刻情報なし' : `${formatTimestamp(startSec)}から音声を再生`}</span>
                </button>
                <button
                    type="button"
                    disabled={!canMove}
                    title={moveTitle}
                    onClick={() => {
                        if (!canMove || !hasAnchor) return;
                        transcriptReviewSelection.moveToParagraph(documentId, line, candidate.phraseId);
                    }}
                    className={SMALL_BUTTON_CLASS}
                >
                    <Locate className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>本文の該当段落へ移動</span>
                </button>
            </div>
        </li>
    );
}

export default TranscriptReviewPanel;

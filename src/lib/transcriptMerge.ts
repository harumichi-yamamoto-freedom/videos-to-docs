/**
 * P1: 分割文字起こしの結合と Markdown 整形。
 *
 * 25分チャンク・オーバーラップ30秒で分割して文字起こしした結果を、1本の文書に繋ぐ。
 * ここは API も UI も触らない純関数だけを置く（設計 §3.4 / §3.5 / §6.1）。
 *
 * 🔴 先行実装が実際に踏んだ罠を、この3点で塞いでいる:
 *   1. 絶対時刻 = 返却値 − prefixSec + startSec。プレフィックス長を引き忘れると、
 *      全チャンクが「チャンクごとに違う量だけ」ずれるので気づきにくい。
 *   2. 採否は発話の「中点」で決める。start 基準は切断線を跨ぐ発話を両側から採って重複させ、
 *      end 基準は同じ発話を両側から落として欠落させる。
 *   3. チャンク内の時刻はそのチャンクの開始点にアンカーする。チャンクを跨いで累積させない。
 */

/** API が返す注釈 1 本（語または発話）。時刻は「送った音声の先頭からの相対秒」＝プレフィックス込み */
export interface MergeAnnotation {
    text: string;
    startOffsetSec: number;
    endOffsetSec: number;
    /** `spk:0` など。話者ラベルが付かなかった注釈は null */
    speaker: string | null;
}

export interface MergeChunk {
    index: number;
    /** 元音声におけるこのチャンク本体の開始秒（オーバーラップ込みの実際の開始） */
    startSec: number;
    /** 話者プレフィックスとして先頭に連結した秒数（0 のことが多い） */
    prefixSec: number;
    /**
     * 元音声におけるこのチャンク本体の終了秒。
     * 省略すると切断線は注釈の実測末尾で代用され、失敗チャンクの注記の範囲も縮む。
     */
    endSec?: number;
    annotations: MergeAnnotation[];
    /** 品質ゲート全滅で取得できなかったチャンク。本文の代わりに注記を出す */
    failed?: boolean;
}

/** 結合後の 1 セグメント。時刻は元音声の絶対秒 */
export interface MergedSegment {
    text: string;
    startSec: number;
    endSec: number;
    speaker: string | null;
    /** どのチャンクから採ったか（デバッグと不変条件の診断用） */
    chunkIndex: number;
}

/** 文字起こしできなかった区間 */
export interface MergedGap {
    chunkIndex: number;
    startSec: number;
    endSec: number;
}

export interface MergedTranscript {
    segments: MergedSegment[];
    gaps: MergedGap[];
}

const byIndex = (a: MergeChunk, b: MergeChunk) => a.index - b.index;

/** 注釈の絶対時刻。🔴 プレフィックス長を引いてからチャンク開始点へアンカーする */
export const toAbsoluteSec = (offsetSec: number, chunk: Pick<MergeChunk, 'startSec' | 'prefixSec'>): number =>
    offsetSec - chunk.prefixSec + chunk.startSec;

/** 中点。採否はここで決める（start でも end でもない） */
export const midpointSec = (startSec: number, endSec: number): number => (startSec + endSec) / 2;

/** チャンク本体の絶対終了秒。endSec が無ければ注釈の実測末尾で代用する */
const effectiveEndSec = (chunk: MergeChunk): number => {
    if (typeof chunk.endSec === 'number') return chunk.endSec;
    let end = chunk.startSec;
    for (const annotation of chunk.annotations) {
        const absolute = toAbsoluteSec(annotation.endOffsetSec, chunk);
        if (absolute > end) end = absolute;
    }
    return end;
};

/**
 * チャンク N と N+1 の切断線 ＝ オーバーラップ区間の中点。
 * オーバーラップ ＝ [next.startSec, N の終端]。重なっていなければ境界そのもの。
 */
export const cutLineSec = (chunk: MergeChunk, next: MergeChunk): number => {
    const overlapStart = next.startSec;
    const overlapEnd = effectiveEndSec(chunk);
    if (overlapEnd <= overlapStart) return overlapStart;
    return midpointSec(overlapStart, overlapEnd);
};

/**
 * チャンク結果を 1 本に結合する（決定論的な中点マージ）。
 *
 * セグメントは意図的に**ソートしない**。並べ直すと不変条件 (a) が常に成立してしまい、
 * マージのバグを検出できなくなるため。順序の検査は checkMergeInvariants の仕事。
 */
export const mergeTranscriptChunks = (chunks: MergeChunk[]): MergedTranscript => {
    const ordered = [...chunks].sort(byIndex);
    const segments: MergedSegment[] = [];
    const gaps: MergedGap[] = [];

    for (let i = 0; i < ordered.length; i += 1) {
        const chunk = ordered[i];
        const previous = ordered[i - 1];
        const next = ordered[i + 1];
        // 自分より前／後ろのチャンクとの切断線。端は無限に開く
        const lowerBound = previous ? cutLineSec(previous, chunk) : Number.NEGATIVE_INFINITY;
        const upperBound = next ? cutLineSec(chunk, next) : Number.POSITIVE_INFINITY;

        if (chunk.failed) {
            const start = previous ? lowerBound : chunk.startSec;
            const end = next ? upperBound : effectiveEndSec(chunk);
            gaps.push({ chunkIndex: chunk.index, startSec: start, endSec: end });
            continue;
        }

        for (const annotation of chunk.annotations) {
            const startSec = toAbsoluteSec(annotation.startOffsetSec, chunk);
            const endSec = toAbsoluteSec(annotation.endOffsetSec, chunk);
            // プレフィックスとして連結した音声の区間は結合時に破棄する（絶対時刻がチャンク開始より前になる）
            const middle = midpointSec(startSec, endSec);
            if (middle < chunk.startSec) continue;
            // 🔴 採否は中点で。start 基準なら重複し、end 基準なら欠落する
            if (middle < lowerBound || middle >= upperBound) continue;
            segments.push({
                text: annotation.text,
                startSec,
                endSec,
                speaker: annotation.speaker,
                chunkIndex: chunk.index,
            });
        }
    }

    return { segments, gaps };
};

/**
 * 結合後に期待されるカバー時間 ＝ Σ(チャンク長) − Σ(オーバーラップ長) − Σ(プレフィックス長)。
 * （チャンク長は「API に送った音声の長さ」＝ prefixSec + 本体長。式は代数的には本体の総スパンに等しい）
 *
 * ⚠️ 総発話時間ではない。商談には移動・雑談・無音が含まれ、発話時間 < 尺。
 */
export const expectedCoverageSec = (chunks: MergeChunk[]): number => {
    const ordered = [...chunks].sort(byIndex);
    if (ordered.length === 0) return 0;

    let totalChunkSec = 0;
    let totalPrefixSec = 0;
    let totalOverlapSec = 0;
    for (let i = 0; i < ordered.length; i += 1) {
        const chunk = ordered[i];
        const bodySec = Math.max(0, effectiveEndSec(chunk) - chunk.startSec);
        totalChunkSec += chunk.prefixSec + bodySec;
        totalPrefixSec += chunk.prefixSec;
        const next = ordered[i + 1];
        if (next) {
            totalOverlapSec += Math.max(0, effectiveEndSec(chunk) - next.startSec);
        }
    }
    return totalChunkSec - totalOverlapSec - totalPrefixSec;
};

/** 全チャンクを通じた「1 チャンク内の話者の異なり数」の最大値 */
export const maxSpeakersPerChunk = (chunks: MergeChunk[]): number => {
    let max = 0;
    for (const chunk of chunks) {
        const speakers = new Set<string>();
        for (const annotation of chunk.annotations) {
            if (annotation.speaker) speakers.add(annotation.speaker);
        }
        if (speakers.size > max) max = speakers.size;
    }
    return max;
};

export interface MergeInvariantOptions {
    /**
     * カバー時間の許容誤差（秒）。冒頭・末尾の無音の分だけカバー時間は尺より短くなるので、
     * 下振れの許容として使う。上振れ（尺を超える）は 0.5 秒しか許さない ＝ 時刻計算のバグ。
     */
    coverageToleranceSec?: number;
}

export interface MergeInvariantResult {
    ok: boolean;
    violations: string[];
    coverageSec: number;
    expectedCoverageSec: number;
    speakerCount: number;
    maxSpeakersPerChunk: number;
}

/** 結合後の尺の上振れ許容。時刻計算がずれていればここを必ず超える */
const COVERAGE_OVERSHOOT_TOLERANCE_SEC = 0.5;

/**
 * 結合結果の不変条件を検査する（設計 §3.4）。
 * (a) start が単調非減少 / (b) カバー時間 ≒ 期待値 / (c) 話者の異なり数 ≤ チャンク内最大値
 */
export const checkMergeInvariants = (
    merged: MergedTranscript,
    chunks: MergeChunk[],
    options: MergeInvariantOptions = {},
): MergeInvariantResult => {
    const { coverageToleranceSec = 120 } = options;
    const violations: string[] = [];
    const { segments } = merged;

    // (a) start が単調非減少
    for (let i = 1; i < segments.length; i += 1) {
        if (segments[i].startSec < segments[i - 1].startSec) {
            violations.push(
                `(a) start が単調非減少でない: #${i - 1} ${segments[i - 1].startSec}s → #${i} ${segments[i].startSec}s`,
            );
            break;
        }
    }

    // (b) カバー時間 ＝ 最初の発話 start 〜 最後の発話 end
    const expected = expectedCoverageSec(chunks);
    let coverage = 0;
    if (segments.length > 0) {
        let minStart = Number.POSITIVE_INFINITY;
        let maxEnd = Number.NEGATIVE_INFINITY;
        for (const segment of segments) {
            if (segment.startSec < minStart) minStart = segment.startSec;
            if (segment.endSec > maxEnd) maxEnd = segment.endSec;
        }
        coverage = maxEnd - minStart;
    }
    if (coverage > expected + COVERAGE_OVERSHOOT_TOLERANCE_SEC) {
        violations.push(
            `(b) カバー時間が尺を超えている: ${coverage.toFixed(3)}s > ${expected.toFixed(3)}s（時刻計算のバグ。プレフィックス長の引き忘れなど）`,
        );
    } else if (coverage < expected - coverageToleranceSec) {
        violations.push(
            `(b) カバー時間が期待値より ${(expected - coverage).toFixed(3)}s 短い: ${coverage.toFixed(3)}s vs ${expected.toFixed(3)}s`,
        );
    }

    // (c) 話者の異なり数
    const speakers = new Set<string>();
    for (const segment of segments) {
        if (segment.speaker) speakers.add(segment.speaker);
    }
    const perChunkMax = maxSpeakersPerChunk(chunks);
    if (speakers.size > perChunkMax) {
        violations.push(`(c) 話者の異なり数 ${speakers.size} がチャンク内最大 ${perChunkMax} を超えている`);
    }

    return {
        ok: violations.length === 0,
        violations,
        coverageSec: coverage,
        expectedCoverageSec: expected,
        speakerCount: speakers.size,
        maxSpeakersPerChunk: perChunkMax,
    };
};

// ---------------------------------------------------------------------------
// Markdown 整形（設計 §6.1）
// ---------------------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 表示用の時刻。1 時間未満は MM:SS、1 時間以上は H:MM:SS */
export const formatTimestamp = (seconds: number): string => {
    const total = Math.floor(Math.max(0, seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(secs)}` : `${pad2(minutes)}:${pad2(secs)}`;
};

/** 本文に埋め込む時刻リンク。components.a の上書きだけで再生に繋げるための形 */
export const formatTimestampLink = (seconds: number): string => {
    const whole = Math.floor(Math.max(0, seconds));
    return `[${formatTimestamp(whole)}](#t=${whole})`;
};

const ASCII_WORD_EDGE = /[0-9A-Za-z]/;

/** 日本語は詰めて連結し、英数字どうしの境目にだけ空白を入れる */
const joinText = (left: string, right: string): string => {
    if (left === '') return right;
    if (right === '') return left;
    const needsSpace = ASCII_WORD_EDGE.test(left.slice(-1)) && ASCII_WORD_EDGE.test(right.slice(0, 1));
    return needsSpace ? `${left} ${right}` : left + right;
};

export interface TranscriptMarkdownOptions {
    /** `spk:0` → `営業` のような表示名。未登録の話者 ID はそのまま出す */
    speakerLabels?: Record<string, string>;
    /**
     * 同じ話者でもこの秒数より長く空いたら段落を分ける。既定は分けない（話者が変わったときだけ分ける）。
     */
    paragraphBreakGapSec?: number;
    /**
     * 🔴 主エンジン (MAI) が落ちて Gemini で起こした区間（設計 §3.7）。
     *
     * **用語集は MAI でしか効かない**ので、この区間だけ用語の反映が弱い。
     * ログにだけ残しても利用者には見えないため、**本文に注記として出す**。
     * 表記が揺れている理由が読み手に分かるようにするのが目的で、
     * 欠落（`gaps`）とは別物なので文言も分ける。
     */
    fallbackRanges?: readonly { startSec: number; endSec: number }[];
}

interface Paragraph {
    startSec: number;
    speaker: string | null;
    text: string;
    lastEndSec: number;
}

/** 失敗チャンクの注記。読みの流れを切らないよう、赤や感嘆符で埋めない */
export const formatGapNote = (gap: MergedGap): string =>
    `　　　⚠ ${formatTimestamp(gap.startSec)} 〜 ${formatTimestamp(gap.endSec)} は文字起こしできませんでした。［再試行］`;

/**
 * フォールバック区間の注記。
 * 🔴 欠落（`formatGapNote`）と混同させない — **本文は取れている**。
 * 「失敗した」と読めると、利用者が要らない再試行をする。
 */
export const formatFallbackNote = (range: { startSec: number; endSec: number }): string =>
    `　　　ⓘ ${formatTimestamp(range.startSec)} 〜 ${formatTimestamp(range.endSec)} は`
    + `別の文字起こしサービスで処理しました。用語集の表記が反映されていない場合があります。`;

/** 結合結果を、既存の文書としてそのまま保存できる Markdown にする */
export const toTranscriptMarkdown = (
    merged: MergedTranscript,
    options: TranscriptMarkdownOptions = {},
): string => {
    const {
        speakerLabels = {},
        paragraphBreakGapSec = Number.POSITIVE_INFINITY,
        fallbackRanges = [],
    } = options;

    const renderParagraph = (paragraph: Paragraph): string => {
        const label = paragraph.speaker
            ? ` **${speakerLabels[paragraph.speaker] ?? paragraph.speaker}**`
            : '';
        return `${formatTimestampLink(paragraph.startSec)}${label} ${paragraph.text}`;
    };

    // 失敗チャンクの注記は、その区間の位置（開始秒）に差し込む。注記は必ず段落を分ける
    const gaps = [...merged.gaps].sort((a, b) => a.startSec - b.startSec);
    const fallbacks = [...fallbackRanges].sort((a, b) => a.startSec - b.startSec);
    const blocks: string[] = [];
    let current: Paragraph | null = null;
    let gapCursor = 0;
    let fallbackCursor = 0;

    const flush = () => {
        if (current) blocks.push(renderParagraph(current));
        current = null;
    };

    for (const segment of merged.segments) {
        while (gapCursor < gaps.length && gaps[gapCursor].startSec <= segment.startSec) {
            flush();
            blocks.push(formatGapNote(gaps[gapCursor]));
            gapCursor += 1;
        }
        // フォールバック区間の注記も、その区間の開始位置に差し込む
        while (fallbackCursor < fallbacks.length
            && fallbacks[fallbackCursor].startSec <= segment.startSec) {
            flush();
            blocks.push(formatFallbackNote(fallbacks[fallbackCursor]));
            fallbackCursor += 1;
        }
        const continues =
            current !== null &&
            current.speaker === segment.speaker &&
            segment.startSec - current.lastEndSec <= paragraphBreakGapSec;
        if (current !== null && continues) {
            current.text = joinText(current.text, segment.text);
            current.lastEndSec = Math.max(current.lastEndSec, segment.endSec);
            continue;
        }
        flush();
        current = {
            startSec: segment.startSec,
            speaker: segment.speaker,
            text: segment.text,
            lastEndSec: segment.endSec,
        };
    }
    flush();
    // 🔴 末尾に残った注記も必ず出す。ここを忘れると、最後のチャンクが
    //    フォールバックしたときだけ注記が消える（黙って情報が落ちる）
    while (gapCursor < gaps.length) {
        blocks.push(formatGapNote(gaps[gapCursor]));
        gapCursor += 1;
    }
    while (fallbackCursor < fallbacks.length) {
        blocks.push(formatFallbackNote(fallbacks[fallbackCursor]));
        fallbackCursor += 1;
    }

    return blocks.join('\n\n');
};

// ---------------------------------------------------------------------------
// 逆方向: Markdown から時刻を読む（graceful degradation）
// ---------------------------------------------------------------------------

/**
 * `#t=<秒>` の href を秒に直す。読めなければ null（クリックできないだけで、文書としては読める）。
 */
export const parseTimestampHref = (href: string | null | undefined): number | null => {
    if (typeof href !== 'string') return null;
    const matched = /^#t=(\d+(?:\.\d+)?)$/.exec(href.trim());
    if (!matched) return null;
    const seconds = Number(matched[1]);
    return Number.isFinite(seconds) ? seconds : null;
};

export interface ParsedTimestamp {
    /** 秒 */
    sec: number;
    /** リンクの表示文字列（`01:20:00` など） */
    display: string;
    /** 本文中の文字位置 */
    offset: number;
}

const TIMESTAMP_LINK = /\[([^\]\n]*)\]\(#t=([^)\s]*)\)/g;

/**
 * 本文から時刻リンクを拾う。利用者が編集して壊した行は、単に拾えないだけで例外にしない。
 */
export const parseTranscriptTimestamps = (markdown: string): ParsedTimestamp[] => {
    if (typeof markdown !== 'string' || markdown === '') return [];
    const found: ParsedTimestamp[] = [];
    TIMESTAMP_LINK.lastIndex = 0;
    let matched = TIMESTAMP_LINK.exec(markdown);
    while (matched !== null) {
        const sec = parseTimestampHref(`#t=${matched[2]}`);
        if (sec !== null) {
            found.push({ sec, display: matched[1], offset: matched.index });
        }
        matched = TIMESTAMP_LINK.exec(markdown);
    }
    return found;
};

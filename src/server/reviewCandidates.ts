/**
 * 要確認候補（低信頼・認識結果要確認の句）の**抽出だけ**を行う純関数群（設計 §B2・2026-09-05）。
 *
 * 入力は永続化レーンが Azure バッチ結果（`recognizedPhrases`）から作った「解析済みの句情報」
 * （`ReviewPhraseInput`）。ここでは Azure の生 JSON を再解析しない。出力は凍結契約 `TranscriptReview`。
 *
 * 🔴 「低信頼＝誤り」「候補ゼロ＝正確」ではない。高い confidence は正確さの保証ではなく、話者誤り・
 *    発話抜けは検出できない。この関数は候補を挙げるだけで、正確さを判定しない（候補にしないだけ）。
 * 🔴 confidence 欠損・範囲外・非数値・NaN は「不明」。高信頼にも 0 の低信頼にも置換しない。
 * 🔴 読めない時刻を 0 秒にしない。時刻不明でも候補になり得る（再生・本文移動は後段 UI が無効化する）。
 * 🔴 `paragraphStartLine` はここでは付けない（永続化レーンが Markdown 生成時に対応付けて補う）。
 * 🔴 Firestore は `undefined` 値を拒否するので、取れなかった任意項目はキー自体を置かない。
 * 🔴 候補を保存予算で減らしても summary の総件数は全句から算出した値を保ち、`savedCandidates` に実保存数。
 * 🔴 永続化レーンは `paragraphStartLine` を補った後に `applyReviewBudget` を再適用する（アンカー分のバイト増）。
 */
import {
    LOW_CONFIDENCE_THRESHOLD,
    REVIEW_EXCERPT_MAX_CHARS,
    REVIEW_MAX_CANDIDATES,
    REVIEW_MAX_JSON_BYTES,
    TRANSCRIPT_REVIEW_VERSION,
    type ReviewCandidate,
    type ReviewReason,
    type ReviewSummary,
    type TranscriptReview,
} from '@/lib/transcriptReviewContract';

/**
 * 永続化レーンが `recognizedPhrases[]` の 1 句から作って渡す「解析済みの句情報」。
 * 値の妥当性（有限か・範囲内か）はこちらで検査するので、呼び出し側は読めた値をそのまま置けばよい。
 */
export interface ReviewPhraseInput {
    /** 元 `recognizedPhrases` の配列 index（`phraseId` の元）。🔴 非負整数以外は TypeError */
    index: number;
    /** `nBest[0].display`。空文字あり（取れなければ空文字） */
    text: string;
    /** `nBest[0].confidence`。有限の 0〜1 のみ有効。それ以外は「不明」 */
    confidence?: number;
    /** 句の `recognitionStatus`。ジョブ status と混同しない */
    recognitionStatus?: string;
    /** `"spk:N"`。話者分離が効いていなければ null/undefined */
    speaker?: string | null;
    /** 秒。読めた句だけ持つ（読めない時刻を 0 にしない） */
    startSec?: number;
    endSec?: number;
}

export interface BuildReviewCandidatesOptions {
    /** 低信頼の閾値（既定 `LOW_CONFIDENCE_THRESHOLD`）。有限の 0〜1 以外は RangeError */
    threshold?: number;
    /**
     * 分かっている結果音声長（秒）。有限の正数のときだけ有効で、開始がこれを超える時刻は「読めない」
     * 扱いにする（不正時刻を再生に使わない・仕様 B2）。0 や未指定は「長さ不明」として無視する。
     */
    audioSec?: number;
}

/** `availability === 'unavailable'` の理由コード。UI の文言対応に使う（契約上は string）。 */
export type ReviewUnavailableReason =
    | 'no_phrases'       // 抽出材料（句）が 1 つも無い
    | 'internal_error'   // 抽出中の内部エラー（候補配列を作れなかった）
    | 'storage_budget';  // 永続化側の保存予算不足（完全形を文書に載せられない）

/**
 * Azure Speech の句 `recognitionStatus` の既知値。`Success` 以外の既知値は「認識結果要確認」。
 * ここに無い文字列・欠落は「認識状態不明」として数え、それだけでは候補にしない。
 */
export const KNOWN_RECOGNITION_STATUSES: ReadonlySet<string> = new Set([
    'Success',
    'Failure',
    'NoMatch',
    'InitialSilenceTimeout',
    'BabbleTimeout',
    'Error',
]);

const SUCCESS_STATUS = 'Success';

type StatusKind = 'success' | 'flagged' | 'unknown';

interface ClassifiedStatus {
    kind: StatusKind;
    /** 文字列として読めたときだけ（欠落は undefined）。未知の文字列もそのまま保持する */
    status?: string;
}

const classifyStatus = (raw: unknown): ClassifiedStatus => {
    const status = typeof raw === 'string' ? raw.trim() : '';
    if (status === '') return { kind: 'unknown' };
    if (status === SUCCESS_STATUS) return { kind: 'success', status };
    if (KNOWN_RECOGNITION_STATUSES.has(status)) return { kind: 'flagged', status };
    return { kind: 'unknown', status };
};

/** 有限の 0〜1 だけを有効な confidence とする。非数値・NaN・範囲外は undefined（不明）。 */
const toValidConfidence = (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined;

/** 有限かつ 0 <= start <= end（さらに音声長が分かれば start <= audioSec）のときだけ時刻を返す。 */
const toValidTime = (
    start: unknown,
    end: unknown,
    audioSec: number | undefined,
): { startSec: number; endSec: number } | undefined => {
    if (typeof start !== 'number' || typeof end !== 'number') return undefined;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    if (start < 0 || start > end) return undefined;
    if (audioSec !== undefined && start > audioSec) return undefined;
    return { startSec: start, endSec: end };
};

const resolveThreshold = (threshold: number | undefined): number => {
    if (threshold === undefined) return LOW_CONFIDENCE_THRESHOLD;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new RangeError('threshold は有限の 0〜1 で指定してください');
    }
    return threshold;
};

const resolveAudioSec = (audioSec: number | undefined): number | undefined =>
    typeof audioSec === 'number' && Number.isFinite(audioSec) && audioSec > 0 ? audioSec : undefined;

/** 抜粋は文字（コードポイント）単位で切る。サロゲートペアを途中で割らない。 */
const buildExcerpt = (text: string): { excerpt: string; excerptTruncated: boolean } => {
    const chars = Array.from(text);
    if (chars.length <= REVIEW_EXCERPT_MAX_CHARS) return { excerpt: text, excerptTruncated: false };
    return { excerpt: chars.slice(0, REVIEW_EXCERPT_MAX_CHARS).join(''), excerptTruncated: true };
};

/** 句 index から決定的に採番する（同一結果の再取り込みで同じ ID）。 */
export const phraseIdFor = (index: number): string => {
    if (!Number.isInteger(index) || index < 0) {
        throw new TypeError('ReviewPhraseInput.index は非負整数（recognizedPhrases の配列 index）で渡してください');
    }
    return `p${index}`;
};

const emptySummary = (): ReviewSummary => ({
    totalPhrases: 0,
    lowConfidence: 0,
    recognitionFlagged: 0,
    candidateTotal: 0,
    unknownConfidence: 0,
    unknownRecognitionStatus: 0,
    noTimeCandidates: 0,
    savedCandidates: 0,
});

/** 保存予算の判定に使う UTF-8 JSON サイズ（バイト）。永続化側の見積りにも使える。 */
export function measureReviewJsonBytes(review: TranscriptReview): number {
    const json = JSON.stringify(review);
    return typeof Buffer !== 'undefined'
        ? Buffer.byteLength(json, 'utf8')
        : new TextEncoder().encode(json).byteLength;
}

/**
 * 素材が無い／候補配列を作れないときの最小形。summary は契約上必須なので 0 で埋めるが、
 * `availability === 'unavailable'` のときの summary は「算出値」ではない（UI は summary を出さない）。
 */
export function buildUnavailableReview(
    sourceJobId: string,
    sourceTextHash: string,
    reason: string,
    threshold: number = LOW_CONFIDENCE_THRESHOLD,
): TranscriptReview {
    return {
        version: TRANSCRIPT_REVIEW_VERSION,
        threshold,
        sourceTextHash,
        sourceJobId,
        summary: emptySummary(),
        availability: 'unavailable',
        unavailableReason: reason,
        candidates: [],
    };
}

interface OrderedCandidate {
    candidate: ReviewCandidate;
    index: number;
    /** 時刻のある候補だけ持つ */
    startSec?: number;
}

/**
 * 句配列から要確認候補と集計を作る。副作用なし・決定的（同じ入力なら同じ出力）。
 *
 * 判定規則（仕様 B2）:
 * - `Success` かつ有効 confidence < 閾値 → `low_confidence`（ちょうどは含めない）
 * - 既知の非 `Success` の recognitionStatus → `recognition_status`（confidence は見ない）
 * - `Success` だが表示テキストが空 → `empty_text`
 * - recognitionStatus 欠落／未知でも有効 confidence < 閾値 → `low_confidence` + `unknown_confidence`
 *   （契約の補助理由。「認識状態不明」の印であって confidence が無いという意味ではない）
 * - 有効 confidence が無く、recognitionStatus にも判定材料が無い句は候補にしない（不明として集計のみ）
 * - 1 句に複数理由でも候補は 1 件。候補総数は ID の和集合
 *
 * 保存予算: 時刻あり候補を時刻昇順（同時刻は index 順）、その後に時刻なしを index 順で並べ、
 * `REVIEW_MAX_CANDIDATES` 件かつ JSON `REVIEW_MAX_JSON_BYTES` バイト以内に収まるまで末尾を落とす。
 * 落としたら `partial`、全件なら `complete`。句が 0 件なら `unavailable`（reason `no_phrases`）。
 *
 * @throws RangeError 閾値が有限の 0〜1 でない
 * @throws TypeError  index が非負整数でない（呼び出し側の契約違反）
 */
export function buildReviewCandidates(
    phrases: readonly ReviewPhraseInput[],
    sourceJobId: string,
    sourceTextHash: string,
    options: BuildReviewCandidatesOptions = {},
): TranscriptReview {
    const threshold = resolveThreshold(options.threshold);
    if (!Array.isArray(phrases) || phrases.length === 0) {
        return buildUnavailableReview(sourceJobId, sourceTextHash, 'no_phrases', threshold);
    }
    const audioSec = resolveAudioSec(options.audioSec);

    const summary = emptySummary();
    const ids = new Set<string>();
    const timed: OrderedCandidate[] = [];
    const untimed: OrderedCandidate[] = [];

    for (const phrase of phrases) {
        summary.totalPhrases += 1;
        const confidence = toValidConfidence(phrase.confidence);
        if (confidence === undefined) summary.unknownConfidence += 1;
        const status = classifyStatus(phrase.recognitionStatus);
        if (status.kind === 'unknown') summary.unknownRecognitionStatus += 1;
        const text = typeof phrase.text === 'string' ? phrase.text.trim() : '';

        // 理由は契約の宣言順で並べる（決定的な出力）
        const reasons: ReviewReason[] = [];
        const isLowConfidence = status.kind !== 'flagged' && confidence !== undefined && confidence < threshold;
        if (isLowConfidence) reasons.push('low_confidence');
        if (status.kind === 'flagged') reasons.push('recognition_status');
        if (status.kind === 'success' && text === '') reasons.push('empty_text');
        if (isLowConfidence && status.kind === 'unknown') reasons.push('unknown_confidence');
        if (reasons.length === 0) continue;

        if (isLowConfidence) summary.lowConfidence += 1;
        if (status.kind === 'flagged' || reasons.includes('empty_text')) summary.recognitionFlagged += 1;

        const phraseId = phraseIdFor(phrase.index);
        if (ids.has(phraseId)) continue; // 同じ index が二重に渡っても候補は 1 件（ID の和集合）
        ids.add(phraseId);

        const candidate: ReviewCandidate = { phraseId, reasons, ...buildExcerpt(text) };
        if (confidence !== undefined) candidate.confidence = confidence;
        if (status.status !== undefined) candidate.recognitionStatus = status.status;
        if (typeof phrase.speaker === 'string' && phrase.speaker !== '') candidate.speaker = phrase.speaker;

        const time = toValidTime(phrase.startSec, phrase.endSec, audioSec);
        if (time) {
            candidate.startSec = time.startSec;
            candidate.endSec = time.endSec;
            timed.push({ candidate, index: phrase.index, startSec: time.startSec });
        } else {
            summary.noTimeCandidates += 1;
            untimed.push({ candidate, index: phrase.index });
        }
    }
    summary.candidateTotal = ids.size;

    timed.sort((a, b) => (a.startSec as number) - (b.startSec as number) || a.index - b.index);
    untimed.sort((a, b) => a.index - b.index);
    const ordered = [...timed, ...untimed].map((entry) => entry.candidate);

    return applyReviewBudget({
        version: TRANSCRIPT_REVIEW_VERSION,
        threshold,
        sourceTextHash,
        sourceJobId,
        summary,
        availability: 'complete',
        candidates: ordered,
    });
}

/**
 * 保存予算を（再）適用する純関数。候補を `REVIEW_MAX_CANDIDATES` 件に切り、JSON（UTF-8）が
 * `REVIEW_MAX_JSON_BYTES` に収まるまで末尾（並び順の後方）から落とし、`savedCandidates` と
 * `availability`（全件なら complete・省略したら partial）を整える。summary の総件数は変えない。
 *
 * 🔴 `buildReviewCandidates` の内部でも使うが、永続化レーンが `paragraphStartLine` を補った**後**にも
 *    必ず呼ぶこと。アンカーは 1 件あたり数十バイト増えるので、抽出時に上限ぎりぎりだった候補は最終形で
 *    超え得る。`savedCandidates`/`availability` を反映した最終形そのものを毎回測る（過小評価を残さない）。
 * `availability === 'unavailable'` はそのまま返す（summary(0) から complete に化けさせない）。
 */
export function applyReviewBudget(review: TranscriptReview): TranscriptReview {
    if (review.availability === 'unavailable') return review;
    const result: TranscriptReview = {
        ...review,
        summary: { ...review.summary },
        candidates: review.candidates.slice(0, REVIEW_MAX_CANDIDATES),
    };
    const settle = (): void => {
        result.summary.savedCandidates = result.candidates.length;
        result.availability =
            result.summary.savedCandidates === result.summary.candidateTotal ? 'complete' : 'partial';
    };
    settle();
    while (result.candidates.length > 0 && measureReviewJsonBytes(result) > REVIEW_MAX_JSON_BYTES) {
        result.candidates = result.candidates.slice(0, -1);
        settle();
    }
    return result;
}

/**
 * 本文完成を候補表示のために失敗させないための入口。`buildReviewCandidates` が投げたら
 * `unavailable`（reason `internal_error`）を返す。永続化レーンはこちらを呼べばよい。
 */
export function buildReviewCandidatesSafe(
    phrases: readonly ReviewPhraseInput[],
    sourceJobId: string,
    sourceTextHash: string,
    options: BuildReviewCandidatesOptions = {},
): TranscriptReview {
    try {
        return buildReviewCandidates(phrases, sourceJobId, sourceTextHash, options);
    } catch {
        return buildUnavailableReview(sourceJobId, sourceTextHash, 'internal_error');
    }
}

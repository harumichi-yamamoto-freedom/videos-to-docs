/**
 * 「要確認箇所」（低信頼・認識結果要確認の句）のデータ契約（設計 §B2・2026-09-05）。
 *
 * 🔴 バッチは部分再実行ができないので、これは「再試行」ではなく**要確認箇所の可視化**の素材。
 *    Azure 結果の句ごとの confidence / recognitionStatus から生成時に作り、完成文書に保存する。
 * 🔴 「低信頼＝誤り」「候補ゼロ＝正確」とは表現しない。高信頼の誤りも話者誤り・発話抜けも検出できない。
 *
 * この型は 2 レーン（抽出＝pure／永続化＝seam）が共有する凍結契約。両レーンとも編集しない。
 */

/** 現在の候補抽出・アンカー形式の版。閾値やアンカー方式を変えたら上げる。 */
export const TRANSCRIPT_REVIEW_VERSION = 1;

/** 低信頼と判定する confidence の暫定閾値（未校正・誤認識の実測境界ではない）。ちょうどは含めない。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

/** 原文抜粋の初期上限（文字）。超えたら省略フラグを立てる。 */
export const REVIEW_EXCERPT_MAX_CHARS = 300;

/** 保存する候補の初期上限（件）。UI の初期予算であって Azure の制約ではない。 */
export const REVIEW_MAX_CANDIDATES = 200;

/** transcriptReview の UTF-8 JSON サイズ上限（バイト）。Firestore 1MiB 文書の一部としての予算。 */
export const REVIEW_MAX_JSON_BYTES = 128 * 1024;

/** 候補が要確認になった理由。1 句に複数付き得るが件数は 1。 */
export type ReviewReason =
    | 'low_confidence'       // recognitionStatus=Success かつ confidence < 閾値
    | 'recognition_status'   // 既知の非 Success の recognitionStatus
    | 'empty_text'           // Success だが表示テキストが空
    | 'unknown_confidence';  // recognitionStatus 不明だが confidence も無く自動評価不能ではない補助

/** 要確認候補 1 件。confidence/時刻/話者は取れたときだけ持つ。 */
export interface ReviewCandidate {
    /** 元 recognizedPhrases の配列 index から決定的に採番（同一結果の再取り込みで同じ ID） */
    phraseId: string;
    reasons: ReviewReason[];
    /** 句の原文抜粋（REVIEW_EXCERPT_MAX_CHARS まで）。取得不能なら空文字＋truncated=false */
    excerpt: string;
    /** 抜粋が上限で切られたか。実際の認識欠落と混同しない */
    excerptTruncated: boolean;
    confidence?: number;
    recognitionStatus?: string;
    speaker?: string | null;
    startSec?: number;
    endSec?: number;
    /** 生成 Markdown 上の該当段落の開始行（1 始まり）。対応が確定しない句は付けない */
    paragraphStartLine?: number;
}

/** 候補件数の内訳。カテゴリに重複があるため候補総数は ID の和集合で数える。 */
export interface ReviewSummary {
    totalPhrases: number;
    lowConfidence: number;
    recognitionFlagged: number;
    /** 重複を除いた候補総数（ID の和集合） */
    candidateTotal: number;
    unknownConfidence: number;
    unknownRecognitionStatus: number;
    noTimeCandidates: number;
    /** 実際に保存できた候補件数（上限で減ることがある） */
    savedCandidates: number;
}

export type ReviewAvailability = 'complete' | 'partial' | 'unavailable';

/** 完成文書に保存する要確認データ。旧文書ではフィールドごと無い。 */
export interface TranscriptReview {
    version: number;
    threshold: number;
    /** 保存した生成 Markdown の UTF-8 バイト列に対する SHA-256（改行含む厳密一致判定用） */
    sourceTextHash: string;
    /** どの生成結果に属するか（新ジョブと旧候補を混ぜない） */
    sourceJobId: string;
    summary: ReviewSummary;
    availability: ReviewAvailability;
    /** availability==='unavailable' のときだけ短い理由コード */
    unavailableReason?: string;
    candidates: ReviewCandidate[];
}

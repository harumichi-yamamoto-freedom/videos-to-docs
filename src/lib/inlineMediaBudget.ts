/**
 * S2-1: Gemini generateContent へ inlineData (Base64) で送れる量の予算。
 *
 * Google 公表の request 上限は 20MB (Base64 化したメディア + プロンプト + JSON 封筒の合計)。
 * 上限に張り付けると単位の解釈や封筒サイズの差で落ちるため、余裕を引いた予算で判定し、
 * 超える分は Files API (ai.files.upload) へ迂回する。ここは SDK に依存しない純関数だけを置く。
 */
export const GEMINI_INLINE_REQUEST_LIMIT_BYTES = 20 * 1024 * 1024;

/** JSON 封筒 (キー名・モデル名・thinkingConfig 等) と計測誤差の余裕 */
export const INLINE_REQUEST_SAFETY_MARGIN_BYTES = 4 * 1024 * 1024;

/** inline で送る request (Base64 + プロンプト) の予算。これを超えたら Files API へ */
export const INLINE_REQUEST_BUDGET_BYTES =
    GEMINI_INLINE_REQUEST_LIMIT_BYTES - INLINE_REQUEST_SAFETY_MARGIN_BYTES;

export type MediaTransport = 'inline' | 'files_api';

/** バイト列を Base64 化したときの文字数 (3 バイト → 4 文字、末尾はパディング) */
export const base64LengthForBytes = (bytes: number): number =>
    Math.ceil(Math.max(0, bytes) / 3) * 4;

/** JSON 本文に載る UTF-8 バイト数。日本語は 1 文字 3 バイトなので length では過小評価になる */
export const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).length;

export const estimateInlineRequestBytes = (base64Length: number, promptBytes = 0): number =>
    base64Length + promptBytes;

/**
 * inline (Base64) で送るか Files API へ迂回するかを、generateContent を呼ぶ前にサイズだけで決める。
 * 予算ちょうどは inline (境界は「超えたら迂回」)。
 */
export const selectMediaTransport = (
    base64Length: number,
    promptBytes = 0,
    budgetBytes: number = INLINE_REQUEST_BUDGET_BYTES,
): MediaTransport =>
    estimateInlineRequestBytes(base64Length, promptBytes) <= budgetBytes ? 'inline' : 'files_api';

/** ffmpeg 形式のビットレート文字列 ('128k' / '128kbps' / '128000') を kbps に直す。解釈できなければ null */
export const parseBitrateKbps = (bitrate: string): number | null => {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(k(?:bps)?)?\s*$/i.exec(bitrate);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return match[2] ? value : value / 1000;
};

/**
 * そのビットレートで inline 予算に収まる録音の長さ (分・切り捨て)。
 * 利用者に「約N分を超えると失敗します」と伝えるための目安で、CBR を仮定する。
 */
export const estimateInlineLimitMinutes = (
    bitrate: string,
    promptBytes = 0,
    budgetBytes: number = INLINE_REQUEST_BUDGET_BYTES,
): number | null => {
    const kbps = parseBitrateKbps(bitrate);
    if (kbps === null) return null;
    const maxMediaBytes = Math.floor((Math.max(0, budgetBytes - promptBytes) * 3) / 4);
    const bytesPerSecond = (kbps * 1000) / 8;
    return Math.floor(maxMediaBytes / bytesPerSecond / 60);
};

/**
 * inline 予算超過を利用者に伝える文言。「大きすぎます」で終わらせず、自分で打てる手を示す。
 * ビットレートが分かるときは分数で、分からないときはサイズで目安を出す。
 */
export const describeInlineBudgetExceeded = (bitrate?: string): string => {
    const minutes = bitrate ? estimateInlineLimitMinutes(bitrate) : null;
    if (bitrate && minutes !== null) {
        return `音声・動画データが大きすぎるため、そのままでは送信できません。ビットレート ${bitrate} では約${minutes}分を超えると失敗します。ビットレートを下げるか、ファイルを分割してください。`;
    }
    const maxMediaMb = Math.floor((INLINE_REQUEST_BUDGET_BYTES * 3) / 4 / 1024 / 1024);
    return `音声・動画データが大きすぎるため、そのままでは送信できません（そのまま送れる上限の目安: 約${maxMediaMb}MB）。ビットレートを下げるか、ファイルを分割してください。`;
};

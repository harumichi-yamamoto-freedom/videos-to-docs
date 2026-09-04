/**
 * 全文文字起こし (gemini-3.5-transcribe / 分割前提) のチャンク単位 品質ゲート G1〜G8。
 *
 * 実測の背景 (設計 §1.3 / §1.8 / §4、較正 `videos-to-docs_文字起こし品質ゲート較正_2026-09-03.md`):
 * 同一音声・同一設定でも結果が壊れる。しかも壊れ方の多くが `status: "completed"` を返す。
 * したがって `status` の確認だけでは不十分で、本文の構造・注釈の時刻・発話秒数から検査する必要がある。
 *
 * ここに置くのは副作用のない純関数だけ。API 呼び出し・再試行の制御は上位層 (設計 §4.3) の仕事。
 * 判定に使った実測値も一緒に返す — 再試行の判断とログに要るため。
 *
 * 🔴 **これらの検査は、リクエストが正しく組まれていることを前提とする。呼び出し側は preflight で
 * 設定が効いていることを assert すること。** `diarization_mode` と `timestamp_granularities` は
 * API 側で値が検証されず、綴りを間違えても 400 にならず「話者ラベルが全部 null」「注釈 0 件」が 200 で返る (実測)。
 * そのため G7 (話者が 1 種類のみ) と G8 (カバレッジ) が落ちたとき、原因が「モデルの失敗」なのか
 * 「呼び出し側の綴り間違い」なのかを、このモジュールだけでは区別できない。
 */
import { deflateSync } from 'node:zlib';

/** 注釈 1 本 (`annotations[]`。`timestamp_granularities` が有効なときだけ返る) */
export interface TranscriptAnnotation {
    text: string;
    startOffsetSec: number;
    endOffsetSec: number;
    /** 話者ラベル (`spk:0` 等)。話者分離が無効・未付与なら null */
    speaker: string | null;
}

/** 1 チャンクぶんの文字起こし結果 */
export interface ChunkResult {
    /** `completed` / `incomplete` など、API が返した状態 */
    status: string;
    /** 本文 */
    text: string;
    annotations: TranscriptAnnotation[];
    /** このチャンクの音声長 (秒) */
    audioSec: number;
    /** VAD (silencedetect / Silero VAD) で測った発話秒数 */
    speechSec: number;
    /**
     * VAD で測った**発話区間**。チャンク先頭を 0 とした `[開始秒, 終了秒]` の並び。
     *
     * 🔴 **G6 はこれが無いと走らない (indeterminate になる)。** `speechSec` (総量) では代替できない。
     * 2026-09-04 の較正で、`speechSec` を分母に使う旧 G6 が**分母の側で壊れていた**ことが分かった
     * (背景音・移動音・衣擦れを発話と数え、発話率 77% の音源が最も成績が悪く見えた)。
     * 区間で持てば「注釈が空いている連続区間」だけを見られるので、VAD が多少ノイズを拾っても判定が反転しない。
     */
    speechIntervals?: readonly (readonly [number, number])[];
    /**
     * 出力トークン数。
     * 🔴 `usage.total_output_tokens` を使ってはいけない — **出力上限に到達した崩壊走でも常に 0 が返る** (実測)。
     * これを読むと G1 のトークン条件が永久に発火せず、静かに無効な検査になる。
     * 正しい出所は `usage.model_invocation_token_counts[].candidates_tokens_details[]` のうち
     * `modality === 'text'` の `tokenCount` の**合計** (要素が複数あり得る)。
     * 取れなかった場合は undefined を渡すこと (0 と undefined はどちらも「判定不能」として扱われ、合格にはならない)。
     */
    outputTokens?: number;
    /** 出力トークン上限 (既定 32,768) */
    outputTokenLimit?: number;
}

export type QualityGateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8';

/** 既定の閾値。すべて実測に基づく (根拠は各定数のコメント) */
export const DEFAULT_OUTPUT_TOKEN_LIMIT = 32768;

/**
 * G1: 出力トークンが上限のこの割合に達したら「上限到達 = 反復確定」。
 * 実測: 反復崩壊時に出力 32,768 トークン (上限) へ到達。10 分チャンクの正常時は上限の約 1/16 なので偽陽性はほぼ出ない。
 */
export const OUTPUT_TOKEN_LIMIT_RATIO = 0.98;

/**
 * G3: 同一ユニットがこの回数以上連続したら不合格。
 * 🔴 実測: **正常の最長連続は 6** (設計 §1.8 の「話者分離＋単語タイムスタンプ」走: completed / 1,023 文字 /
 * 圧縮率 2.48 / 最長連続 6 = 正常判定) / 崩壊の最小は 2,251。分離比は約 375 倍で、20 は両側に十分な余裕がある。
 * 🔴 国内の実装事例の値 3 は持ち込めない — あちらは**句読点を除去してフレーズ単位で完全一致を取る別の定義**で、
 * `。` `．` `、` と改行で割るわれわれの定義では正常サンプル (最長連続 6) が落ちる。
 */
export const MAX_CONSECUTIVE_UNITS = 20;

/**
 * G4: ユニーク率がこれ未満なら不合格。実測: 正常 0.893〜1.000 / 崩壊 0.000〜0.006 (149 倍の間隔)。
 */
export const MIN_UNIQUE_UNIT_RATIO = 0.5;

/**
 * G4 を適用する最小ユニット数。短い本文はユニークが偶然低く出るため、この数に満たなければ判定しない。
 */
export const MIN_UNITS_FOR_UNIQUE_RATIO = 40;

/**
 * G5: `len(utf8) / len(zlib) ` がこれを超えたら不合格。実測: 正常 2.70〜3.20 / 崩壊 75.99〜352.96。
 * 🔴 Whisper 既定の 2.4 を持ち込んではいけない — 日本語は UTF-8 で 1 文字 3 バイト、
 * かつ商談は相槌が多く自然に反復的なので、実測した正常 4 件すべてが 2.4 を超え全件偽陽性になる。
 */
export const MAX_COMPRESSION_RATIO = 8.0;

/**
 * G6 (2026-09-04 差し替え): **最長穴** — 発話区間のうち、注釈が 1 本も無い最長の連続秒数。
 * これを超えたら「本文の脱落」として不合格。
 *
 * 🔴 **旧 G6 (文字数 ÷ 発話秒数 < 1.5) は取り下げた。分母が壊れていたため** (設計 §1.11)。
 * `silencedetect` が背景音を発話と数えており、音源ごとの成績が発話率と**逆相関**していた
 * (発話率 77% の音源が最悪・49% の音源が最良)。決め手は次の矛盾:
 * 「取りこぼし率 80%、なのに注釈が 1 本も無い最長の連続区間は 3〜22 秒」— 両立しない。
 *
 * 🔴 実測 (構成 A・117 走・raw 突合済み): **最悪 43 秒 / 中央 7〜14 秒**。
 * 10 分チャンクでは 15/15 走が 24 秒以内。閾値 30 秒は正常側に余裕があり、
 * 15 分以上で出はじめる 37〜43 秒の穴を捕まえる。
 *
 * この指標は発話秒の**総量**を分母に使わない。ノイズを発話と誤認しても、
 * その区間に注釈が散っていれば穴として数えないので、**VAD の精度が多少悪くても判定が反転しない。**
 */
export const MAX_SILENT_GAP_SEC = 30;

/**
 * 旧 G6 の閾値。**判定には使わない** — 分布をログに残して後から見直すためだけに残している。
 * @deprecated 設計 §1.11。分母 (`speechSec`) が信用できないため合否に使わないこと。
 */
export const MIN_CHARS_PER_SPEECH_SEC = 1.5;

/**
 * 旧 G8 の下側 (最終注釈時刻 ÷ 音声長)。**判定には使わない。**
 *
 * 🔴 **端点判定なので両方向に誤る** (設計 §4.1・2026-09-04 改訂):
 * - 偽陰性: 冒頭と末尾だけ起こして**中を丸ごと飛ばした**走がカバレッジ 0.995 で通る
 * - 偽陽性: 取りこぼしゼロ・最長穴 5 秒・11,486 文字の**良好な走**が、
 *   壊れた注釈 1 本のせいで `coverage = 85,581` になり不合格になった
 *
 * 脱落の検査は G6 (最長穴) が担う。ここは値をレポートに残すためだけに残している。
 * @deprecated 設計 §1.11 / §4.1。
 */
export const MIN_COVERAGE_RATIO = 0.9;

/**
 * G8 の上側。最終注釈時刻が音声長のこの倍率を超えたら「時刻が暴走している」。
 *
 * 🔴 実測 (2026-09-03・較正リグ): 30 分 (1,800 秒) の音声に対し、
 * 最終注釈が **70,710 秒 (19.6 時間)** / **102,081 秒 (28 時間)** になる走があった。
 * 前者は `status: completed`・反復なし (最長連続 2)・ユニーク率 0.90・話者 4 名で、
 * **G1〜G7 をすべて通過し、下側だけを見る G8 も通過する**。
 * カバレッジを片側でしか見ないと、この失敗様式は誰も捕まえられない。
 *
 * 上限に 1.05 の余裕を持たせているのは、末尾の注釈が音声長をわずかに超えることがあるため
 * (境界の丸め)。実測の暴走は 39 倍・57 倍なので、この余裕では取り逃がさない。
 *
 * 🔴 **2026-09-04 改訂: 処分が変わった。** この倍率を超えた注釈は「走ごと不合格」ではなく
 * **その注釈だけ隔離**する。時刻の暴走は**本文の欠陥ではなくメタデータの欠陥**であり、
 * 良好な本文を捨てる理由にならない (上のコメントの実例)。走を落とすのは隔離が全体の
 * `MAX_OUT_OF_RANGE_ANNOTATION_RATIO` を超えたときだけ。
 */
export const MAX_COVERAGE_RATIO = 1.05;

/**
 * G8: 範囲外の注釈がこの割合を超えたら、時刻の並び全体が信用できないとして不合格にする。
 * 🔴 実測 (117 走): 暴走は「注釈 1〜2 本だけが桁違い」という形で出る (2,365 本中 58 本 = 2.5% が最悪)。
 * 1% は「数本の外れ値は隔離して本文と残りの時刻を使う / 並びごと壊れているなら捨てる」の境目。
 */
export const MAX_OUT_OF_RANGE_ANNOTATION_RATIO = 0.01;

/**
 * G7: 商談は最低この人数の話者が居るはず。
 *
 * 🔴 **`warn` であって `fail` ではない（2026-09-04 改訂）。**
 * 話者ラベルはメタデータであって本文ではない。落ちたチャンクを**捨てると本文ごと失われる**が、
 * 話者が付かないだけなら本文は読める（G8 の「時刻の暴走は本文の欠陥ではない」と同じ考え方）。
 *
 * 実測でこれが効く: Gemini は 10 分窓 **9 走中 3 走で話者を 1 名も返さない**（silent fail-open）。
 * G7 を fail のままにすると、**MAI が落ちて Gemini に回ったチャンクの約 3 割がゲートで捨てられ、
 * フォールバックが用をなさない**（設計 §3.7）。MAI は 11 走すべてで 2〜3 名を返しており、
 * 主エンジンが動いている限り警告は出ない。
 *
 * ⚠️ 警告が増えたら、それは「話者分離が効いていない」という**別の問題の合図**である。
 * 件数を計器で数えること。
 */
export const MIN_SPEAKERS = 2;

export interface QualityGateOptions {
    outputTokenLimit?: number;
    outputTokenLimitRatio?: number;
    maxConsecutiveUnits?: number;
    minUniqueUnitRatio?: number;
    minUnitsForUniqueRatio?: number;
    maxCompressionRatio?: number;
    /** @deprecated 旧 G6。判定には使わない (設計 §1.11) */
    minCharsPerSpeechSec?: number;
    /** G6: 注釈が 1 本も無い最長の連続発話秒。既定 30 */
    maxSilentGapSec?: number;
    /** @deprecated 旧 G8 の下側。判定には使わない (設計 §4.1) */
    minCoverageRatio?: number;
    /** G8: 範囲外の注釈がこの割合を超えたら不合格。既定 0.01 */
    maxOutOfRangeAnnotationRatio?: number;
    /** G8 の上側。既定 1.05。時刻が音声長を超える暴走を捕まえる */
    maxCoverageRatio?: number;
    minSpeakers?: number;
    /**
     * 話者分離が有効か。G7 はこれが true のときだけ判定する。
     * 既定は「注釈のどれかに speaker が付いているか」からの推定。
     * 🔴 話者分離を単独指定すると注釈が 0 本になる (設計 §1.8) ため、推定では「有効なのに 0 本」を検出できない。
     * 呼び出し側が設定を知っているなら明示的に渡すこと。
     */
    diarizationEnabled?: boolean;
    /**
     * 単語タイムスタンプが有効か。G8 はこれが true のときだけ判定する。
     * 既定は「注釈が 1 本以上あるか」からの推定。明示的に true を渡すと注釈 0 本もカバレッジ不足として落ちる。
     */
    timestampsEnabled?: boolean;
}

/**
 * 所見の重さ。
 * - `fail`: チャンクを不合格にする。再試行 (設計 §4.3) の対象。
 * - `warn`: 記録するがチャンクは不合格にしない。真陽性が未確認で偽陽性の疑いがある検査 (現状 G6 だけ)。
 * - `indeterminate`: 🔴 **検査を走らせられなかった**。合格ではない。
 *   「成功時に無言の検査層は、動いたのか走らなかったのかが区別できない」を避けるため、
 *   走らなかったことが必ず結果に現れるようにする。
 */
export type QualitySeverity = 'fail' | 'warn' | 'indeterminate';

export interface QualityGateFinding {
    gate: QualityGateId;
    severity: QualitySeverity;
    /** 人が読む理由 (ログ・失敗表示用) */
    reason: string;
    /** 判定に使った実測値。測れなかったなら null */
    observed: number | string | null;
    /** 比較に使った閾値 */
    threshold: number | string;
}

/** 判定に使った実測値。ゲートの合否と別に、そのままログへ出して分布を取り直すのに使う */
export interface TranscriptQualityMetrics {
    charCount: number;
    unitCount: number;
    uniqueUnitCount: number;
    /** ユニーク数 ÷ ユニット数。ユニットが 0 なら null */
    uniqueUnitRatio: number | null;
    maxConsecutiveUnits: number;
    /** `len(utf8) / len(zlib.deflate(utf8))`。本文が空なら null */
    compressionRatio: number | null;
    /** 文字数 ÷ 発話秒数。発話秒数が 0 以下なら null */
    charsPerSpeechSec: number | null;
    /** 最終注釈時刻 ÷ 音声長。注釈 0 本 または 音声長 0 以下なら null。@deprecated 判定には使わない */
    coverageRatio: number | null;
    /**
     * G6: 発話区間のうち、注釈が 1 本も無い最長の連続秒数。
     * `speechIntervals` が渡されなければ null (＝検査が走っていない。合格ではない)。
     */
    longestSilentGapSec: number | null;
    /** G8: 音声長 × maxCoverageRatio を超える end_offset を持つ注釈の本数 */
    outOfRangeAnnotationCount: number;
    /** G8: 上の本数 ÷ 全注釈数。注釈 0 本なら null */
    outOfRangeAnnotationRatio: number | null;
    /** 注釈の end_offset の最大値。注釈 0 本なら null */
    lastAnnotationEndSec: number | null;
    /** 注釈に出てきた話者ラベルの種類数 */
    speakerCount: number;
    /** 出力トークン ÷ 上限。出力トークンが取れなければ null */
    outputTokenRatio: number | null;
}

export interface TranscriptQualityReport {
    /** `fail` が 1 つも無ければ true。`warn` と `indeterminate` は合否に影響しない */
    passed: boolean;
    /** 不合格になったゲートの ID (G1→G8 の順) */
    failedGates: QualityGateId[];
    /** 警告だけのゲート (チャンクは不合格にしない) */
    warnedGates: QualityGateId[];
    /** 🔴 走らせられなかった検査。合格とは別物なので、ログでも合格に丸めないこと */
    indeterminateGates: QualityGateId[];
    /** 全所見 (fail / warn / indeterminate) を G1→G8 の順で */
    findings: QualityGateFinding[];
    /** findings のうち fail のものだけ */
    failures: QualityGateFinding[];
    /** findings のうち warn のものだけ */
    warnings: QualityGateFinding[];
    metrics: TranscriptQualityMetrics;
}

/**
 * ユニットの区切り。🔴 句点だけで割ってはいけない。
 * 実測で「ここ、」× 6,488 の反復崩壊 (15 分・圧縮率 112.79) が起きたが、これは読点区切りだったため
 * `。` だけで割ると全体が 1 ユニットになり、最長連続 = 1 として G3 が見逃した (捕まえたのは G5 だけ)。
 * 句読点の無い出力が「1 ユニット」になって全検査をすり抜ける問題も同じ形。読点と改行を必ず含めること。
 */
const UNIT_SEPARATOR = /[。．.、，,\r\n]+/;

/**
 * 比較前に落とす文字。同じ幻覚でも句点の有無がバラつくため、句読点・記号・空白を除去してから完全一致で比べる
 * (国内の実装事例より)。🔴 判定は完全一致のみ — 部分一致にすると、長い正常な文が短い定型句を含むだけで落ちる。
 */
const PUNCTUATION_TO_STRIP = /[。．.、，,！？!?「」『』（）()［］\[\]〜~・:：;；…\s]/g;

/** 本文をユニットへ割り、比較用に正規化する。空になったユニットは落とす */
export const splitIntoUnits = (text: string): string[] =>
    text
        .split(UNIT_SEPARATOR)
        .map((unit) => unit.replace(PUNCTUATION_TO_STRIP, ''))
        .filter((unit) => unit.length > 0);

/** 同一ユニットが連続した最大回数。ユニットが 0 本なら 0 */
export const maxConsecutiveRun = (units: string[]): number => {
    let best = 0;
    let run = 0;
    let previous: string | null = null;
    for (const unit of units) {
        run = unit === previous ? run + 1 : 1;
        previous = unit;
        if (run > best) best = run;
    }
    return best;
};

/** UTF-8 バイト数 ÷ zlib 圧縮後バイト数。Python の `zlib.compress` と同じ zlib 形式・同じ既定レベル */
export const compressionRatio = (text: string): number | null => {
    const raw = Buffer.from(text, 'utf8');
    if (raw.length === 0) return null;
    return raw.length / deflateSync(raw).length;
};

export const utf8ByteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * 発話区間のうち、注釈が 1 本も覆っていない最長の連続秒数。
 *
 * 🔴 これが G6 の本体。**発話秒の総量を分母に使わない**のが要点で、
 * VAD がノイズを発話と誤認しても、その区間に注釈が散っていれば穴として数えない。
 * 注釈は重なり得るので、先に併合してから走査する。
 */
export const longestUncoveredSpeechSec = (
    speechIntervals: readonly (readonly [number, number])[],
    annotations: readonly TranscriptAnnotation[],
): number => {
    const merged: [number, number][] = [];
    for (const [start, end] of annotations
        .map((a): [number, number] => [a.startOffsetSec, Math.max(a.startOffsetSec, a.endOffsetSec)])
        .sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }

    let worst = 0;
    for (const [speechStart, speechEnd] of speechIntervals) {
        let cursor = speechStart;
        for (const [annStart, annEnd] of merged) {
            if (annEnd <= cursor || annStart >= speechEnd) continue;
            if (annStart > cursor) worst = Math.max(worst, annStart - cursor);
            cursor = Math.max(cursor, annEnd);
            if (cursor >= speechEnd) break;
        }
        if (cursor < speechEnd) worst = Math.max(worst, speechEnd - cursor);
    }
    return worst;
};

/**
 * 範囲外の時刻を持つ注釈を落とす (G8 の「隔離」の実体)。
 *
 * 🔴 **本文には触らない。** 時刻の暴走はメタデータの欠陥であって、本文を捨てる理由にならない
 * (実測: 取りこぼしゼロ・最長穴 5 秒・11,486 文字の走が、壊れた注釈 1 本で不合格になっていた)。
 * 落とした本数は呼び出し側でログに残すこと — 時刻リンクが減った理由が後から追えなくなる。
 */
export const quarantineOutOfRangeAnnotations = (
    annotations: readonly TranscriptAnnotation[],
    audioSec: number,
    maxCoverageRatio: number = MAX_COVERAGE_RATIO,
): { kept: TranscriptAnnotation[]; removed: TranscriptAnnotation[] } => {
    if (!(audioSec > 0)) return { kept: [...annotations], removed: [] };
    const ceiling = audioSec * maxCoverageRatio;
    const kept: TranscriptAnnotation[] = [];
    const removed: TranscriptAnnotation[] = [];
    for (const annotation of annotations) {
        (annotation.endOffsetSec > ceiling ? removed : kept).push(annotation);
    }
    return { kept, removed };
};

/** 判定用の実測値だけを出す (ゲートを通さずに分布を取りたいとき用) */
export const measureChunk = (
    chunk: ChunkResult,
    options: QualityGateOptions = {},
): TranscriptQualityMetrics => {
    const outputTokenLimit = options.outputTokenLimit ?? chunk.outputTokenLimit ?? DEFAULT_OUTPUT_TOKEN_LIMIT;
    const units = splitIntoUnits(chunk.text);
    const uniqueUnitCount = new Set(units).size;
    const endOffsets = chunk.annotations.map((annotation) => annotation.endOffsetSec);
    const lastAnnotationEndSec = endOffsets.length > 0 ? Math.max(...endOffsets) : null;
    const outOfRangeCeiling = chunk.audioSec * (options.maxCoverageRatio ?? MAX_COVERAGE_RATIO);
    const outOfRange =
        chunk.audioSec > 0 ? endOffsets.filter((end) => end > outOfRangeCeiling).length : 0;
    const speakers = new Set(
        chunk.annotations
            .map((annotation) => annotation.speaker)
            .filter((speaker): speaker is string => speaker !== null && speaker !== ''),
    );

    return {
        charCount: chunk.text.length,
        unitCount: units.length,
        uniqueUnitCount,
        uniqueUnitRatio: units.length > 0 ? uniqueUnitCount / units.length : null,
        maxConsecutiveUnits: maxConsecutiveRun(units),
        compressionRatio: compressionRatio(chunk.text),
        charsPerSpeechSec: chunk.speechSec > 0 ? chunk.text.length / chunk.speechSec : null,
        coverageRatio:
            lastAnnotationEndSec !== null && chunk.audioSec > 0 ? lastAnnotationEndSec / chunk.audioSec : null,
        longestSilentGapSec: chunk.speechIntervals
            ? longestUncoveredSpeechSec(chunk.speechIntervals, chunk.annotations)
            : null,
        outOfRangeAnnotationCount: outOfRange,
        outOfRangeAnnotationRatio: chunk.annotations.length > 0 ? outOfRange / chunk.annotations.length : null,
        lastAnnotationEndSec,
        speakerCount: speakers.size,
        outputTokenRatio:
            chunk.outputTokens !== undefined && outputTokenLimit > 0
                ? chunk.outputTokens / outputTokenLimit
                : null,
    };
};

/**
 * チャンク 1 本を G1〜G8 で検査する。落ちたゲートと実測値を返す (最初の失敗で打ち切らない —
 * 再試行の判断に「どの壊れ方か」が要るため、全ゲートの結果を揃えて返す)。
 */
export const evaluateChunkQuality = (
    chunk: ChunkResult,
    options: QualityGateOptions = {},
): TranscriptQualityReport => {
    const outputTokenLimit = options.outputTokenLimit ?? chunk.outputTokenLimit ?? DEFAULT_OUTPUT_TOKEN_LIMIT;
    const outputTokenLimitRatio = options.outputTokenLimitRatio ?? OUTPUT_TOKEN_LIMIT_RATIO;
    const maxConsecutive = options.maxConsecutiveUnits ?? MAX_CONSECUTIVE_UNITS;
    const maxCoverage = options.maxCoverageRatio ?? MAX_COVERAGE_RATIO;
    const minUniqueRatio = options.minUniqueUnitRatio ?? MIN_UNIQUE_UNIT_RATIO;
    const minUnitsForUnique = options.minUnitsForUniqueRatio ?? MIN_UNITS_FOR_UNIQUE_RATIO;
    const maxRatio = options.maxCompressionRatio ?? MAX_COMPRESSION_RATIO;
    const maxSilentGap = options.maxSilentGapSec ?? MAX_SILENT_GAP_SEC;
    const maxOutOfRangeRatio = options.maxOutOfRangeAnnotationRatio ?? MAX_OUT_OF_RANGE_ANNOTATION_RATIO;
    const minSpeakers = options.minSpeakers ?? MIN_SPEAKERS;
    const diarizationEnabled =
        options.diarizationEnabled ?? chunk.annotations.some((annotation) => annotation.speaker !== null);
    const timestampsEnabled = options.timestampsEnabled ?? chunk.annotations.length > 0;

    const metrics = measureChunk(chunk, { ...options, outputTokenLimit });
    const findings: QualityGateFinding[] = [];
    const add = (finding: QualityGateFinding) => findings.push(finding);

    // G1: 出力上限到達。status は最優先で見るが、これだけでは足りない (崩壊の 3 種類が completed を返す)
    const tokenCeiling = outputTokenLimit * outputTokenLimitRatio;
    if (chunk.status !== 'completed') {
        add({
            gate: 'G1',
            severity: 'fail',
            reason: `status が completed ではない (${chunk.status}) — 出力上限で打ち切られた可能性`,
            observed: chunk.status,
            threshold: 'completed',
        });
    }
    // 🔴 トークン側は status と独立に見る。取れなかったら「判定不能」であって「合格」ではない —
    // total_output_tokens は上限到達の崩壊走でも 0 を返すので、0 / undefined を黙って合格に丸めると検査が静かに死ぬ。
    if (chunk.outputTokens === undefined || chunk.outputTokens === 0) {
        add({
            gate: 'G1',
            severity: 'indeterminate',
            reason:
                '出力トークン数を取得できなかった (undefined または 0) — 上限到達の検査を走らせていない。' +
                'usage.model_invocation_token_counts[].candidates_tokens_details[] の modality === "text" の合計を渡すこと',
            observed: chunk.outputTokens ?? null,
            threshold: tokenCeiling,
        });
    } else if (chunk.outputTokens >= tokenCeiling) {
        add({
            gate: 'G1',
            severity: 'fail',
            reason: `出力トークンが上限 ${outputTokenLimit} の ${outputTokenLimitRatio} に到達 — 反復確定`,
            observed: chunk.outputTokens,
            threshold: tokenCeiling,
        });
    }

    // G2: 空。20 分チャンクで 0 文字・status completed・エラーなしの実例がある
    if (chunk.text.length === 0) {
        add({ gate: 'G2', severity: 'fail', reason: '本文が 0 文字', observed: 0, threshold: '> 0' });
    }

    // G3: 最長連続ユニット (主検査)。実発話と交互に出る反復は捕まえられないので G4 と対で使う
    if (metrics.maxConsecutiveUnits >= maxConsecutive) {
        add({
            gate: 'G3',
            severity: 'fail',
            reason: `同一ユニットが ${metrics.maxConsecutiveUnits} 回連続 — 反復崩壊`,
            observed: metrics.maxConsecutiveUnits,
            threshold: maxConsecutive,
        });
    }

    // G4: ユニーク率。連続していない反復 (実発話と交互に出る型) はここでしか捕まらない
    if (metrics.unitCount >= minUnitsForUnique && metrics.uniqueUnitRatio !== null && metrics.uniqueUnitRatio < minUniqueRatio) {
        add({
            gate: 'G4',
            severity: 'fail',
            reason: `ユニーク率 ${metrics.uniqueUnitRatio.toFixed(3)} (${metrics.uniqueUnitCount}/${metrics.unitCount}) — 反復崩壊`,
            observed: metrics.uniqueUnitRatio,
            threshold: minUniqueRatio,
        });
    }

    // G5: 圧縮率 (副検査)。読点区切りの反復のように G3 が見逃した実例を実際に捕まえた
    if (metrics.compressionRatio !== null && metrics.compressionRatio > maxRatio) {
        add({
            gate: 'G5',
            severity: 'fail',
            reason: `圧縮率 ${metrics.compressionRatio.toFixed(2)} — 反復崩壊`,
            observed: metrics.compressionRatio,
            threshold: maxRatio,
        });
    }

    // G6: 最長穴 (本文の脱落)。🔴 発話区間が要る — `speechSec` の総量では代替できない (定数のコメント参照)
    if (metrics.longestSilentGapSec === null) {
        add({
            gate: 'G6',
            severity: 'indeterminate',
            reason:
                '発話区間 (speechIntervals) が渡されていない — 本文の脱落を検査していない。' +
                'VAD の区間をチャンク先頭を 0 とした [開始秒, 終了秒] の並びで渡すこと',
            observed: null,
            threshold: maxSilentGap,
        });
    } else if (metrics.longestSilentGapSec > maxSilentGap) {
        add({
            gate: 'G6',
            severity: 'fail',
            reason: `注釈が 1 本も無い発話が ${metrics.longestSilentGapSec.toFixed(1)} 秒続く — 本文が脱落している`,
            observed: metrics.longestSilentGapSec,
            threshold: maxSilentGap,
        });
    }

    // G7: 話者の妥当性。🔴 warn 止まり — 本文は読めるので、チャンクごと捨てない（定数のコメント参照）
    if (diarizationEnabled && metrics.speakerCount < minSpeakers) {
        add({
            gate: 'G7',
            severity: 'warn',
            reason: `話者分離が有効なのに話者が ${metrics.speakerCount} 種類 — `
                + '話者ラベルが付かないだけで本文は読める（警告のみ・不合格にはしない）',
            observed: metrics.speakerCount,
            threshold: minSpeakers,
        });
    }

    // G8: 時刻の暴走。🔴 走ごと落とすのではなく、範囲外の注釈だけ隔離する (定数のコメント参照)。
    //     脱落の検査は G6 が担う — ここで端点カバレッジを見ると両方向に誤る (設計 §4.1)。
    if (timestampsEnabled) {
        if (chunk.annotations.length === 0) {
            add({
                gate: 'G8',
                severity: 'fail',
                reason: '単語タイムスタンプが有効なのに注釈が 0 本 — 話者ラベルも時刻シークも成立しない',
                observed: 0,
                threshold: '> 0',
            });
        } else if (chunk.audioSec <= 0) {
            add({
                gate: 'G8',
                severity: 'indeterminate',
                reason: `音声長が ${chunk.audioSec} — 時刻の範囲を判定できない`,
                observed: null,
                threshold: maxCoverage,
            });
        } else if (metrics.outOfRangeAnnotationRatio !== null && metrics.outOfRangeAnnotationRatio > maxOutOfRangeRatio) {
            add({
                gate: 'G8',
                severity: 'fail',
                reason:
                    `注釈 ${metrics.outOfRangeAnnotationCount}/${chunk.annotations.length} 本の時刻が音声長 ` +
                    `${chunk.audioSec}s × ${maxCoverage} を超えている — 時刻の並びごと信用できない`,
                observed: metrics.outOfRangeAnnotationRatio,
                threshold: maxOutOfRangeRatio,
            });
        } else if (metrics.outOfRangeAnnotationCount > 0) {
            // 🔴 数本だけなら本文は使える。隔離したことを必ず記録に残す —
            //    黙って捨てると、時刻リンクが減った理由が後から追えない。
            add({
                gate: 'G8',
                severity: 'warn',
                reason:
                    `注釈 ${metrics.outOfRangeAnnotationCount}/${chunk.annotations.length} 本の時刻が範囲外 — ` +
                    'その注釈だけ隔離する (本文と残りの時刻は使う)',
                observed: metrics.outOfRangeAnnotationCount,
                threshold: maxOutOfRangeRatio,
            });
        }
    }

    const bySeverity = (severity: QualitySeverity) => findings.filter((finding) => finding.severity === severity);
    const failures = bySeverity('fail');
    const warnings = bySeverity('warn');

    return {
        passed: failures.length === 0,
        failedGates: failures.map((finding) => finding.gate),
        warnedGates: warnings.map((finding) => finding.gate),
        indeterminateGates: bySeverity('indeterminate').map((finding) => finding.gate),
        findings,
        failures,
        warnings,
        metrics,
    };
};

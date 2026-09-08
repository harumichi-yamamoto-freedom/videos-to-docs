/**
 * サイズ超過で失敗したジョブを「変換し直して再試行」するときの、下げ先ビットレートの決定。
 *
 * 🔴 実害 (2026-09-04): 圧縮済みで上限内の音声は変換を通らず**そのまま**送られる
 *    (`mediaInput.canSendAudioAsIs`)。このとき利用者がビットレートを下げても一切効かない
 *    (同じサイズが上がり続ける)。よって「変換を通っていなかった」場合に打つ手は
 *    まず「**変換を通すこと自体**」になる (convert_as_is_input)。
 *    🔴 ただし現在のビットレートのままとは限らない。元が圧縮済みなら同じ値で再エンコード
 *    しても縮まないので、長さから出力サイズを見積もって収まる値まで下げる。
 *
 * ここは純関数だけを置く (状態も DOM も持たない)。候補と順序は `AUDIO_BITRATE_OPTIONS` が正。
 */
import { AUDIO_BITRATE_OPTIONS } from '@/components/ConversionSettings';
import { AZURE_BATCH_MAX_AUDIO_SEC } from '@/lib/azureBatchContract';
import { parseBitrateKbps } from '@/lib/inlineMediaBudget';
import type { FileProcessingStatus } from '@/types/processing';

export type RetryConversionPlan =
    /** 下げて変換し直す */
    | { kind: 'lower_bitrate'; bitrate: string }
    /** 変換を通っていなかった＝変換を通せば縮む。bitrate は予算に収まるところまで下げた値 */
    | { kind: 'convert_as_is_input'; bitrate: string }
    | { kind: 'unavailable'; reason: 'already_lowest' };

/**
 * 推定サイズに持たせる余裕 (5%)。CBR の見積りは実測と数 % ずれるため、
 * 上限ちょうどを狙う候補を選ぶと再試行がまた同じ壁に当たる。
 */
export const RETRY_SIZE_MARGIN = 1.05;

export interface RetryConversionInput {
    /** 直前に使っていたビットレート ('96k' 形式) */
    currentBitrate: string;
    /** 失敗したデータの実バイト数 */
    actualBytes: number;
    /** 送れるバイト数の上限 */
    limitBytes: number;
    /** そのデータが変換由来か。false = 元ファイルがそのまま送られていた */
    wasConverted: boolean;
    /**
     * 実測の音声長（秒）。分かっているときだけ渡す。
     * 変換を通っていない入力は**元のビットレートが分からない**ので実バイト数からは縮み方を出せず、
     * 長さから出力サイズを見積もる。無ければ本サービスが扱う最長 (4時間) を上界に使う。
     */
    knownDurationSec?: number;
}

/** CBR の出力サイズ見積り。kbps × 秒 ÷ 8 */
const estimateConvertedBytes = (kbps: number, seconds: number): number =>
    (kbps * 1000 / 8) * seconds;

/**
 * 候補の切れ目 = 「現在より低い」ビットレートの個数。
 * `AUDIO_BITRATE_OPTIONS` は昇順なので、先頭からこの個数が候補になる。
 * 一覧に無いビットレート (旧設定など) は kbps で比較し、読めなければ全候補を許す。
 */
const countLowerOptions = (currentBitrate: string): number => {
    const exactIndex = AUDIO_BITRATE_OPTIONS.findIndex(option => option.value === currentBitrate);
    if (exactIndex >= 0) return exactIndex;

    const currentKbps = parseBitrateKbps(currentBitrate);
    if (currentKbps === null) return AUDIO_BITRATE_OPTIONS.length;
    return AUDIO_BITRATE_OPTIONS.filter(option => {
        const kbps = parseBitrateKbps(option.value);
        return kbps !== null && kbps < currentKbps;
    }).length;
};

/** 現在値も候補に含めた一覧。「変換すること自体」が効く場合はここから選ぶ */
const candidatesIncludingCurrent = (currentBitrate: string) => {
    const exactIndex = AUDIO_BITRATE_OPTIONS.findIndex(option => option.value === currentBitrate);
    return AUDIO_BITRATE_OPTIONS.slice(
        0,
        exactIndex >= 0 ? exactIndex + 1 : countLowerOptions(currentBitrate)
    );
};

/**
 * 再試行で使うビットレートを決める。
 * - 変換を通っていなければ、**長さから出力サイズを見積もって**予算に収まる最も高い候補。
 *   🔴 現在値のまま返してはいけない: 圧縮済みの入力を同じビットレートで再エンコードしても
 *      ほぼ同じサイズになり、数百MBの再変換と再アップロードの末にまた落ちる。
 * - 変換由来なら、推定サイズ `actualBytes * (候補kbps / 現kbps)` が予算に収まる**最も高い**候補。
 *   どれも収まらなければ最下位候補。現在が最下位なら手がない (`unavailable`)。
 */
export const planRetryConversion = ({
    currentBitrate,
    actualBytes,
    limitBytes,
    wasConverted,
    knownDurationSec,
}: RetryConversionInput): RetryConversionPlan => {
    const budget = limitBytes / RETRY_SIZE_MARGIN;

    if (!wasConverted) {
        // 実測の長さが分かればそれを使う。分からなければ上界 (4時間) で見積もる＝
        // 実際の録音が短ければ余裕が出る側に外れる（安全側）
        const seconds = knownDurationSec !== undefined && knownDurationSec > 0
            ? knownDurationSec
            : AZURE_BATCH_MAX_AUDIO_SEC;
        const options = candidatesIncludingCurrent(currentBitrate);
        if (options.length === 0) {
            return { kind: 'convert_as_is_input', bitrate: currentBitrate };
        }

        for (let index = options.length - 1; index >= 0; index -= 1) {
            const kbps = parseBitrateKbps(options[index].value);
            if (kbps === null) continue;
            if (estimateConvertedBytes(kbps, seconds) <= budget) {
                return { kind: 'convert_as_is_input', bitrate: options[index].value };
            }
        }
        return { kind: 'convert_as_is_input', bitrate: options[0].value };
    }

    const candidates = AUDIO_BITRATE_OPTIONS.slice(0, countLowerOptions(currentBitrate));
    if (candidates.length === 0) {
        return { kind: 'unavailable', reason: 'already_lowest' };
    }

    const currentKbps = parseBitrateKbps(currentBitrate);

    if (currentKbps !== null && actualBytes > 0) {
        // 高いほう (音質を落とし過ぎない側) から見て、最初に予算へ収まる候補を採る
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
            const kbps = parseBitrateKbps(candidates[index].value);
            if (kbps === null) continue;
            if (actualBytes * (kbps / currentKbps) <= budget) {
                return { kind: 'lower_bitrate', bitrate: candidates[index].value };
            }
        }
    }

    // どれも収まらない (または推定できない) ときは最下位まで下げる
    return { kind: 'lower_bitrate', bitrate: candidates[0].value };
};

/**
 * 失敗した処理欄から再試行の計画を出す。画面 (ボタン文言) と実行 (再開の呼び出し) が
 * **同じ関数・同じ入力**を通るので、表示と実際に使うビットレートがずれない。
 * サイズ由来でない失敗、実測値が残っていない失敗では null。
 *
 * 🔴 予算は**その失敗が実際に破った上限** (`sizeFailure.limitBytes`) で測る。経路ごとに
 *    上限が違う (アップロード 500MB / 同期の文書生成 200MB) ので、一律 500MB で見積もると
 *    200MB で落ちた失敗に 200MB 超の下げ先を選び、再試行がもう一度落ちる。
 *    `limitBytesOverride` はテスト用の逃げ道で、通常の呼び出し側は渡さない。
 */
export const retryPlanFromStatus = (
    status: FileProcessingStatus,
    limitBytesOverride?: number,
): RetryConversionPlan | null => {
    if (status.failureKind !== 'too_large' || !status.sizeFailure) return null;

    return planRetryConversion({
        currentBitrate: status.sizeFailure.bitrate,
        actualBytes: status.sizeFailure.bytes,
        limitBytes: limitBytesOverride ?? status.sizeFailure.limitBytes,
        wasConverted: status.sizeFailure.wasConverted,
        // 失敗時に実測できていればそれが正。次点で動画解析の長さ。どちらも無ければ上界で見積もる
        ...((status.sizeFailure.durationSec ?? status.totalDuration) !== undefined && {
            knownDurationSec: status.sizeFailure.durationSec ?? status.totalDuration,
        }),
    });
};

/** 画面表示用のビットレート名 ('64k' → '64 kbps')。一覧に無い値はそのまま出す */
export const formatBitrateLabel = (bitrate: string): string =>
    AUDIO_BITRATE_OPTIONS.find(option => option.value === bitrate)?.label ?? bitrate;

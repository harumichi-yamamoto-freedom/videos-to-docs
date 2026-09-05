'use client';

import React from 'react';
import { estimateMaxRecordingMinutes, formatDurationJa } from '@/lib/inlineMediaBudget';
import { AZURE_BATCH_MAX_AUDIO_SEC } from '@/lib/azureBatchContract';
import { GENERATE_SYNC_MAX_MEDIA_BYTES } from '@/lib/generateApiContract';

/**
 * S2-1: 既定は 128k だった。192k だと約 10 分で inline 予算に達し、長い商談録音が全滅していた。
 *
 * 本サービスの主用途は 2〜3 時間の営業商談。音声認識の用途では 96k で十分なので既定は 96k。
 *
 * 🔴 「扱える録音の長さ」は**どの用途でも安全な長さ**を出す。用途ごとに上限が違うため:
 *    - 全文文字起こし: 4 時間 (AZURE_BATCH_MAX_AUDIO_SEC)。サイズは 1GB まで許される。
 *    - 議事録などの文書生成: 200MB (GENERATE_SYNC_MAX_MEDIA_BYTES)。サーバが本文をメモリに載せるため。
 *    高いビットレートでは**サイズ側が先に効く**（128k で約3時間38分、192k で約2時間25分）。
 *    アップロード上限 (500MB) で計算すると全候補が「約4時間」と出てしまい、
 *    画面が約束した範囲内の録音が文書生成で 413 になる（3時間・192k = 259MB）。
 */
export const DEFAULT_AUDIO_BITRATE = '96k';

/** 画面に出す「扱える録音の長さ」の頭打ち = 全文文字起こしの時間上限（分）。 */
const RECORDING_CAP_MIN = Math.floor(AZURE_BATCH_MAX_AUDIO_SEC / 60);

/**
 * そのビットレートで**すべての用途が成立する**最長の録音（分）。
 * 文書生成のサイズ上限から出した長さと、文字起こしの時間上限の小さいほう。
 */
export const safeRecordingMinutes = (bitrate: string): number | null => {
    const fromSize = estimateMaxRecordingMinutes(bitrate, GENERATE_SYNC_MAX_MEDIA_BYTES);
    return fromSize === null ? null : Math.min(fromSize, RECORDING_CAP_MIN);
};

export const AUDIO_BITRATE_OPTIONS = [
    { value: '64k', label: '64 kbps', description: '音質は低め・データ量は最小' },
    { value: '96k', label: '96 kbps', description: '標準（推奨）' },
    { value: '128k', label: '128 kbps', description: '高音質' },
    { value: '192k', label: '192 kbps', description: '最高音質・データ量は最大' },
] as const;

interface ConversionSettingsProps {
    bitrate: string;
    onBitrateChange: (bitrate: string) => void;
    disabled?: boolean;
    /**
     * 選んだファイルが 1 つでも変換を通るか。
     * 🔴 圧縮済みで上限内の音声はそのまま送られる＝**ビットレートは一切効かない**。
     * 効かないのに選べる状態にしておくと、上限に当たったときに
     * 「下げたのに直らない」という誤解を生む（2026-09-04 の実害）。
     */
    appliesToSelection?: boolean;
}

export const ConversionSettings: React.FC<ConversionSettingsProps> = ({
    bitrate,
    onBitrateChange,
    disabled = false,
    appliesToSelection = true,
}) => (
    <fieldset className="rounded-lg border border-gray-200 bg-gray-50 p-4" disabled={disabled}>
        <legend className="px-1 text-sm font-medium text-gray-900">音声のビットレート</legend>
        {!appliesToSelection && (
            <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-[13px] text-amber-900">
                選択中の音声ファイルはそのまま送られるため、この設定は使われません。
            </p>
        )}
        <p className="mt-1 text-[13px] text-gray-700">
            全文文字起こしはどのビットレートでも最長 4 時間まで対応します。議事録などの文書生成は送れるデータ量に上限があるため、ビットレートが高いほど扱える録音が短くなります（各項目に出る長さが、両方に使える上限です）。96 kbps なら 4 時間まで両方に使えるので、通常はこれで十分です。これを超える録音は分割してください。
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {AUDIO_BITRATE_OPTIONS.map(option => {
                // 🔴 文書生成のサイズ上限(200MB)由来の長さと、文字起こしの時間上限(4時間)の小さいほう。
                //    アップロード上限(500MB)で計算すると、文書生成で落ちる長さを「対応」と約束してしまう。
                const minutes = safeRecordingMinutes(option.value);
                return (
                    <label
                        key={option.value}
                        className="flex min-h-11 cursor-pointer items-center rounded-lg border border-gray-200 bg-white p-3 transition-colors hover:bg-gray-100 has-[:checked]:border-blue-500 has-[:checked]:bg-blue-50"
                    >
                        <input
                            type="radio"
                            name="audio-bitrate"
                            value={option.value}
                            checked={bitrate === option.value}
                            onChange={event => onBitrateChange(event.target.value)}
                            className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="ml-3 min-w-0">
                            <span className="block text-sm font-medium text-gray-900">
                                {option.label}
                                <span className="ml-2 font-normal text-gray-600">{option.description}</span>
                            </span>
                            {minutes !== null && (
                                <span className="block text-xs text-gray-600">
                                    {formatDurationJa(minutes)}までの録音に対応
                                </span>
                            )}
                        </span>
                    </label>
                );
            })}
        </div>
    </fieldset>
);

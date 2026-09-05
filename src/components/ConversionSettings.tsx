'use client';

import React from 'react';
import { estimateMaxRecordingMinutes, formatDurationJa } from '@/lib/inlineMediaBudget';
import { AZURE_BATCH_MAX_AUDIO_SEC } from '@/lib/azureBatchContract';

/**
 * S2-1: 既定は 128k だった。192k だと約 10 分で inline 予算に達し、長い商談録音が全滅していた。
 *
 * 本サービスの主用途は 2〜3 時間の営業商談。音声認識の用途では 96k で十分なので既定は 96k。
 *
 * 🔴 アップロード上限を 500MB に上げてからは、通常のビットレートではサイズより先に
 *    全文文字起こしの時間上限 (4 時間) にぶつかる。よって「扱える録音の長さ」の表示は
 *    サイズ由来値と 4 時間の min を取る（下記 RECORDING_CAP_MIN）。ビットレートは実質「音質と
 *    アップロードのデータ量」の選択になり、対応時間はどれでも 4 時間まで同じ。
 */
export const DEFAULT_AUDIO_BITRATE = '96k';

/** 画面に出す「扱える録音の長さ」の頭打ち = 全文文字起こしの時間上限（分）。 */
const RECORDING_CAP_MIN = Math.floor(AZURE_BATCH_MAX_AUDIO_SEC / 60);

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
            どのビットレートでも最長 4 時間（全文文字起こしの上限）まで対応します。ビットレートは音質の選択で、高いほどアップロードのデータ量が増えます。音声認識の用途では 96 kbps で十分です。4 時間を超える録音は分割してください。
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {AUDIO_BITRATE_OPTIONS.map(option => {
                const sizeMax = estimateMaxRecordingMinutes(option.value);
                // 🔴 サイズ由来の最長と、全文文字起こしの時間上限(4時間)の小さいほう。
                //    500MB では通常ビットレートは 4 時間側で頭打ちになる（サイズより時間が先に効く）。
                const minutes = sizeMax === null ? null : Math.min(sizeMax, RECORDING_CAP_MIN);
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

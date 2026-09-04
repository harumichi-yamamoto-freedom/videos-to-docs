'use client';

import React from 'react';
import { estimateMaxRecordingMinutes, formatDurationJa } from '@/lib/inlineMediaBudget';

/**
 * S2-1: 既定は 128k だった。192k だと約 10 分で inline 予算に達し、長い商談録音が全滅していた。
 *
 * 本サービスの主用途は 2〜3 時間の営業商談。128k では Storage 上限 (100MB) に約 1 時間 49 分でぶつかり、
 * 2 時間の商談が扱えない。音声認識の用途では 96k で十分なので、既定を 96k (約 2 時間 25 分) に下げる。
 */
export const DEFAULT_AUDIO_BITRATE = '96k';

export const AUDIO_BITRATE_OPTIONS = [
    { value: '64k', label: '64 kbps', description: '長い録音向け（音質は低め）' },
    { value: '96k', label: '96 kbps', description: '標準（推奨）' },
    { value: '128k', label: '128 kbps', description: '高音質' },
    { value: '192k', label: '192 kbps', description: '最高音質（短い録音向け）' },
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
            低いほど長い録音を扱えます。2 時間程度の商談は 96 kbps、3 時間を超える録音は 64 kbps を選んでください。表示の長さを超えるファイルは変換できないため、ビットレートを下げるか、ファイルを分割してください。
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {AUDIO_BITRATE_OPTIONS.map(option => {
                const minutes = estimateMaxRecordingMinutes(option.value);
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

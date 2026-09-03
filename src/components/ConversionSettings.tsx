'use client';

import React from 'react';
import { estimateInlineLimitMinutes } from '@/lib/inlineMediaBudget';

/**
 * S2-1: 既定は 128k。192k だと約 10 分でそのまま送れる上限に達し、長い商談録音が全滅していた。
 * 音声認識の用途では 128k で十分で、そのまま送れる長さが 1.5 倍に伸びる。
 */
export const DEFAULT_AUDIO_BITRATE = '128k';

export const AUDIO_BITRATE_OPTIONS = [
    { value: '64k', label: '64 kbps', description: '長い録音向け（音質は低め）' },
    { value: '96k', label: '96 kbps', description: '長めの録音向け' },
    { value: '128k', label: '128 kbps', description: '標準（推奨）' },
    { value: '192k', label: '192 kbps', description: '高音質（短い録音向け）' },
] as const;

interface ConversionSettingsProps {
    bitrate: string;
    onBitrateChange: (bitrate: string) => void;
    disabled?: boolean;
}

export const ConversionSettings: React.FC<ConversionSettingsProps> = ({
    bitrate,
    onBitrateChange,
    disabled = false,
}) => (
    <fieldset className="rounded-lg border border-gray-200 bg-gray-50 p-4" disabled={disabled}>
        <legend className="px-1 text-sm font-medium text-gray-900">音声のビットレート</legend>
        <p className="mt-1 text-[13px] text-gray-700">
            低いほど長い録音をそのまま送れます。目安を超える長さは、サーバーが大きなファイル用の送信方式に自動で切り替えます。うまくいかない場合はビットレートを下げるか、ファイルを分割してください。
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {AUDIO_BITRATE_OPTIONS.map(option => {
                const minutes = estimateInlineLimitMinutes(option.value);
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
                                    そのまま送れる目安: 約{minutes}分
                                </span>
                            )}
                        </span>
                    </label>
                );
            })}
        </div>
    </fieldset>
);

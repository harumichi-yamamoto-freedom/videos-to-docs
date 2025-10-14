'use client';

import React from 'react';

interface ConversionSettingsProps {
    bitrate: string;
    sampleRate: number;
    onBitrateChange: (bitrate: string) => void;
    onSampleRateChange: (sampleRate: number) => void;
}

export const ConversionSettings: React.FC<ConversionSettingsProps> = ({
    bitrate,
    sampleRate,
    onBitrateChange,
    onSampleRateChange,
}) => {
    const bitrateOptions = [
        { value: '128k', label: '128 kbps (標準品質)' },
        { value: '192k', label: '192 kbps (高品質)' },
        { value: '256k', label: '256 kbps (最高品質)' },
        { value: '320k', label: '320 kbps (無損品質)' },
    ];

    const sampleRateOptions = [
        { value: 44100, label: '44.1 kHz (CD品質)' },
        { value: 48000, label: '48 kHz (DVD品質)' },
        { value: 96000, label: '96 kHz (高解像度)' },
    ];

    return (
        <div className="bg-gray-50 rounded-lg p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
                変換設定
            </h3>

            <div className="space-y-6">
                {/* ビットレート設定 */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                        ビットレート
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        {bitrateOptions.map((option) => (
                            <label
                                key={option.value}
                                className="flex items-center p-3 border rounded-lg cursor-pointer hover:bg-gray-100 transition-colors"
                            >
                                <input
                                    type="radio"
                                    name="bitrate"
                                    value={option.value}
                                    checked={bitrate === option.value}
                                    onChange={(e) => onBitrateChange(e.target.value)}
                                    className="mr-3"
                                />
                                <div>
                                    <div className="text-sm font-medium text-gray-900">
                                        {option.value}
                                    </div>
                                    <div className="text-xs text-gray-500">
                                        {option.label}
                                    </div>
                                </div>
                            </label>
                        ))}
                    </div>
                </div>

                {/* サンプルレート設定 */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                        サンプルレート
                    </label>
                    <div className="space-y-2">
                        {sampleRateOptions.map((option) => (
                            <label
                                key={option.value}
                                className="flex items-center p-3 border rounded-lg cursor-pointer hover:bg-gray-100 transition-colors"
                            >
                                <input
                                    type="radio"
                                    name="sampleRate"
                                    value={option.value}
                                    checked={sampleRate === option.value}
                                    onChange={(e) => onSampleRateChange(Number(e.target.value))}
                                    className="mr-3"
                                />
                                <div>
                                    <div className="text-sm font-medium text-gray-900">
                                        {option.value.toLocaleString()} Hz
                                    </div>
                                    <div className="text-xs text-gray-500">
                                        {option.label}
                                    </div>
                                </div>
                            </label>
                        ))}
                    </div>
                </div>

                {/* 設定の説明 */}
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-blue-900 mb-2">
                        設定について
                    </h4>
                    <ul className="text-xs text-blue-800 space-y-1">
                        <li>• ビットレートが高いほど音質は向上しますが、ファイルサイズも大きくなります</li>
                        <li>• サンプルレートは音の周波数範囲を決定します</li>
                        <li>• 一般的な用途では192kbps/44.1kHzが推奨されます</li>
                    </ul>
                </div>
            </div>
        </div>
    );
};

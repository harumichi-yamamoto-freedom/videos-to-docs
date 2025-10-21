'use client';

import React from 'react';
import { DebugErrorMode } from '@/types/processing';

interface DebugControlsProps {
    debugErrorMode: DebugErrorMode;
    onDebugModeChange: (mode: DebugErrorMode) => void;
}

export const DebugControls: React.FC<DebugControlsProps> = ({
    debugErrorMode,
    onDebugModeChange,
}) => {
    if (process.env.NODE_ENV !== 'development') {
        return null;
    }

    return (
        <div className="mt-4 bg-gradient-to-br from-red-50 to-orange-50 border border-red-300 rounded-lg p-4">
            <h4 className="text-sm font-medium text-red-900 mb-3">
                🐛 デバッグモード
            </h4>
            <div className="space-y-3">
                <div>
                    <label className="flex items-center space-x-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={debugErrorMode.ffmpegError}
                            onChange={(e) => onDebugModeChange({ ...debugErrorMode, ffmpegError: e.target.checked })}
                            className="w-4 h-4 text-red-600"
                        />
                        <span className="text-xs text-red-800">FFmpegエラーを発生させる</span>
                    </label>
                </div>
                <div>
                    <label className="flex items-center space-x-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={debugErrorMode.geminiError}
                            onChange={(e) => onDebugModeChange({ ...debugErrorMode, geminiError: e.target.checked })}
                            className="w-4 h-4 text-red-600"
                        />
                        <span className="text-xs text-red-800">Geminiエラーを発生させる</span>
                    </label>
                </div>
                <div>
                    <label className="block text-xs text-red-800 mb-1">
                        エラーを起こすファイル（インデックス）:
                    </label>
                    <input
                        type="number"
                        min="0"
                        value={debugErrorMode.errorAtFileIndex}
                        onChange={(e) => onDebugModeChange({ ...debugErrorMode, errorAtFileIndex: parseInt(e.target.value) || 0 })}
                        className="w-full px-2 py-1 text-xs border border-red-300 rounded"
                    />
                </div>
                <div>
                    <label className="block text-xs text-red-800 mb-1">
                        エラーを起こす区間（インデックス）:
                    </label>
                    <input
                        type="number"
                        min="0"
                        value={debugErrorMode.errorAtSegmentIndex}
                        onChange={(e) => onDebugModeChange({ ...debugErrorMode, errorAtSegmentIndex: parseInt(e.target.value) || 0 })}
                        className="w-full px-2 py-1 text-xs border border-red-300 rounded"
                    />
                    <p className="text-xs text-red-600 mt-1">
                        ※ 0から始まります（例: 0=1番目, 1=2番目, 2=3番目）
                    </p>
                </div>
                <p className="text-xs text-red-600 italic">
                    ※ 開発環境でのみ表示されます
                </p>
            </div>
        </div>
    );
};



'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';
import { FileProcessingStatus } from '@/types/processing';

interface ProcessingStatusListProps {
    statuses: FileProcessingStatus[];
    onResumeFile: (index: number) => void;
}

export const ProcessingStatusList: React.FC<ProcessingStatusListProps> = ({
    statuses,
    onResumeFile,
}) => {
    if (statuses.length === 0) {
        return null;
    }

    return (
        <div className="bg-white rounded-xl shadow-lg p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
                処理進捗 ({statuses.filter(s => s.status === 'completed').length} / {statuses.length})
            </h3>
            <div className="space-y-3">
                {statuses.map((status, index) => (
                    <div key={index} className="border rounded-lg p-4 bg-white shadow-sm">
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">
                                    {status.fileName}
                                </p>
                                {status.error && (
                                    <p className="text-xs text-red-600 mt-1">
                                        エラー: {status.error}
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* 進捗表示 */}
                        <div className="space-y-2">
                            {/* 音声変換 */}
                            {status.phase === 'audio_conversion' && (
                                <div>
                                    <p className="text-sm font-medium text-blue-800 mb-1">
                                        音声変換: {status.audioConversionProgress}%
                                        {status.segments.length > 0 && (
                                            <span className="text-xs text-gray-600 ml-2">
                                                ({status.completedSegmentIndices.length}/{status.segments.length} 区間完了)
                                            </span>
                                        )}
                                    </p>
                                    <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                        <div
                                            className="h-full bg-blue-600 transition-all duration-300"
                                            style={{ width: `${status.audioConversionProgress}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            {/* 音声結合 */}
                            {status.phase === 'audio_concat' && (
                                <div className="flex items-center space-x-3">
                                    <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                                    <p className="text-sm font-medium text-blue-800">
                                        音声ファイルを結合中...
                                    </p>
                                </div>
                            )}

                            {/* 文章生成中 */}
                            {status.phase === 'text_generation' && (
                                <div className="flex items-center space-x-3">
                                    <Loader2 className="w-5 h-5 text-purple-600 animate-spin" />
                                    <p className="text-sm font-medium text-purple-800">
                                        文章生成中: {status.transcriptionCount}/{status.totalTranscriptions}
                                    </p>
                                </div>
                            )}

                            {/* 完了 */}
                            {status.phase === 'completed' && (
                                <p className="text-sm font-medium text-green-800">
                                    ✅ 完了
                                </p>
                            )}

                            {/* 待機中 */}
                            {status.phase === 'waiting' && status.isResuming && (
                                <p className="text-sm text-yellow-700">
                                    🕐 音声変換待機中...（他のファイルの音声変換が終わり次第開始されます）
                                </p>
                            )}
                            {status.phase === 'waiting' && !status.isResuming && (
                                <p className="text-sm text-gray-500">待機中...</p>
                            )}

                            {/* エラー */}
                            {status.status === 'error' && !status.isResuming && (
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium text-red-800 mb-1">
                                            ❌ エラーが発生しました
                                            {status.failedPhase === 'audio_conversion' && ' (音声変換)'}
                                            {status.failedPhase === 'text_generation' && ' (文書生成)'}
                                        </p>
                                        {status.completedSegmentIndices.length > 0 && (
                                            <p className="text-xs text-green-600 mb-1">
                                                ✓ 完了した区間: {status.completedSegmentIndices.length}/{status.segments.length} ({status.audioConversionProgress}%)
                                            </p>
                                        )}
                                        {status.completedPromptIds.length > 0 && (
                                            <p className="text-xs text-green-600 mb-1">
                                                ✓ 完了: {status.completedPromptIds.length}/{status.totalTranscriptions} プロンプト
                                            </p>
                                        )}
                                        {status.convertedAudioBlob && (
                                            <p className="text-xs text-blue-600 mb-1">
                                                ✓ 音声変換済み（再開時はスキップされます）
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => onResumeFile(index)}
                                        disabled={status.isResuming}
                                        className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-1"
                                    >
                                        <span>🔄</span>
                                        <span>{status.isResuming ? '再開中...' : '再開'}</span>
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};



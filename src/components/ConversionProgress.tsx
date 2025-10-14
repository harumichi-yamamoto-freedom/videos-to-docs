'use client';

import React from 'react';
import { CheckCircle, XCircle, Loader2, Download } from 'lucide-react';

export interface FileConversionStatus {
    fileName: string;
    status: 'waiting' | 'converting' | 'completed' | 'error';
    progress: number;
    outputBlob?: Blob;
    error?: string;
    message?: string;
}

interface ConversionProgressProps {
    files: FileConversionStatus[];
    onDownload: (index: number) => void;
    onDownloadAll: () => void;
}

export const ConversionProgress: React.FC<ConversionProgressProps> = ({
    files,
    onDownload,
    onDownloadAll,
}) => {
    const completedCount = files.filter(f => f.status === 'completed').length;
    const totalCount = files.length;
    const allCompleted = completedCount === totalCount && totalCount > 0;

    return (
        <div className="w-full">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                    変換進捗 ({completedCount} / {totalCount})
                </h3>
                {allCompleted && (
                    <button
                        onClick={onDownloadAll}
                        className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                    >
                        <Download className="w-4 h-4" />
                        <span>すべてダウンロード</span>
                    </button>
                )}
            </div>

            <div className="space-y-3">
                {files.map((file, index) => (
                    <div
                        key={`${file.fileName}-${index}`}
                        className="border rounded-lg p-4 bg-white shadow-sm"
                    >
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center space-x-3 flex-1">
                                {file.status === 'waiting' && (
                                    <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
                                )}
                                {file.status === 'converting' && (
                                    <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                                )}
                                {file.status === 'completed' && (
                                    <CheckCircle className="w-5 h-5 text-green-600" />
                                )}
                                {file.status === 'error' && (
                                    <XCircle className="w-5 h-5 text-red-600" />
                                )}

                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-gray-900 truncate">
                                        {file.fileName}
                                    </p>
                                    <p className="text-xs text-gray-500">
                                        {file.message ? file.message : (
                                            <>
                                                {file.status === 'waiting' && '待機中...'}
                                                {file.status === 'converting' && `変換中... ${Math.round(file.progress * 100)}%`}
                                                {file.status === 'completed' && '変換完了！'}
                                                {file.status === 'error' && `エラー: ${file.error}`}
                                            </>
                                        )}
                                    </p>
                                </div>
                            </div>

                            {file.status === 'completed' && (
                                <button
                                    onClick={() => onDownload(index)}
                                    className="flex items-center space-x-1 px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                                >
                                    <Download className="w-3 h-3" />
                                    <span>ダウンロード</span>
                                </button>
                            )}
                        </div>

                        {/* 進捗バー */}
                        {(file.status === 'converting' || file.status === 'completed') && (
                            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                <div
                                    className={`h-full transition-all duration-300 ${file.status === 'completed' ? 'bg-green-600' : 'bg-blue-600'
                                        }`}
                                    style={{ width: `${file.progress * 100}%` }}
                                />
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};


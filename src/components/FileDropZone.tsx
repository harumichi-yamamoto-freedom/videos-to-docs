'use client';

import React, { useCallback, useState } from 'react';
import { Upload, X, FileVideo, FileAudio } from 'lucide-react';

interface FileDropZoneProps {
    onFilesSelected: (files: File[]) => void;
    selectedFiles: File[];
    onRemoveFile: (index: number) => void;
}

export const FileDropZone: React.FC<FileDropZoneProps> = ({
    onFilesSelected,
    selectedFiles,
    onRemoveFile,
}) => {
    const [isDragOver, setIsDragOver] = useState(false);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);

        const files = Array.from(e.dataTransfer.files).filter(file =>
            file.type.startsWith('video/') ||
            file.type.startsWith('audio/') ||
            file.name.toLowerCase().match(/\.(mp4|mov|avi|mkv|webm|mp3|wav|m4a|aac|ogg|flac)$/)
        );

        if (files.length > 0) {
            onFilesSelected(files);
        }
    }, [onFilesSelected]);

    const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []).filter(file =>
            file.type.startsWith('video/') ||
            file.type.startsWith('audio/') ||
            file.name.toLowerCase().match(/\.(mp4|mov|avi|mkv|webm|mp3|wav|m4a|aac|ogg|flac)$/)
        );

        if (files.length > 0) {
            onFilesSelected(files);
        }
    }, [onFilesSelected]);

    const formatFileSize = (bytes: number): string => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <div className="w-full">
            {/* ドロップゾーン */}
            <div
                className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors ${isDragOver
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-300 hover:border-gray-400'
                    }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <input
                    type="file"
                    multiple
                    accept="video/*,audio/*,.mp4,.mov,.avi,.mkv,.webm,.mp3,.wav,.m4a,.aac,.ogg,.flac"
                    onChange={handleFileInput}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />

                <div className="flex flex-col items-center space-y-4">
                    <div className="p-4 bg-gray-100 rounded-full">
                        <Upload className="w-8 h-8 text-gray-600" />
                    </div>

                    <div>
                        <p className="text-lg font-medium text-gray-900">
                            動画・音声ファイルをドラッグ&ドロップ
                        </p>
                        <p className="text-sm text-gray-500 mt-1">
                            またはクリックしてファイルを選択
                        </p>
                        <p className="text-xs text-gray-400 mt-2">
                            動画: MP4, MOV, AVI, MKV, WebM<br />
                            音声: MP3, WAV, M4A, AAC, OGG, FLAC
                        </p>
                    </div>
                </div>
            </div>

            {/* 選択されたファイル一覧 */}
            {selectedFiles.length > 0 && (
                <div className="mt-6">
                    <h3 className="text-lg font-medium text-gray-900 mb-3">
                        選択されたファイル ({selectedFiles.length}件)
                    </h3>
                    <div className="space-y-2">
                        {selectedFiles.map((file, index) => {
                            const isAudio = file.type.startsWith('audio/') ||
                                file.name.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/);

                            return (
                                <div
                                    key={`${file.name}-${index}`}
                                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                                >
                                    <div className="flex items-center space-x-3">
                                        {isAudio ? (
                                            <FileAudio className="w-5 h-5 text-purple-600" />
                                        ) : (
                                            <FileVideo className="w-5 h-5 text-blue-600" />
                                        )}
                                        <div>
                                            <p className="text-sm font-medium text-gray-900">
                                                {file.name}
                                            </p>
                                            <p className="text-xs text-gray-500">
                                                {formatFileSize(file.size)} {isAudio ? '(音声)' : '(動画)'}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => onRemoveFile(index)}
                                        className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                                        title="ファイルを削除"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

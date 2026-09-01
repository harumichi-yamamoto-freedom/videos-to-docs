'use client';

import React, { useCallback, useId, useRef, useState } from 'react';
import { FileAudio, FileVideo, Upload, X } from 'lucide-react';

type MediaKind = 'video' | 'audio';

export interface SupportedMediaFormat {
    extension: string;
    label: string;
    kind: MediaKind;
    mimeTypes: readonly string[];
}

export const SUPPORTED_MEDIA_FORMATS = [
    { extension: '.mp4', label: 'MP4', kind: 'video', mimeTypes: ['video/mp4'] },
    { extension: '.mov', label: 'MOV', kind: 'video', mimeTypes: ['video/quicktime'] },
    { extension: '.avi', label: 'AVI', kind: 'video', mimeTypes: ['video/x-msvideo'] },
    { extension: '.mkv', label: 'MKV', kind: 'video', mimeTypes: ['video/x-matroska'] },
    { extension: '.webm', label: 'WebM', kind: 'video', mimeTypes: ['video/webm'] },
    { extension: '.mp3', label: 'MP3', kind: 'audio', mimeTypes: ['audio/mpeg'] },
    { extension: '.wav', label: 'WAV', kind: 'audio', mimeTypes: ['audio/wav', 'audio/x-wav'] },
    { extension: '.m4a', label: 'M4A', kind: 'audio', mimeTypes: ['audio/mp4', 'audio/x-m4a'] },
    { extension: '.aac', label: 'AAC', kind: 'audio', mimeTypes: ['audio/aac'] },
    { extension: '.ogg', label: 'OGG', kind: 'audio', mimeTypes: ['audio/ogg'] },
    { extension: '.flac', label: 'FLAC', kind: 'audio', mimeTypes: ['audio/flac'] },
] as const satisfies readonly SupportedMediaFormat[];

export const SUPPORTED_MEDIA_ACCEPT = SUPPORTED_MEDIA_FORMATS.flatMap(format => [
    format.extension,
    ...format.mimeTypes,
]).join(',');

export const SUPPORTED_MEDIA_LABELS = {
    video: SUPPORTED_MEDIA_FORMATS
        .filter(format => format.kind === 'video')
        .map(format => format.label)
        .join(', '),
    audio: SUPPORTED_MEDIA_FORMATS
        .filter(format => format.kind === 'audio')
        .map(format => format.label)
        .join(', '),
} satisfies Record<MediaKind, string>;

export interface RejectedMediaFile {
    fileName: string;
    reason: string;
}

interface FileDropZoneProps {
    /** fileIds は selectedFiles と同じ並びで発行される。以降の参照はインデックスではなくこのIDで行う */
    onFilesSelected: (files: File[], fileIds: string[]) => void;
    selectedFiles: File[];
    onRemoveFile: (index: number) => void;
    /** selectedFiles と同じ並びのID列。onFilesSelected で受け取ったものをそのまま渡す */
    fileIds: readonly string[];
    onRemoveFileById?: (fileId: string) => void;
    isProcessing?: boolean;
    activeFileIds?: readonly string[];
    onCancelFile?: (fileId: string) => void;
}

const findMediaFormat = (file: Pick<File, 'name'>) => {
    const lowerName = file.name.toLowerCase();
    return SUPPORTED_MEDIA_FORMATS.find(format => lowerName.endsWith(format.extension));
};

export const isSupportedMediaFile = (file: Pick<File, 'name' | 'type'>): boolean =>
    Boolean(findMediaFormat(file));

export const getSupportedMediaKind = (
    file: Pick<File, 'name' | 'type'>,
): MediaKind | null => findMediaFormat(file)?.kind ?? null;

export const getSupportedMediaMimeType = (
    file: Pick<File, 'name' | 'type'>,
): string | null => findMediaFormat(file)?.mimeTypes[0] ?? null;

export const partitionMediaFiles = (files: readonly File[]) => {
    const accepted: File[] = [];
    const rejected: RejectedMediaFile[] = [];

    for (const file of files) {
        if (isSupportedMediaFile(file)) {
            accepted.push(file);
            continue;
        }

        rejected.push({
            fileName: file.name || '名前のないファイル',
            reason: '対応していないファイル形式です。対応形式を確認して、別のファイルを選択してください。',
        });
    }

    return { accepted, rejected };
};

export const consumeFileInput = (
    input: Pick<HTMLInputElement, 'files' | 'value'>,
    consume: (files: File[]) => void,
) => {
    try {
        consume(Array.from(input.files ?? []));
    } finally {
        input.value = '';
    }
};

const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';

    const unit = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const sizeIndex = Math.min(
        Math.floor(Math.log(bytes) / Math.log(unit)),
        sizes.length - 1,
    );

    return `${parseFloat((bytes / Math.pow(unit, sizeIndex)).toFixed(2))} ${sizes[sizeIndex]}`;
};

export const FileDropZone: React.FC<FileDropZoneProps> = ({
    onFilesSelected,
    selectedFiles,
    onRemoveFile,
    fileIds,
    onRemoveFileById,
    isProcessing = false,
    activeFileIds = [],
    onCancelFile,
}) => {
    const [isDragOver, setIsDragOver] = useState(false);
    const [rejectedFiles, setRejectedFiles] = useState<RejectedMediaFile[]>([]);
    const inputId = useId();
    const descriptionId = useId();
    const generatedIdSequence = useRef(0);
    const generatedFileIds = useRef(new WeakMap<File, string>());

    const getOrCreateFileId = useCallback((file: File) => {
        const existingId = generatedFileIds.current.get(file);
        if (existingId) return existingId;

        generatedIdSequence.current += 1;
        const fileId = `media-${generatedIdSequence.current}`;
        generatedFileIds.current.set(file, fileId);
        return fileId;
    }, []);

    const acceptSelection = useCallback((files: File[]) => {
        if (isProcessing) return;

        const { accepted, rejected } = partitionMediaFiles(files);
        setRejectedFiles(rejected);

        if (accepted.length > 0) {
            onFilesSelected(accepted, accepted.map(getOrCreateFileId));
        }
    }, [getOrCreateFileId, isProcessing, onFilesSelected]);

    const handleDragOver = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        if (!isProcessing) setIsDragOver(true);
    }, [isProcessing]);

    const handleDragLeave = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        setIsDragOver(false);
    }, []);

    const handleDrop = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        setIsDragOver(false);
        acceptSelection(Array.from(event.dataTransfer.files));
    }, [acceptSelection]);

    const handleFileInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        consumeFileInput(event.currentTarget, acceptSelection);
    }, [acceptSelection]);

    return (
        <div className="w-full">
            <div
                className={`relative rounded-lg border-2 border-dashed p-8 text-center transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2 ${
                    isProcessing
                        ? 'border-gray-200 bg-gray-100'
                        : isDragOver
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-300 hover:border-gray-400'
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <input
                    id={inputId}
                    type="file"
                    multiple
                    accept={SUPPORTED_MEDIA_ACCEPT}
                    onChange={handleFileInput}
                    disabled={isProcessing}
                    aria-describedby={descriptionId}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 focus:outline-none disabled:cursor-not-allowed"
                />

                <label
                    htmlFor={inputId}
                    className={`flex flex-col items-center space-y-4 ${isProcessing ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                >
                    <span className="rounded-full bg-gray-100 p-4" aria-hidden="true">
                        <Upload className="h-8 w-8 text-gray-600" />
                    </span>

                    <span>
                        <span className="block text-lg font-medium text-gray-900">
                            動画・音声ファイルをドラッグ＆ドロップ
                        </span>
                        <span className="mt-1 block text-sm text-gray-600">
                            {isProcessing
                                ? '処理中はファイルを追加できません。'
                                : 'またはクリックしてファイルを選択してください。'}
                        </span>
                        <span id={descriptionId} className="mt-2 block text-[13px] leading-5 text-gray-600">
                            動画: {SUPPORTED_MEDIA_LABELS.video}<br />
                            音声: {SUPPORTED_MEDIA_LABELS.audio}
                        </span>
                    </span>
                </label>
            </div>

            {rejectedFiles.length > 0 && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3" role="alert">
                    <p className="text-sm font-medium text-red-800">
                        追加できなかったファイルがあります。
                    </p>
                    <ul className="mt-2 space-y-1 text-[13px] text-red-700">
                        {rejectedFiles.map((rejected, index) => (
                            <li key={`${rejected.fileName}-${index}`}>
                                <span className="font-medium">{rejected.fileName}</span>: {rejected.reason}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {selectedFiles.length > 0 && (
                <div className="mt-6">
                    <h3 className="mb-3 text-lg font-medium text-gray-900">
                        選択されたファイル ({selectedFiles.length}件)
                    </h3>
                    <div className="space-y-2">
                        {selectedFiles.map((file, index) => {
                            const fileId = fileIds[index] ?? `${file.name}-${index}`;
                            const isAudio = getSupportedMediaKind(file) === 'audio';
                            const canCancel = activeFileIds.includes(fileId) && Boolean(onCancelFile);

                            return (
                                <div
                                    key={fileId}
                                    data-file-id={fileId}
                                    className="flex min-h-11 items-center justify-between rounded-lg bg-gray-50 p-3"
                                >
                                    <div className="flex min-w-0 items-center space-x-3">
                                        {isAudio ? (
                                            <FileAudio className="h-5 w-5 shrink-0 text-purple-600" aria-hidden="true" />
                                        ) : (
                                            <FileVideo className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
                                        )}
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium text-gray-900">
                                                {file.name}
                                            </p>
                                            <p className="text-[13px] text-gray-600">
                                                {formatFileSize(file.size)} {isAudio ? '(音声)' : '(動画)'}
                                            </p>
                                        </div>
                                    </div>
                                    {canCancel ? (
                                        <button
                                            type="button"
                                            onClick={() => onCancelFile?.(fileId)}
                                            className="min-h-11 shrink-0 rounded-md px-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                                            aria-label={`${file.name}の処理を中止`}
                                        >
                                            処理を中止
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (onRemoveFileById) {
                                                    onRemoveFileById(fileId);
                                                } else {
                                                    onRemoveFile(index);
                                                }
                                            }}
                                            disabled={isProcessing}
                                            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:text-gray-300"
                                            aria-label={isProcessing
                                                ? `${file.name}は処理中のため削除できません`
                                                : `${file.name}を削除`}
                                            title={isProcessing ? '処理中は削除できません' : 'ファイルを削除'}
                                        >
                                            <X className="h-4 w-4" aria-hidden="true" />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

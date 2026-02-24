import { useState, useRef, useCallback } from 'react';
import { VideoConverter } from '@/lib/ffmpeg';
import { GeminiClient } from '@/lib/gemini';
import { saveTranscription } from '@/lib/firestore';
import { FileProcessingStatus, FileWithPrompts, DebugErrorMode } from '@/types/processing';
import { Prompt } from '@/lib/prompts';
import { validatePromptPermission } from '@/lib/promptPermissions';
import { createLogger } from '@/lib/logger';

const videoProcessingLogger = createLogger('useVideoProcessing');

export const useVideoProcessing = (
    availablePrompts: Prompt[],
    debugErrorMode: DebugErrorMode,
    onDocumentSaved?: () => void
) => {
    const [processingStatuses, setProcessingStatuses] = useState<FileProcessingStatus[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
    const converterRef = useRef<VideoConverter | null>(null);
    const geminiClientRef = useRef<GeminiClient | null>(null);
    const audioConversionQueueRef = useRef<boolean>(false);

    // 文書生成処理（並列実行される）
    const processTranscription = useCallback(async (
        file: FileWithPrompts,
        fileIndex: number,
        audioBlob: Blob,
        bitrate: string,
        sampleRate: number
    ) => {
        try {
            // デバッグ用: 意図的にGeminiエラーを発生させる
            if (debugErrorMode.geminiError && fileIndex === debugErrorMode.errorAtFileIndex) {
                throw new Error('[デバッグ] 意図的に発生させたGemini APIエラー');
            }

            // 文書生成開始
            setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                    idx === fileIndex
                        ? { ...status, status: 'transcribing', phase: 'text_generation', transcriptionCount: 0 }
                        : status
                )
            );

            // 選択されたプロンプト情報を取得
            const selectedPrompts = availablePrompts.filter(p =>
                file.selectedPromptIds.includes(p.id!)
            );

            // プロンプト利用権限をチェック
            for (const prompt of selectedPrompts) {
                try {
                    validatePromptPermission(prompt);
                } catch (permissionError) {
                    videoProcessingLogger.error('プロンプト利用権限チェックに失敗', permissionError, {
                        promptId: prompt.id,
                    });
                    throw permissionError;
                }
            }

            videoProcessingLogger.info('文書生成を開始', {
                fileName: file.file.name,
                fileIndex,
                promptCount: selectedPrompts.length,
                promptNames: selectedPrompts.map(p => p.name),
                blobMimeType: audioBlob.type,
                blobSizeInMB: (audioBlob.size / 1024 / 1024).toFixed(2),
            });

            // 同一Blobを複数FileReaderで同時読みすると大容量で空になることがあるため、
            // Base64は1回だけ取得し、全プロンプトで共有する
            const mimeType = audioBlob.type || (audioBlob.type?.startsWith('video/') ? 'video/mp4' : 'audio/mpeg');
            let base64Data: string;
            try {
                base64Data = await geminiClientRef.current!.getBase64(audioBlob);
            } catch (base64Error) {
                videoProcessingLogger.error('Base64変換に失敗', base64Error, { fileIndex });
                throw new Error('音声/動画データの読み取りに失敗しました。ファイルが大きい場合は再試行してください。');
            }
            if (!base64Data || base64Data.length === 0) {
                videoProcessingLogger.error('Base64データが空です', { fileIndex, blobSize: audioBlob.size });
                throw new Error('音声/動画データの読み取りに失敗しました。');
            }

            // 各プロンプトで文書生成（並列処理・同一Base64を共有）
            await Promise.all(
                selectedPrompts.map(async (prompt) => {
                    try {
                        const isVideoBlob = mimeType.startsWith('video/');
                        videoProcessingLogger.info(`プロンプト「${prompt.name}」の処理を開始`, {
                            fileIndex,
                            promptId: prompt.id,
                            promptModel: prompt.model,
                            isVideoBlob,
                        });

                        const transcriptionResult = await geminiClientRef.current!.transcribeWithBase64(
                            base64Data,
                            mimeType,
                            file.file.name,
                            prompt.content,
                            prompt.model
                        );

                        videoProcessingLogger.info(`プロンプト「${prompt.name}」の Gemini API 呼び出し完了`, {
                            fileIndex,
                            promptId: prompt.id,
                            success: transcriptionResult.success,
                            textLength: transcriptionResult.text?.length,
                        });

                        if (transcriptionResult.success && transcriptionResult.text) {
                            videoProcessingLogger.info('Firestoreへ保存を開始', {
                                fileIndex,
                                promptId: prompt.id,
                                promptName: prompt.name,
                            });
                            // Firestoreに保存
                            await saveTranscription(
                                file.file.name,
                                transcriptionResult.text,
                                prompt.name,
                                file.file.type.startsWith('video/') ? 'video' : 'audio',
                                bitrate,
                                sampleRate
                            );
                            videoProcessingLogger.info('Firestoreへの保存が完了', {
                                fileIndex,
                                promptId: prompt.id,
                            });

                            // 文書一覧を更新
                            if (onDocumentSaved) {
                                onDocumentSaved();
                            }

                            // 進捗を更新（完了したプロンプトIDを記録）
                            setProcessingStatuses(prev =>
                                prev.map((status, idx) => {
                                    if (idx === fileIndex) {
                                        const newCount = status.transcriptionCount + 1;
                                        const completedPromptIds = [...status.completedPromptIds, prompt.id!];
                                        return {
                                            ...status,
                                            transcriptionCount: newCount,
                                            completedPromptIds,
                                        };
                                    }
                                    return status;
                                })
                            );
                        } else if (!transcriptionResult.success) {
                            videoProcessingLogger.error(
                                `プロンプト「${prompt.name}」での文書生成が失敗`,
                                transcriptionResult.error,
                                { promptId: prompt.id, fileIndex }
                            );
                            throw new Error(transcriptionResult.error || 'Gemini API処理失敗');
                        }
                    } catch (promptError) {
                        videoProcessingLogger.error(
                            `プロンプト「${prompt.name}」での文書生成中にエラー`,
                            promptError,
                            { promptId: prompt.id, fileIndex }
                        );
                        throw promptError;
                    }
                })
            );

            // 完了
            setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                    idx === fileIndex
                        ? { ...status, status: 'completed', phase: 'completed' }
                        : status
                )
            );
        } catch (error) {
            videoProcessingLogger.error(`ファイル ${file.file.name} の文書生成に失敗`, error, {
                fileIndex,
            });
            setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                    idx === fileIndex
                        ? {
                            ...status,
                            status: 'error',
                            error: error instanceof Error ? error.message : '不明なエラー',
                            failedPhase: 'text_generation'
                        }
                        : status
                )
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [availablePrompts, debugErrorMode]);

    // 文書生成処理（再開用 - 未完了のプロンプトのみ処理）
    const processTranscriptionResume = useCallback(async (
        file: FileWithPrompts,
        fileIndex: number,
        audioBlob: Blob,
        completedPromptIds: string[],
        bitrate: string,
        sampleRate: number
    ) => {
        try {
            // デバッグ用: 意図的にGeminiエラーを発生させる
            if (debugErrorMode.geminiError && fileIndex === debugErrorMode.errorAtFileIndex) {
                throw new Error('[デバッグ] 意図的に発生させたGemini APIエラー');
            }

            // 文書生成開始
            setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                    idx === fileIndex
                        ? { ...status, status: 'transcribing', phase: 'text_generation', error: undefined }
                        : status
                )
            );

            // 選択されたプロンプトのうち、未完了のものだけを取得
            const selectedPrompts = availablePrompts.filter(p =>
                file.selectedPromptIds.includes(p.id!) && !completedPromptIds.includes(p.id!)
            );

            // 未完了のプロンプトがない場合は完了扱い
            if (selectedPrompts.length === 0) {
                setProcessingStatuses(prev =>
                    prev.map((status, idx) =>
                        idx === fileIndex
                            ? { ...status, status: 'completed', phase: 'completed' }
                            : status
                    )
                );
                return;
            }

            videoProcessingLogger.info('文書生成を再開', {
                fileName: file.file.name,
                fileIndex,
                promptCount: selectedPrompts.length,
                promptNames: selectedPrompts.map(p => p.name),
                blobMimeType: audioBlob.type,
                blobSizeInMB: (audioBlob.size / 1024 / 1024).toFixed(2),
            });

            // Base64は1回だけ取得し、全プロンプトで共有する（大容量時の空データ対策）
            const mimeType = audioBlob.type || (audioBlob.type?.startsWith('video/') ? 'video/mp4' : 'audio/mpeg');
            let base64Data: string;
            try {
                base64Data = await geminiClientRef.current!.getBase64(audioBlob);
            } catch (base64Error) {
                videoProcessingLogger.error('Base64変換に失敗（再開）', base64Error, { fileIndex });
                throw new Error('音声/動画データの読み取りに失敗しました。ファイルが大きい場合は再試行してください。');
            }
            if (!base64Data || base64Data.length === 0) {
                videoProcessingLogger.error('Base64データが空です（再開）', { fileIndex, blobSize: audioBlob.size });
                throw new Error('音声/動画データの読み取りに失敗しました。');
            }

            // 各プロンプトで文書生成（並列処理・同一Base64を共有）
            await Promise.all(
                selectedPrompts.map(async (prompt) => {
                    try {
                        const isVideoBlob = mimeType.startsWith('video/');
                        videoProcessingLogger.info(`プロンプト「${prompt.name}」の処理を開始（再開）`, {
                            fileIndex,
                            promptId: prompt.id,
                            promptModel: prompt.model,
                            isVideoBlob,
                        });

                        const transcriptionResult = await geminiClientRef.current!.transcribeWithBase64(
                            base64Data,
                            mimeType,
                            file.file.name,
                            prompt.content,
                            prompt.model
                        );

                        videoProcessingLogger.info(`プロンプト「${prompt.name}」の Gemini API 呼び出し完了（再開）`, {
                            fileIndex,
                            promptId: prompt.id,
                            success: transcriptionResult.success,
                            textLength: transcriptionResult.text?.length,
                        });

                        if (transcriptionResult.success && transcriptionResult.text) {
                            videoProcessingLogger.info('Firestoreへ保存を開始（再開）', {
                                fileIndex,
                                promptId: prompt.id,
                                promptName: prompt.name,
                            });
                            // Firestoreに保存
                            await saveTranscription(
                                file.file.name,
                                transcriptionResult.text,
                                prompt.name,
                                file.file.type.startsWith('video/') ? 'video' : 'audio',
                                bitrate,
                                sampleRate
                            );
                            videoProcessingLogger.info('Firestoreへの保存が完了（再開）', {
                                fileIndex,
                                promptId: prompt.id,
                            });

                            // 文書一覧を更新
                            if (onDocumentSaved) {
                                onDocumentSaved();
                            }

                            // 進捗を更新（完了したプロンプトIDを記録）
                            setProcessingStatuses(prev =>
                                prev.map((status, idx) => {
                                    if (idx === fileIndex) {
                                        const newCount = status.transcriptionCount + 1;
                                        const newCompletedPromptIds = [...status.completedPromptIds, prompt.id!];
                                        return {
                                            ...status,
                                            transcriptionCount: newCount,
                                            completedPromptIds: newCompletedPromptIds,
                                        };
                                    }
                                    return status;
                                })
                            );
                        } else if (!transcriptionResult.success) {
                            videoProcessingLogger.error(
                                `プロンプト「${prompt.name}」での文書生成が失敗`,
                                transcriptionResult.error,
                                { promptId: prompt.id, fileIndex }
                            );
                            throw new Error(transcriptionResult.error || 'Gemini API処理失敗');
                        }
                    } catch (promptError) {
                        videoProcessingLogger.error(
                            `プロンプト「${prompt.name}」での文書生成中にエラー`,
                            promptError,
                            { promptId: prompt.id, fileIndex }
                        );
                        throw promptError;
                    }
                })
            );

            // 完了
            setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                    idx === fileIndex
                        ? { ...status, status: 'completed', phase: 'completed' }
                        : status
                )
            );
        } catch (error) {
            videoProcessingLogger.error(`ファイル ${file.file.name} の文書生成に失敗`, error, {
                fileIndex,
                resume: true,
            });
            setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                    idx === fileIndex
                        ? {
                            ...status,
                            status: 'error',
                            error: error instanceof Error ? error.message : '不明なエラー',
                            failedPhase: 'text_generation'
                        }
                        : status
                )
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [availablePrompts, debugErrorMode]);

    return {
        processingStatuses,
        setProcessingStatuses,
        isProcessing,
        setIsProcessing,
        ffmpegLoaded,
        setFfmpegLoaded,
        converterRef,
        geminiClientRef,
        audioConversionQueueRef,
        processTranscription,
        processTranscriptionResume,
    };
};


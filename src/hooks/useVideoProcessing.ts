import { useState, useRef, useCallback } from 'react';
import { VideoConverter } from '@/lib/ffmpeg';
import { GeminiClient } from '@/lib/gemini';
import { saveTranscription } from '@/lib/firestore';
import { FileProcessingStatus, FileWithPrompts, DebugErrorMode } from '@/types/processing';
import { Prompt } from '@/lib/prompts';
import { validatePromptPermission } from '@/lib/promptPermissions';

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
                    console.error('プロンプト利用権限エラー:', permissionError);
                    throw permissionError;
                }
            }

            // 各プロンプトで文書生成（並列処理）
            await Promise.all(
                selectedPrompts.map(async (prompt) => {
                    try {
                        const transcriptionResult = await geminiClientRef.current!.transcribeAudio(
                            audioBlob,
                            file.file.name,
                            prompt.content
                        );

                        if (transcriptionResult.success && transcriptionResult.text) {
                            // Firestoreに保存
                            await saveTranscription(
                                file.file.name,
                                transcriptionResult.text,
                                prompt.name,
                                file.file.type.startsWith('video/') ? 'video' : 'audio',
                                bitrate,
                                sampleRate
                            );

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
                            console.error(`プロンプト「${prompt.name}」での文書生成失敗:`, transcriptionResult.error);
                            throw new Error(transcriptionResult.error || 'Gemini API処理失敗');
                        }
                    } catch (promptError) {
                        console.error(`プロンプト「${prompt.name}」での文書生成エラー:`, promptError);
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
            console.error(`ファイル ${file.file.name} の文書生成エラー:`, error);
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

            // 各プロンプトで文書生成（並列処理）
            await Promise.all(
                selectedPrompts.map(async (prompt) => {
                    try {
                        const transcriptionResult = await geminiClientRef.current!.transcribeAudio(
                            audioBlob,
                            file.file.name,
                            prompt.content
                        );

                        if (transcriptionResult.success && transcriptionResult.text) {
                            // Firestoreに保存
                            await saveTranscription(
                                file.file.name,
                                transcriptionResult.text,
                                prompt.name,
                                file.file.type.startsWith('video/') ? 'video' : 'audio',
                                bitrate,
                                sampleRate
                            );

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
                            console.error(`プロンプト「${prompt.name}」での文書生成失敗:`, transcriptionResult.error);
                            throw new Error(transcriptionResult.error || 'Gemini API処理失敗');
                        }
                    } catch (promptError) {
                        console.error(`プロンプト「${prompt.name}」での文書生成エラー:`, promptError);
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
            console.error(`ファイル ${file.file.name} の文書生成エラー:`, error);
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


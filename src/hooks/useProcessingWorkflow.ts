import { useCallback } from 'react';
import { VideoConverter } from '@/lib/ffmpeg';
import { GeminiClient } from '@/lib/gemini';
import { FileWithPrompts, FileProcessingStatus, DebugErrorMode } from '@/types/processing';
import { convertVideoToAudioSegments, resumeVideoConversion } from '@/lib/videoConversionService';
import { createLogger } from '@/lib/logger';

interface UseProcessingWorkflowProps {
    converterRef: React.MutableRefObject<VideoConverter | null>;
    geminiClientRef: React.MutableRefObject<GeminiClient | null>;
    audioConversionQueueRef: React.MutableRefObject<boolean>;
    ffmpegLoaded: boolean;
    setFfmpegLoaded: (loaded: boolean) => void;
    setProcessingStatuses: React.Dispatch<React.SetStateAction<FileProcessingStatus[]>>;
    processTranscription: (file: FileWithPrompts, fileIndex: number, audioBlob: Blob, bitrate: string, sampleRate: number) => Promise<void>;
    processTranscriptionResume: (file: FileWithPrompts, fileIndex: number, audioBlob: Blob, completedPromptIds: string[], bitrate: string, sampleRate: number) => Promise<void>;
    debugErrorMode: DebugErrorMode;
}

const processingWorkflowLogger = createLogger('useProcessingWorkflow');

export const useProcessingWorkflow = ({
    converterRef,
    geminiClientRef,
    audioConversionQueueRef,
    ffmpegLoaded,
    setFfmpegLoaded,
    setProcessingStatuses,
    processTranscription,
    processTranscriptionResume,
    debugErrorMode,
}: UseProcessingWorkflowProps) => {

    // メイン処理
    const handleStartProcessing = useCallback(async (
        selectedFiles: FileWithPrompts[],
        bitrate: string,
        sampleRate: number
    ) => {
        if (selectedFiles.length === 0) return;

        // プロンプトが選択されているか確認
        const hasPrompts = selectedFiles.every(file => file.selectedPromptIds.length > 0);
        if (!hasPrompts) {
            alert('すべてのファイルに最低1つのプロンプトを選択してください');
            return;
        }

        // 初期ステータスを設定
        const initialStatuses: FileProcessingStatus[] = selectedFiles.map(fileWithPrompts => ({
            fileName: fileWithPrompts.file.name,
            status: 'waiting',
            phase: 'waiting',
            audioConversionProgress: 0,
            totalTranscriptions: fileWithPrompts.selectedPromptIds.length,
            transcriptionCount: 0,
            completedPromptIds: [],
            segmentDuration: 30,
            segments: [],
            completedSegmentIndices: [],
        }));
        setProcessingStatuses(initialStatuses);

        // VideoConverterインスタンスを作成
        if (!converterRef.current) {
            converterRef.current = new VideoConverter();
        }

        // GeminiClientインスタンスを作成
        if (!geminiClientRef.current) {
            geminiClientRef.current = new GeminiClient();
        }

        try {
            // FFmpegを初回のみロード
            if (!ffmpegLoaded) {
                await converterRef.current.load();
                setFfmpegLoaded(true);
            }

            // パイプライン処理: 音声変換（直列）→ 変換完了次第、文書生成を並列開始
            const transcriptionPromises: Promise<void>[] = [];

            for (let i = 0; i < selectedFiles.length; i++) {
                const file = selectedFiles[i];

                // 音声ファイルかどうかを判定
                const isAudioFile = file.file.type.startsWith('audio/') ||
                    file.file.name.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/);

                if (isAudioFile) {
                    // 音声ファイルの場合：音声変換をスキップして直接文書生成へ
                    setProcessingStatuses(prev =>
                        prev.map((status, idx) =>
                            idx === i
                                ? { ...status, convertedAudioBlob: file.file as Blob }
                                : status
                        )
                    );
                    const transcriptionPromise = processTranscription(file, i, file.file as Blob, bitrate, sampleRate);
                    transcriptionPromises.push(transcriptionPromise);
                } else {
                    // 動画ファイルの場合：区間変換が必要（直列処理）
                    audioConversionQueueRef.current = true;

                    try {
                        // 動画の長さを取得と区間変換
                        setProcessingStatuses(prev =>
                            prev.map((status, idx) =>
                                idx === i
                                    ? { ...status, status: 'converting', phase: 'audio_conversion', audioConversionProgress: 0 }
                                    : status
                            )
                        );

                        const audioBlob = await convertVideoToAudioSegments(
                            file,
                            i,
                            converterRef.current!,
                            bitrate,
                            sampleRate,
                            debugErrorMode,
                            setProcessingStatuses
                        );

                        if (audioBlob) {
                            // 音声変換が成功したら、Blobをキャッシュしてすぐに文書生成を並列で開始
                            setProcessingStatuses(prev =>
                                prev.map((status, idx) =>
                                    idx === i
                                        ? { ...status, convertedAudioBlob: audioBlob }
                                        : status
                                )
                            );
                            const transcriptionPromise = processTranscription(file, i, audioBlob, bitrate, sampleRate);
                            transcriptionPromises.push(transcriptionPromise);
                        }
                    } finally {
                        // 音声変換処理完了
                        audioConversionQueueRef.current = false;
                    }
                }
            }

            // すべての文書生成が完了するまで待機
            await Promise.all(transcriptionPromises);
        } catch (error) {
            processingWorkflowLogger.error('一括処理でエラーが発生', error);
            alert('処理中にエラーが発生しました: ' + (error instanceof Error ? error.message : '不明なエラー'));
        }
    }, [
        converterRef,
        geminiClientRef,
        audioConversionQueueRef,
        ffmpegLoaded,
        setFfmpegLoaded,
        setProcessingStatuses,
        processTranscription,
        debugErrorMode
    ]);

    // 再開処理
    const handleResumeFile = useCallback(async (
        fileIndex: number,
        selectedFiles: FileWithPrompts[],
        processingStatuses: FileProcessingStatus[],
        bitrate: string,
        sampleRate: number
    ) => {
        processingWorkflowLogger.info('再開処理を開始', { fileIndex });

        const file = selectedFiles[fileIndex];
        const status = processingStatuses[fileIndex];

        if (!file || !status) {
            processingWorkflowLogger.error(
                '再開対象のファイルまたはステータスが見つかりません',
                undefined,
                {
                    fileIndex,
                    selectedFiles: selectedFiles.length,
                    processingStatuses: processingStatuses.length,
                }
            );
            return;
        }

        if (status.isResuming) {
            processingWorkflowLogger.warn('再開処理は既に進行中のためスキップ', { fileIndex });
            return;
        }

        processingWorkflowLogger.info('再開対象の現在ステータス', {
            fileIndex,
            fileName: status.fileName,
            phase: status.phase,
            status: status.status,
            hasError: Boolean(status.error),
            failedPhase: status.failedPhase,
            segments: status.segments.length,
            completedSegments: status.completedSegmentIndices.length,
            hasAudio: Boolean(status.convertedAudioBlob),
            completedPrompts: status.completedPromptIds.length,
            totalPrompts: status.totalTranscriptions,
        });

        setProcessingStatuses(prev =>
            prev.map((s, idx) =>
                idx === fileIndex
                    ? { ...s, isResuming: true, error: undefined }
                    : s
            )
        );

        try {
            processingWorkflowLogger.info('再開処理に必要なインスタンスを準備', { fileIndex });
            if (!converterRef.current) {
                converterRef.current = new VideoConverter();
                processingWorkflowLogger.info('VideoConverter を新規作成', { fileIndex });
            }

            if (!geminiClientRef.current) {
                geminiClientRef.current = new GeminiClient();
                processingWorkflowLogger.info('GeminiClient を新規作成', { fileIndex });
            }

            if (!ffmpegLoaded) {
                processingWorkflowLogger.info('FFmpeg を読み込み', { fileIndex });
                await converterRef.current.load();
                setFfmpegLoaded(true);
                processingWorkflowLogger.info('FFmpeg の読み込みが完了', { fileIndex });
            }

            processingWorkflowLogger.info('再開処理の分岐を判定', { fileIndex });

            // 音声変換済みの場合は、文書生成のみを実行
            if (status.convertedAudioBlob) {
                processingWorkflowLogger.info('音声変換済みのため文書生成のみを再開', { fileIndex });
                await processTranscriptionResume(file, fileIndex, status.convertedAudioBlob, status.completedPromptIds, bitrate, sampleRate);
            } else {
                processingWorkflowLogger.info('音声未変換のためファイルタイプを判定', { fileIndex });

                const isAudioFile = file.file.type.startsWith('audio/') ||
                    file.file.name.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/);

                if (isAudioFile) {
                    processingWorkflowLogger.info('音声ファイルを検出したため変換をスキップ', { fileIndex });
                    setProcessingStatuses(prev =>
                        prev.map((s, idx) =>
                            idx === fileIndex
                                ? { ...s, convertedAudioBlob: file.file as Blob }
                                : s
                        )
                    );
                    await processTranscriptionResume(file, fileIndex, file.file as Blob, status.completedPromptIds, bitrate, sampleRate);
                } else {
                    processingWorkflowLogger.info('動画ファイルを検出したため音声変換を再開', { fileIndex });
                    setProcessingStatuses(prev =>
                        prev.map((s, idx) =>
                            idx === fileIndex
                                ? { ...s, phase: 'waiting' }
                                : s
                        )
                    );

                    processingWorkflowLogger.info('音声変換キューの空きを確認', { fileIndex });
                    let waitCount = 0;
                    while (audioConversionQueueRef.current) {
                        waitCount++;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    if (waitCount > 0) {
                        processingWorkflowLogger.info('音声変換キューの待機が完了', {
                            fileIndex,
                            waitedMs: waitCount * 100,
                        });
                    } else {
                        processingWorkflowLogger.info('音声変換キューに即座に参加', { fileIndex });
                    }

                    audioConversionQueueRef.current = true;
                    processingWorkflowLogger.info('音声変換キューをロック', { fileIndex });

                    try {
                        processingWorkflowLogger.info('音声変換フェーズへ遷移', { fileIndex });
                        setProcessingStatuses(prev =>
                            prev.map((s, idx) =>
                                idx === fileIndex
                                    ? { ...s, status: 'converting', phase: 'audio_conversion' }
                                    : s
                            )
                        );

                        const audioBlob = await resumeVideoConversion(
                            file,
                            fileIndex,
                            status,
                            converterRef.current!,
                            bitrate,
                            sampleRate,
                            debugErrorMode,
                            setProcessingStatuses
                        );

                        if (audioBlob) {
                            setProcessingStatuses(prev =>
                                prev.map((s, idx) =>
                                    idx === fileIndex
                                        ? { ...s, convertedAudioBlob: audioBlob }
                                        : s
                                )
                            );
                            await processTranscriptionResume(file, fileIndex, audioBlob, status.completedPromptIds, bitrate, sampleRate);
                        }
                    } finally {
                        processingWorkflowLogger.info('音声変換キューのロックを解除', { fileIndex });
                        audioConversionQueueRef.current = false;
                    }
                }
            }
        } catch (error) {
            processingWorkflowLogger.error('再開処理でエラーが発生', error, { fileIndex });
            setProcessingStatuses(prev =>
                prev.map((s, idx) =>
                    idx === fileIndex
                        ? {
                            ...s,
                            status: 'error',
                            error: error instanceof Error ? error.message : '不明なエラー',
                            isResuming: false
                        }
                        : s
                )
            );
        } finally {
            processingWorkflowLogger.info('再開処理の終了処理を実行', { fileIndex });
            setProcessingStatuses(prev =>
                prev.map((s, idx) =>
                    idx === fileIndex && s.isResuming
                        ? { ...s, isResuming: false }
                        : s
                )
            );
            processingWorkflowLogger.info('isResuming フラグを解除', { fileIndex });
        }
    }, [
        converterRef,
        geminiClientRef,
        audioConversionQueueRef,
        ffmpegLoaded,
        setFfmpegLoaded,
        setProcessingStatuses,
        processTranscriptionResume,
        debugErrorMode
    ]);

    return {
        handleStartProcessing,
        handleResumeFile,
    };
};



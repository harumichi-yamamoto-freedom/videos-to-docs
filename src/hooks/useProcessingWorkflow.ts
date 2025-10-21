import { useCallback } from 'react';
import { VideoConverter } from '@/lib/ffmpeg';
import { GeminiClient } from '@/lib/gemini';
import { FileWithPrompts, FileProcessingStatus, DebugErrorMode } from '@/types/processing';
import { convertVideoToAudioSegments, resumeVideoConversion } from '@/lib/videoConversionService';

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
            console.error('処理エラー:', error);
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
        console.log('='.repeat(80));
        console.log('🔄 [再開] 処理開始 - ファイルインデックス:', fileIndex);
        console.log('='.repeat(80));

        const file = selectedFiles[fileIndex];
        const status = processingStatuses[fileIndex];

        if (!file || !status) {
            console.error('❌ [再開] エラー: ファイルまたはステータスが見つかりません');
            console.error('  - selectedFiles.length:', selectedFiles.length);
            console.error('  - processingStatuses.length:', processingStatuses.length);
            console.error('  - fileIndex:', fileIndex);
            return;
        }

        if (status.isResuming) {
            console.log('⏸️ [再開] スキップ: 既に再開処理中です');
            return;
        }

        console.log('📊 [再開] 現在のステータス:');
        console.log('  - ファイル名:', status.fileName);
        console.log('  - フェーズ:', status.phase);
        console.log('  - ステータス:', status.status);
        console.log('  - エラー:', status.error);
        console.log('  - 失敗フェーズ:', status.failedPhase);
        console.log('  - 区間数:', status.segments.length);
        console.log('  - 完了区間数:', status.completedSegmentIndices.length);
        console.log('  - 音声変換済み:', !!status.convertedAudioBlob);
        console.log('  - 完了プロンプト数:', status.completedPromptIds.length, '/', status.totalTranscriptions);

        console.log('🚩 [再開] フラグ設定: isResuming = true');
        setProcessingStatuses(prev =>
            prev.map((s, idx) =>
                idx === fileIndex
                    ? { ...s, isResuming: true, error: undefined }
                    : s
            )
        );

        try {
            console.log('🔧 [再開] インスタンス確認中...');
            if (!converterRef.current) {
                console.log('  - VideoConverter新規作成');
                converterRef.current = new VideoConverter();
            } else {
                console.log('  - VideoConverter既存');
            }

            if (!geminiClientRef.current) {
                console.log('  - GeminiClient新規作成');
                geminiClientRef.current = new GeminiClient();
            } else {
                console.log('  - GeminiClient既存');
            }

            if (!ffmpegLoaded) {
                console.log('⏳ [再開] FFmpeg読み込み中...');
                await converterRef.current.load();
                setFfmpegLoaded(true);
                console.log('✅ [再開] FFmpeg読み込み完了');
            } else {
                console.log('✅ [再開] FFmpeg既に読み込み済み');
            }

            console.log('🔀 [再開] 処理分岐判定...');

            // 音声変換済みの場合は、文書生成のみを実行
            if (status.convertedAudioBlob) {
                console.log('📝 [再開] 分岐A: 音声変換済み → 文書生成のみ実行');
                await processTranscriptionResume(file, fileIndex, status.convertedAudioBlob, status.completedPromptIds, bitrate, sampleRate);
            } else {
                console.log('🎵 [再開] 分岐B: 音声未変換 → ファイルタイプ判定');

                const isAudioFile = file.file.type.startsWith('audio/') ||
                    file.file.name.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/);

                if (isAudioFile) {
                    console.log('🎼 [再開] 分岐B-1: 音声ファイル検出 → 音声変換スキップ');
                    setProcessingStatuses(prev =>
                        prev.map((s, idx) =>
                            idx === fileIndex
                                ? { ...s, convertedAudioBlob: file.file as Blob }
                                : s
                        )
                    );
                    await processTranscriptionResume(file, fileIndex, file.file as Blob, status.completedPromptIds, bitrate, sampleRate);
                } else {
                    console.log('🎬 [再開] 分岐B-2: 動画ファイル検出 → 音声変換が必要');

                    console.log('⏸️ [再開] 待機中状態に設定');
                    setProcessingStatuses(prev =>
                        prev.map((s, idx) =>
                            idx === fileIndex
                                ? { ...s, phase: 'waiting' }
                                : s
                        )
                    );

                    console.log('🔒 [再開] 音声変換キュー確認中...');
                    let waitCount = 0;
                    while (audioConversionQueueRef.current) {
                        waitCount++;
                        if (waitCount % 10 === 0) {
                            console.log(`  - 待機中... (${waitCount * 100}ms経過)`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    if (waitCount > 0) {
                        console.log(`✅ [再開] 待機完了 (${waitCount * 100}ms)`);
                    } else {
                        console.log('✅ [再開] キュー空き - 即座に開始');
                    }

                    console.log('🔓 [再開] キューをロック');
                    audioConversionQueueRef.current = true;

                    try {
                        console.log('🎯 [再開] 音声変換フェーズに移行');
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
                        console.log('🔓 [再開] キューのロック解除');
                        audioConversionQueueRef.current = false;
                    }
                }
            }
        } catch (error) {
            console.error('='.repeat(80));
            console.error('❌ [再開] キャッチされたエラー:');
            console.error('  - エラーメッセージ:', error instanceof Error ? error.message : '不明なエラー');
            console.error('  - エラースタック:', error instanceof Error ? error.stack : 'スタックなし');
            console.error('='.repeat(80));
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
            console.log('🏁 [再開] finally ブロック実行');
            console.log('  - ファイルインデックス:', fileIndex);
            setProcessingStatuses(prev =>
                prev.map((s, idx) =>
                    idx === fileIndex && s.isResuming
                        ? { ...s, isResuming: false }
                        : s
                )
            );
            console.log('✨ [再開] 処理完了 - isResumingフラグクリア');
            console.log('='.repeat(80));
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



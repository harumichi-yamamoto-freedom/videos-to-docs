import { VideoConverter } from '@/lib/ffmpeg';
import { FileWithPrompts, FileProcessingStatus, SegmentStatus, DebugErrorMode } from '@/types/processing';
import { calculateOverallProgress } from '@/utils/progressCalculator';
import { createLogger } from './logger';

/**
 * 動画区間処理の設定
 * メモリ制限対策: 区間数が多いとFFmpeg WASMメモリが累積的に不足するため、
 * 最大区間数を制限し、必要に応じて区間長を自動調整します。
 */
export const VIDEO_SEGMENT_CONFIG = {
    /** 推奨される1区間の長さ（秒）*/
    PREFERRED_SEGMENT_DURATION: 30,

    /** 最大区間数（この値を超える場合は区間を自動延長）
     * 目安: 各区間処理で約15MBのメモリが累積
     * 60区間 × 15MB = 900MB の累積（1GB動画 + 900MB = WASM 2GB制限内で安全）
     */
    MAX_SEGMENT_COUNT: 60,
} as const;

const videoConversionLogger = createLogger('videoConversion');

/**
 * 区間ベースで動画を音声に変換
 */
export const convertVideoToAudioSegments = async (
    file: FileWithPrompts,
    fileIndex: number,
    converter: VideoConverter,
    bitrate: string,
    sampleRate: number,
    debugErrorMode: DebugErrorMode,
    setProcessingStatuses: React.Dispatch<React.SetStateAction<FileProcessingStatus[]>>
): Promise<Blob | null> => {
    // 共有入力ファイル名
    const sharedInputFileName = `shared_input_${Date.now()}.${file.file.name.split('.').pop()}`;

    try {
        // 動画解析フェーズ開始
        setProcessingStatuses(prev =>
            prev.map((status, idx) =>
                idx === fileIndex
                    ? { ...status, phase: 'video_analysis' }
                    : status
            )
        );

        // 動画の長さを取得（同時に共有ファイルも作成して再利用）
        let totalDuration: number;
        try {
            const result = await converter.getVideoDurationWithSharedFile(file.file, sharedInputFileName);
            totalDuration = result.duration;
            videoConversionLogger.info(`[ファイル${fileIndex}] 動画情報取得完了: ${totalDuration}秒（共有ファイル: ${sharedInputFileName}）`);
        } catch (durationError) {
            const errorMessage = durationError instanceof Error ? durationError.message : '動画の長さを取得できませんでした';
            setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                    idx === fileIndex
                        ? {
                            ...status,
                            status: 'error',
                            error: errorMessage,
                            failedPhase: 'audio_conversion'
                        }
                        : status
                )
            );
            return null;
        }

        // 区間数とメモリを最適化: 区間数が多すぎる場合は区間を自動延長
        const { PREFERRED_SEGMENT_DURATION, MAX_SEGMENT_COUNT } = VIDEO_SEGMENT_CONFIG;
        let actualSegmentDuration: number;
        const estimatedSegmentCount = Math.ceil(totalDuration / PREFERRED_SEGMENT_DURATION);

        if (estimatedSegmentCount > MAX_SEGMENT_COUNT) {
            // 区間数が上限を超える場合、区間を長くして区間数を削減
            actualSegmentDuration = Math.ceil(totalDuration / MAX_SEGMENT_COUNT);
            videoConversionLogger.info(
                `[ファイル${fileIndex}] 区間数最適化: ` +
                `${estimatedSegmentCount}区間 → ${MAX_SEGMENT_COUNT}区間以内 ` +
                `(区間長: ${PREFERRED_SEGMENT_DURATION}秒 → ${actualSegmentDuration}秒)`
            );
        } else {
            // 上限以内なら推奨値をそのまま使用
            actualSegmentDuration = PREFERRED_SEGMENT_DURATION;
            videoConversionLogger.info(
                `[ファイル${fileIndex}] 区間設定: ` +
                `約${estimatedSegmentCount}区間、区間長: ${actualSegmentDuration}秒`
            );
        }

        // 区間を作成
        const segments: SegmentStatus[] = [];
        let currentTime = 0;
        let segmentIndex = 0;

        while (currentTime < totalDuration) {
            const endTime = Math.min(currentTime + actualSegmentDuration, totalDuration);
            segments.push({
                segmentIndex,
                startTime: currentTime,
                endTime,
                status: 'pending',
                progress: 0,
            });
            currentTime = endTime;
            segmentIndex++;
        }

        videoConversionLogger.info(
            `[ファイル${fileIndex}] 区間生成完了: ${segments.length}区間 ` +
            `(動画長: ${totalDuration}秒、区間長: ${actualSegmentDuration}秒)`
        );

        // ステータスを更新して音声変換フェーズへ
        setProcessingStatuses(prev =>
            prev.map((status, idx) =>
                idx === fileIndex
                    ? { ...status, totalDuration, segments, segmentDuration: actualSegmentDuration, phase: 'audio_conversion' }
                    : status
            )
        );

        // 共有ファイルは既にgetVideoDurationWithSharedFileで作成済みなのでスキップ
        videoConversionLogger.info(`[ファイル${fileIndex}] 共有入力ファイル再利用: ${sharedInputFileName}（書き込みスキップ）`);

        // 各区間を順次変換
        const audioSegments: Blob[] = [];
        for (let segIdx = 0; segIdx < segments.length; segIdx++) {
            const segment = segments[segIdx];

            // 区間変換開始
            setProcessingStatuses(prev =>
                prev.map((status, idx) => {
                    if (idx === fileIndex) {
                        const updatedSegments = [...status.segments];
                        updatedSegments[segIdx] = { ...updatedSegments[segIdx], status: 'converting' };
                        return { ...status, segments: updatedSegments };
                    }
                    return status;
                })
            );

            // デバッグ用: 意図的にFFmpegエラーを発生させる
            let segmentResult;
            if (debugErrorMode.ffmpegError && fileIndex === debugErrorMode.errorAtFileIndex && segIdx === debugErrorMode.errorAtSegmentIndex) {
                // 指定された区間でエラーを発生
                segmentResult = {
                    success: false,
                    segmentIndex: segIdx,
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                    error: `[デバッグ] 区間${segIdx + 1}で意図的に発生させたFFmpegエラー`
                };
            } else {
                segmentResult = await converter.convertSegmentToMp3(
                    file.file,
                    segment.startTime,
                    segment.endTime,
                    segIdx,
                    {
                        bitrate,
                        sampleRate,
                        inputFileName: sharedInputFileName, // 共有ファイルを使用
                        onProgress: (progress) => {
                            // 各セグメントの進捗を更新
                            setProcessingStatuses(prev =>
                                prev.map((status, idx) => {
                                    if (idx === fileIndex) {
                                        const updatedSegments = [...status.segments];
                                        updatedSegments[segIdx] = {
                                            ...updatedSegments[segIdx],
                                            progress: Math.round(progress.ratio * 100)
                                        };
                                        // 全体の進捗を再計算
                                        const overallProgress = calculateOverallProgress(updatedSegments);
                                        return {
                                            ...status,
                                            segments: updatedSegments,
                                            audioConversionProgress: overallProgress
                                        };
                                    }
                                    return status;
                                })
                            );
                        },
                    }
                );
            }

            if (!segmentResult.success || !segmentResult.outputBlob) {
                // 区間変換エラー
                setProcessingStatuses(prev =>
                    prev.map((status, idx) => {
                        if (idx === fileIndex) {
                            const updatedSegments = [...status.segments];
                            updatedSegments[segIdx] = {
                                ...updatedSegments[segIdx],
                                status: 'error',
                                error: segmentResult.error || '変換失敗'
                            };
                            return {
                                ...status,
                                segments: updatedSegments,
                                status: 'error',
                                error: `区間${segIdx + 1}の変換に失敗しました`,
                                failedPhase: 'audio_conversion'
                            };
                        }
                        return status;
                    })
                );
                // エラー時は共有ファイルを削除
                try {
                    await (converter as any).ffmpeg.deleteFile(sharedInputFileName);
                } catch {
                    // 削除エラーは無視
                }
                return null; // エラーが発生したら null を返す
            } else {
                // 区間変換成功
                audioSegments.push(segmentResult.outputBlob);

                setProcessingStatuses(prev =>
                    prev.map((status, idx) => {
                        if (idx === fileIndex) {
                            const updatedSegments = [...status.segments];
                            updatedSegments[segIdx] = {
                                ...updatedSegments[segIdx],
                                status: 'completed',
                                progress: 100,
                                audioBlob: segmentResult.outputBlob
                            };
                            const newCompletedIndices = [...status.completedSegmentIndices, segIdx];

                            // 全体の進捗を再計算
                            const overallProgress = calculateOverallProgress(updatedSegments);

                            return {
                                ...status,
                                segments: updatedSegments,
                                completedSegmentIndices: newCompletedIndices,
                                audioConversionProgress: overallProgress
                            };
                        }
                        return status;
                    })
                );
            }
        }

        // 共有入力ファイルを削除
        videoConversionLogger.info(`[ファイル${fileIndex}] 共有入力ファイル削除: ${sharedInputFileName}`);
        try {
            await (converter as any).ffmpeg.deleteFile(sharedInputFileName);
        } catch {
            // 削除エラーは無視
        }

        // すべての区間が完了したか確認
        const allSegmentsCompleted = audioSegments.length === segments.length;
        if (!allSegmentsCompleted) {
            return null;
        }

        // 音声結合フェーズ
        setProcessingStatuses(prev =>
            prev.map((status, idx) =>
                idx === fileIndex
                    ? { ...status, phase: 'audio_concat' }
                    : status
            )
        );

        const concatResult = await converter.concatenateAudioSegments(audioSegments);

        if (!concatResult.success || !concatResult.outputBlob) {
            setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                    idx === fileIndex
                        ? {
                            ...status,
                            status: 'error',
                            error: concatResult.error || '音声結合に失敗しました',
                            failedPhase: 'audio_conversion'
                        }
                        : status
                )
            );
            return null;
        }

        return concatResult.outputBlob;
    } catch (error) {
        videoConversionLogger.error('音声変換エラー:', error);
        // エラー時は共有ファイルを削除
        try {
            await (converter as any).ffmpeg.deleteFile(sharedInputFileName);
        } catch {
            // 削除エラーは無視
        }
        setProcessingStatuses(prev =>
            prev.map((status, idx) =>
                idx === fileIndex
                    ? {
                        ...status,
                        status: 'error',
                        error: error instanceof Error ? error.message : '不明なエラー',
                        failedPhase: 'audio_conversion'
                    }
                    : status
            )
        );
        return null;
    }
};

/**
 * 区間ベースで動画を音声に変換（再開用）
 */
export const resumeVideoConversion = async (
    file: FileWithPrompts,
    fileIndex: number,
    status: FileProcessingStatus,
    converter: VideoConverter,
    bitrate: string,
    sampleRate: number,
    debugErrorMode: DebugErrorMode,
    setProcessingStatuses: React.Dispatch<React.SetStateAction<FileProcessingStatus[]>>
): Promise<Blob | null> => {
    videoConversionLogger.info(`📦 [再開] 区間ベース処理開始`);
    videoConversionLogger.info(`  - 総区間数: ${status.segments.length}`);
    videoConversionLogger.info(`  - 完了済み区間数: ${status.completedSegmentIndices.length}`);
    videoConversionLogger.info(`  - 残り区間数: ${status.segments.length - status.completedSegmentIndices.length}`);

    // 共有入力ファイル名
    const sharedInputFileName = `shared_input_resume_${Date.now()}.${file.file.name.split('.').pop()}`;
    let sharedFileWritten = false;

    const audioSegments: Blob[] = [];

    videoConversionLogger.info('🗂️ [再開] 完了済み区間のBlob収集中...');
    // まず完了済みの区間のBlobを収集
    for (let segIdx = 0; segIdx < status.segments.length; segIdx++) {
        const segment = status.segments[segIdx];
        if (segment.status === 'completed' && segment.audioBlob) {
            audioSegments[segIdx] = segment.audioBlob;
            videoConversionLogger.info(`  ✅ 区間${segIdx + 1}は完了済み (Blobサイズ: ${segment.audioBlob.size} bytes)`);
        }
    }
    videoConversionLogger.info(`📊 [再開] 完了済みBlob収集完了: ${audioSegments.filter(Boolean).length}個`);

    try {
        videoConversionLogger.info('🔁 [再開] 未完了の区間から変換再開...');
        // 未完了の区間から再開
        for (let segIdx = 0; segIdx < status.segments.length; segIdx++) {
            const segment = status.segments[segIdx];

            // 完了済みの区間はスキップ
            if (segment.status === 'completed' && segment.audioBlob) {
                continue;
            }

            // 最初の未完了区間で共有ファイルを書き込む
            if (!sharedFileWritten) {
                videoConversionLogger.info(`[再開] 共有入力ファイル書き込み開始: ${sharedInputFileName}`);
                try {
                    const { fetchFile } = await import('@ffmpeg/util');
                    const fileData = await fetchFile(file.file);
                    await (converter as any).ffmpeg.writeFile(sharedInputFileName, fileData);
                    sharedFileWritten = true;
                    videoConversionLogger.info(`[再開] 共有入力ファイル書き込み完了`);
                } catch (writeError) {
                    const errorMessage = writeError instanceof Error ? writeError.message : '不明なエラー';
                    videoConversionLogger.error(`[再開] 共有入力ファイル書き込みエラー:`, writeError);
                    setProcessingStatuses(prev =>
                        prev.map((s, idx) =>
                            idx === fileIndex
                                ? {
                                    ...s,
                                    status: 'error',
                                    error: `ファイル書き込み失敗: ${errorMessage}`,
                                    failedPhase: 'audio_conversion',
                                    isResuming: false
                                }
                                : s
                        )
                    );
                    return null;
                }
            }

            videoConversionLogger.info(`🎬 [再開] 区間${segIdx + 1}/${status.segments.length}を変換中 (${segment.startTime}s - ${segment.endTime}s)`);

            // 区間変換開始
            setProcessingStatuses(prev =>
                prev.map((s, idx) => {
                    if (idx === fileIndex) {
                        const updatedSegments = [...s.segments];
                        updatedSegments[segIdx] = { ...updatedSegments[segIdx], status: 'converting', error: undefined };
                        return { ...s, segments: updatedSegments };
                    }
                    return s;
                })
            );

            videoConversionLogger.info(`🧪 [再開] デバッグモード確認: ffmpegError=${debugErrorMode.ffmpegError}, targetFile=${debugErrorMode.errorAtFileIndex}, targetSegment=${debugErrorMode.errorAtSegmentIndex}`);
            // デバッグ用: 意図的にFFmpegエラーを発生させる
            let segmentResult;
            if (debugErrorMode.ffmpegError && fileIndex === debugErrorMode.errorAtFileIndex && segIdx === debugErrorMode.errorAtSegmentIndex) {
                videoConversionLogger.info(`💥 [再開] デバッグエラー発生: 区間${segIdx + 1}`);
                segmentResult = {
                    success: false,
                    segmentIndex: segIdx,
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                    error: `[デバッグ] 区間${segIdx + 1}で意図的に発生させたFFmpegエラー`
                };
            } else {
                videoConversionLogger.info(`🔨 [再開] convertSegmentToMp3呼び出し: 区間${segIdx + 1}`);
                segmentResult = await converter.convertSegmentToMp3(
                    file.file,
                    segment.startTime,
                    segment.endTime,
                    segIdx,
                    {
                        bitrate,
                        sampleRate,
                        inputFileName: sharedInputFileName, // 共有ファイルを使用
                        onProgress: (progress) => {
                            // 各セグメントの進捗を更新
                            setProcessingStatuses(prev =>
                                prev.map((s, idx) => {
                                    if (idx === fileIndex) {
                                        const updatedSegments = [...s.segments];
                                        updatedSegments[segIdx] = {
                                            ...updatedSegments[segIdx],
                                            progress: Math.round(progress.ratio * 100)
                                        };
                                        // 全体の進捗を再計算
                                        const overallProgress = calculateOverallProgress(updatedSegments);
                                        return {
                                            ...s,
                                            segments: updatedSegments,
                                            audioConversionProgress: overallProgress
                                        };
                                    }
                                    return s;
                                })
                            );
                        },
                    }
                );
                videoConversionLogger.info(`✅ [再開] convertSegmentToMp3完了: 区間${segIdx + 1}, success=${segmentResult.success}`);
            }

            videoConversionLogger.info(`🔍 [再開] 変換結果チェック: success=${segmentResult.success}, hasBlob=${!!segmentResult.outputBlob}`);
            if (!segmentResult.success || !segmentResult.outputBlob) {
                videoConversionLogger.info(`❌ [再開] 区間${segIdx + 1}変換失敗 - エラーステータス設定`);
                // 区間変換エラー
                setProcessingStatuses(prev =>
                    prev.map((s, idx) => {
                        if (idx === fileIndex) {
                            const updatedSegments = [...s.segments];
                            updatedSegments[segIdx] = {
                                ...updatedSegments[segIdx],
                                status: 'error',
                                error: segmentResult.error || '変換失敗'
                            };
                            return {
                                ...s,
                                segments: updatedSegments,
                                status: 'error',
                                error: `区間${segIdx + 1}の変換に失敗しました`,
                                failedPhase: 'audio_conversion',
                                isResuming: false
                            };
                        }
                        return s;
                    })
                );
                videoConversionLogger.info(`🛑 [再開] ループ終了 - エラーのため中断`);
                return null; // エラーが発生したら null を返す
            } else {
                videoConversionLogger.info(`✅ [再開] 区間${segIdx + 1}変換成功 (Blobサイズ: ${segmentResult.outputBlob.size} bytes)`);
                // 区間変換成功
                audioSegments[segIdx] = segmentResult.outputBlob;

                setProcessingStatuses(prev =>
                    prev.map((s, idx) => {
                        if (idx === fileIndex) {
                            const updatedSegments = [...s.segments];
                            updatedSegments[segIdx] = {
                                ...updatedSegments[segIdx],
                                status: 'completed',
                                progress: 100,
                                audioBlob: segmentResult.outputBlob
                            };
                            const newCompletedIndices = [...s.completedSegmentIndices];
                            if (!newCompletedIndices.includes(segIdx)) {
                                newCompletedIndices.push(segIdx);
                            }

                            // 全体の進捗を再計算
                            const overallProgress = calculateOverallProgress(updatedSegments);

                            return {
                                ...s,
                                segments: updatedSegments,
                                completedSegmentIndices: newCompletedIndices,
                                audioConversionProgress: overallProgress
                            };
                        }
                        return s;
                    })
                );
            }
        }

        // 共有入力ファイルを削除
        if (sharedFileWritten) {
            videoConversionLogger.info(`[再開] 共有入力ファイル削除: ${sharedInputFileName}`);
            try {
                await (converter as any).ffmpeg.deleteFile(sharedInputFileName);
            } catch {
                // 削除エラーは無視
            }
        }

        videoConversionLogger.info('🏁 [再開] 区間ループ終了');
        // すべての区間が完了したか確認
        const allSegmentsCompleted = audioSegments.filter(Boolean).length === status.segments.length;
        videoConversionLogger.info(`📊 [再開] 完了確認: ${audioSegments.filter(Boolean).length}/${status.segments.length} 区間`);

        if (!allSegmentsCompleted) {
            videoConversionLogger.info(`⚠️ [再開] 未完了 - 処理中断 (完了: ${audioSegments.filter(Boolean).length}, 必要: ${status.segments.length})`);
            return null;
        }

        videoConversionLogger.info('🎉 [再開] すべての区間完了 - 音声結合フェーズへ');
        // 音声結合フェーズ
        setProcessingStatuses(prev =>
            prev.map((s, idx) =>
                idx === fileIndex
                    ? { ...s, phase: 'audio_concat' }
                    : s
            )
        );

        videoConversionLogger.info(`🔗 [再開] 音声結合開始: ${audioSegments.length}個のセグメント`);
        const concatResult = await converter.concatenateAudioSegments(audioSegments);
        videoConversionLogger.info(`✅ [再開] 音声結合完了: success=${concatResult.success}`);

        if (!concatResult.success || !concatResult.outputBlob) {
            videoConversionLogger.info(`❌ [再開] 音声結合失敗: ${concatResult.error}`);
            setProcessingStatuses(prev =>
                prev.map((s, idx) =>
                    idx === fileIndex
                        ? {
                            ...s,
                            status: 'error',
                            error: concatResult.error || '音声結合に失敗しました',
                            failedPhase: 'audio_conversion',
                            isResuming: false
                        }
                        : s
                )
            );
            return null;
        }

        videoConversionLogger.info(`🎊 [再開] 音声結合成功 (Blobサイズ: ${concatResult.outputBlob.size} bytes) - 文書生成へ`);
        return concatResult.outputBlob;
    } catch (error) {
        // エラー時は共有ファイルを削除
        if (sharedFileWritten) {
            try {
                await (converter as any).ffmpeg.deleteFile(sharedInputFileName);
            } catch {
                // 削除エラーは無視
            }
        }
        throw error;
    }
};


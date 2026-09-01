import { useCallback, useState } from 'react';
import { VideoConverter } from '@/lib/ffmpeg';
import { GeminiClient } from '@/lib/gemini';
import { FileWithPrompts, FileProcessingStatus, DebugErrorMode } from '@/types/processing';
import { convertVideoToAudioSegments, resumeVideoConversion } from '@/lib/videoConversionService';
import { getSupportedMediaKind } from '@/components/FileDropZone';
import type { JobClaim, TranscriptionJobRef } from '@/hooks/useVideoProcessing';
import { createLogger } from '@/lib/logger';

interface UseProcessingWorkflowProps {
    converterRef: React.MutableRefObject<VideoConverter | null>;
    geminiClientRef: React.MutableRefObject<GeminiClient | null>;
    audioConversionQueueRef: React.MutableRefObject<boolean>;
    ffmpegLoaded: boolean;
    setFfmpegLoaded: (loaded: boolean) => void;
    setProcessingStatuses: React.Dispatch<React.SetStateAction<FileProcessingStatus[]>>;
    processTranscription: (job: TranscriptionJobRef, audioBlob: Blob | null, bitrate: string, sampleRate: number) => Promise<void>;
    processTranscriptionResume: (job: TranscriptionJobRef, audioBlob: Blob | null, completedPromptIds: string[], bitrate: string, sampleRate: number) => Promise<void>;
    claimJob: (fileId: string) => JobClaim | null;
    markJobCanceled: (fileId: string, message: string) => void;
    countPendingSaves: (fileId: string, promptIds: readonly string[]) => number;
    debugErrorMode: DebugErrorMode;
    // 🎬 動画を直接送信するフラグ（試験的）
    sendVideoDirectly?: boolean;
}

export interface WorkflowResult {
    ok: boolean;
    message?: string;
}

/** 再開時に、どこからやり直せば整合が取れるかの判定結果 */
type ResumePlan = 'save_only' | 'transcribe' | 'convert_resume' | 'convert_full';

const processingWorkflowLogger = createLogger('useProcessingWorkflow');

const isAudioInput = (file: File) => getSupportedMediaKind(file) === 'audio';

const describeAbort = (signal: AbortSignal): string =>
    signal.reason instanceof Error ? signal.reason.message : '処理を中止しました。';

const CONVERSION_QUEUE_POLL_MS = 100;
/** 他ファイルの変換を待つ上限。長尺動画の変換を跨げる長さにしつつ、無限待ちは避ける */
export const CONVERSION_QUEUE_WAIT_LIMIT_MS = 15 * 60 * 1000;

export const useProcessingWorkflow = ({
    converterRef,
    geminiClientRef,
    audioConversionQueueRef,
    ffmpegLoaded,
    setFfmpegLoaded,
    setProcessingStatuses,
    processTranscription,
    processTranscriptionResume,
    claimJob,
    markJobCanceled,
    countPendingSaves,
    debugErrorMode,
    sendVideoDirectly = false, // 🎬 動画を直接送信するフラグ（デフォルトはfalse）
}: UseProcessingWorkflowProps) => {
    const [workflowError, setWorkflowError] = useState<string | null>(null);

    const clearWorkflowError = useCallback(() => setWorkflowError(null), []);

    const updateById = useCallback((
        fileId: string,
        updater: (status: FileProcessingStatus) => FileProcessingStatus
    ) => {
        setProcessingStatuses(prev =>
            prev.map(status => (status.fileId === fileId ? updater(status) : status))
        );
    }, [setProcessingStatuses]);

    /**
     * エンジン（GeminiClient / FFmpeg）を準備する。
     * FFmpeg は動画の音声変換が必要なときだけ読み込む。
     */
    const prepareEngines = useCallback(async (needsFfmpeg: boolean) => {
        if (!geminiClientRef.current) {
            geminiClientRef.current = new GeminiClient();
        }

        if (!needsFfmpeg) return;

        if (!converterRef.current) {
            converterRef.current = new VideoConverter();
        }
        if (!ffmpegLoaded) {
            await converterRef.current.load();
            setFfmpegLoaded(true);
        }
    }, [converterRef, ffmpegLoaded, geminiClientRef, setFfmpegLoaded]);

    // メイン処理
    const handleStartProcessing = useCallback(async (
        selectedFiles: FileWithPrompts[],
        fileIds: string[],
        bitrate: string,
        sampleRate: number
    ): Promise<WorkflowResult> => {
        setWorkflowError(null);

        if (selectedFiles.length === 0) {
            return { ok: false, message: '処理するファイルを選択してください。' };
        }

        if (fileIds.length !== selectedFiles.length) {
            const message = 'ファイルの識別に失敗しました。画面を再読み込みしてから、もう一度お試しください。';
            processingWorkflowLogger.error('ファイルIDの数が一致しません', undefined, {
                files: selectedFiles.length,
                fileIds: fileIds.length,
            });
            setWorkflowError(message);
            return { ok: false, message };
        }

        // プロンプトが選択されているか確認
        const filesWithoutPrompt = selectedFiles.filter(file => file.selectedPromptIds.length === 0);
        if (filesWithoutPrompt.length > 0) {
            const message = `すべてのファイルに最低1つのプロンプトを選択してください。（未選択: ${filesWithoutPrompt
                .map(file => file.file.name)
                .join('、')}）`;
            setWorkflowError(message);
            return { ok: false, message };
        }

        // 初期ステータスを設定
        const initialStatuses: FileProcessingStatus[] = selectedFiles.map((fileWithPrompts, index) => ({
            fileId: fileIds[index],
            fileName: fileWithPrompts.file.name,
            status: 'waiting',
            phase: 'waiting',
            audioConversionProgress: 0,
            totalTranscriptions: fileWithPrompts.selectedPromptIds.length,
            transcriptionCount: 0,
            completedPromptIds: [],
            promptStates: Object.fromEntries(
                fileWithPrompts.selectedPromptIds.map(promptId => [promptId, 'pending' as const])
            ),
            savePendingPromptIds: [],
            segmentDuration: 30,
            segments: [],
            completedSegmentIndices: [],
        }));
        setProcessingStatuses(initialStatuses);

        // H5: 開始時点で全ファイルのジョブを占有し、進行中であることを画面に伝える
        const claims = new Map<string, JobClaim>();
        for (const fileId of fileIds) {
            const claim = claimJob(fileId);
            if (claim) claims.set(fileId, claim);
        }

        if (claims.size === 0) {
            const message = '同じファイルの処理が既に実行中です。完了までお待ちください。';
            // R4: 開始できなかったので、待機中のまま残る初期ステータスを巻き戻す
            setProcessingStatuses([]);
            setWorkflowError(message);
            return { ok: false, message };
        }

        const releaseAll = () => claims.forEach(claim => claim.release());

        try {
            // H6: エンジンの初期化も失敗を捕捉できる位置に置き、
            //     音声のみの場合は FFmpeg を読み込まない
            const needsFfmpeg = !sendVideoDirectly
                && selectedFiles.some(file => !isAudioInput(file.file));

            try {
                await prepareEngines(needsFfmpeg);
            } catch (engineError) {
                const message = `処理エンジンの初期化に失敗しました: ${engineError instanceof Error ? engineError.message : '不明なエラー'}`;
                processingWorkflowLogger.error('処理エンジンの初期化に失敗', engineError, { needsFfmpeg });
                setProcessingStatuses(prev =>
                    prev.map(status => ({
                        ...status,
                        status: 'error',
                        phase: 'waiting',
                        failedPhase: 'engine_init',
                        error: message,
                    }))
                );
                setWorkflowError(message);
                return { ok: false, message };
            }

            // パイプライン処理: 音声変換（直列）→ 変換完了次第、文書生成を並列開始
            const transcriptionPromises: Promise<void>[] = [];

            for (let i = 0; i < selectedFiles.length; i++) {
                const file = selectedFiles[i];
                const fileId = fileIds[i];
                const claim = claims.get(fileId);

                // R1: 順番待ちのまま中止されたファイルを 'waiting' で放置しない。
                // 終端状態を書かないとスピナーが回り続け、再開導線も出ない
                if (!claim) {
                    markJobCanceled(fileId, 'このファイルの処理は開始できませんでした。');
                    continue;
                }
                if (claim.signal.aborted) {
                    markJobCanceled(fileId, describeAbort(claim.signal));
                    continue;
                }

                const job: TranscriptionJobRef = { file, fileIndex: i, fileId, signal: claim.signal };

                if (isAudioInput(file.file)) {
                    // 音声ファイルの場合：音声変換をスキップして直接文書生成へ
                    updateById(fileId, status => ({ ...status, convertedAudioBlob: file.file as Blob }));
                    transcriptionPromises.push(
                        processTranscription(job, file.file as Blob, bitrate, sampleRate)
                    );
                    continue;
                }

                // 🎬 動画を直接送信する場合
                if (sendVideoDirectly) {
                    processingWorkflowLogger.info('動画を直接送信モードで処理', { fileName: file.file.name });

                    updateById(fileId, status => ({
                        ...status,
                        status: 'converting',
                        phase: 'direct_video_send',
                        audioConversionProgress: 100,
                        convertedAudioBlob: file.file as Blob,
                    }));

                    transcriptionPromises.push(
                        processTranscription(job, file.file as Blob, bitrate, sampleRate)
                    );
                    continue;
                }

                // 通常の音声変換処理：区間変換が必要（直列処理）
                audioConversionQueueRef.current = true;

                try {
                    updateById(fileId, status => ({
                        ...status,
                        status: 'converting',
                        phase: 'audio_conversion',
                        audioConversionProgress: 0,
                    }));

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
                        updateById(fileId, status => ({ ...status, convertedAudioBlob: audioBlob }));

                        // R1: 変換中に中止された場合、生成を始めずに終端状態を書く
                        if (claim.signal.aborted) {
                            markJobCanceled(fileId, describeAbort(claim.signal));
                        } else {
                            transcriptionPromises.push(
                                processTranscription(job, audioBlob, bitrate, sampleRate)
                            );
                        }
                    }
                } finally {
                    // 音声変換処理完了
                    audioConversionQueueRef.current = false;
                }
            }

            // すべての文書生成が決着するまで待機（1件の失敗で他を打ち切らない）
            await Promise.allSettled(transcriptionPromises);
            return { ok: true };
        } catch (error) {
            const message = `処理中にエラーが発生しました: ${error instanceof Error ? error.message : '不明なエラー'}`;
            processingWorkflowLogger.error('一括処理でエラーが発生', error);
            setWorkflowError(message);
            return { ok: false, message };
        } finally {
            releaseAll();
        }
    }, [
        audioConversionQueueRef,
        claimJob,
        converterRef,
        debugErrorMode,
        markJobCanceled,
        prepareEngines,
        processTranscription,
        sendVideoDirectly,
        setProcessingStatuses,
        updateById,
    ]);

    /**
     * H8: 保存された checkpoint が再開に使える状態かを検証してから、やり直す地点を決める。
     * 動画解析に失敗した直後は segments が空なので、区間再開ではなく変換全体をやり直す。
     */
    const resolveResumePlan = useCallback((
        status: FileProcessingStatus,
        file: FileWithPrompts
    ): ResumePlan => {
        const remainingPromptIds = file.selectedPromptIds.filter(
            promptId => !status.completedPromptIds.includes(promptId)
        );
        // V7: 残り全てに下書きがあるときだけ保存のみで済む。
        // 一部でも未生成なら Base64 とアップロードが要るので通常経路へ落とす
        if (
            remainingPromptIds.length > 0
            && countPendingSaves(status.fileId, remainingPromptIds) === remainingPromptIds.length
        ) {
            return 'save_only';
        }

        if (status.convertedAudioBlob && status.convertedAudioBlob.size > 0) {
            return 'transcribe';
        }

        if (isAudioInput(file.file) || sendVideoDirectly) {
            return 'transcribe';
        }

        const segmentsAreConsistent =
            status.segments.length > 0
            && typeof status.totalDuration === 'number'
            && status.totalDuration > 0
            && status.segments.every(segment =>
                segment.status !== 'completed' || Boolean(segment.audioBlob)
            );

        return segmentsAreConsistent ? 'convert_resume' : 'convert_full';
    }, [countPendingSaves, sendVideoDirectly]);

    // 再開処理
    const handleResumeFile = useCallback(async (
        fileId: string,
        selectedFiles: FileWithPrompts[],
        fileIds: string[],
        processingStatuses: FileProcessingStatus[],
        bitrate: string,
        sampleRate: number
    ): Promise<WorkflowResult> => {
        setWorkflowError(null);

        const statusIndex = processingStatuses.findIndex(status => status.fileId === fileId);
        const fileIndex = fileIds.indexOf(fileId);

        // H3: ステータスとファイルの対応が崩れている状態で、別ファイルに処理を適用しない
        if (statusIndex < 0 || fileIndex < 0 || statusIndex !== fileIndex || !selectedFiles[fileIndex]) {
            const message = '再開対象のファイルを特定できませんでした。ファイルを選び直してから、もう一度お試しください。';
            processingWorkflowLogger.error('再開対象の特定に失敗', undefined, {
                fileId,
                statusIndex,
                fileIndex,
                selectedFiles: selectedFiles.length,
                processingStatuses: processingStatuses.length,
            });
            setWorkflowError(message);
            return { ok: false, message };
        }

        const file = selectedFiles[fileIndex];
        const status = processingStatuses[statusIndex];

        // H2/H5: 決着していないジョブがある間は再開を受け付けない
        const claim = claimJob(fileId);
        if (!claim) {
            const message = 'このファイルの処理はまだ実行中です。完了までお待ちください。';
            processingWorkflowLogger.warn('実行中のため再開要求をスキップ', { fileId });
            setWorkflowError(message);
            return { ok: false, message };
        }

        const job: TranscriptionJobRef = { file, fileIndex, fileId, signal: claim.signal };
        const plan = resolveResumePlan(status, file);

        processingWorkflowLogger.info('再開処理を開始', {
            fileId,
            fileIndex,
            plan,
            phase: status.phase,
            status: status.status,
            failedPhase: status.failedPhase,
            segments: status.segments.length,
            completedSegments: status.completedSegmentIndices.length,
            hasAudio: Boolean(status.convertedAudioBlob),
            completedPrompts: status.completedPromptIds.length,
            totalPrompts: status.totalTranscriptions,
        });

        updateById(fileId, current => ({
            ...current,
            isResuming: true,
            status: 'waiting',
            error: undefined,
            failedPhase: undefined,
        }));

        try {
            // H6: 再開でも、変換が必要なときだけ FFmpeg を読み込む
            const needsFfmpeg = plan === 'convert_resume' || plan === 'convert_full';

            try {
                await prepareEngines(needsFfmpeg);
            } catch (engineError) {
                const message = `処理エンジンの初期化に失敗しました: ${engineError instanceof Error ? engineError.message : '不明なエラー'}`;
                processingWorkflowLogger.error('再開時の処理エンジン初期化に失敗', engineError, { fileId });
                updateById(fileId, current => ({
                    ...current,
                    status: 'error',
                    phase: 'waiting',
                    failedPhase: 'engine_init',
                    error: message,
                }));
                setWorkflowError(message);
                return { ok: false, message };
            }

            if (plan === 'save_only' || plan === 'transcribe') {
                const audioBlob = status.convertedAudioBlob
                    ?? (isAudioInput(file.file) || sendVideoDirectly ? (file.file as Blob) : null);

                if (plan === 'transcribe' && !audioBlob) {
                    const message = '変換済みの音声が見つかりませんでした。音声変換からやり直してください。';
                    updateById(fileId, current => ({
                        ...current,
                        status: 'error',
                        failedPhase: 'audio_conversion',
                        error: message,
                    }));
                    return { ok: false, message };
                }

                if (!status.convertedAudioBlob && audioBlob) {
                    updateById(fileId, current => ({ ...current, convertedAudioBlob: audioBlob }));
                }

                await processTranscriptionResume(job, audioBlob, status.completedPromptIds, bitrate, sampleRate);
                return { ok: true };
            }

            updateById(fileId, current => ({ ...current, phase: 'waiting' }));

            let waitedMs = 0;
            while (audioConversionQueueRef.current) {
                // R1: 順番待ちの間に中止されたら終端状態を書いてから抜ける
                if (claim.signal.aborted) {
                    const message = describeAbort(claim.signal);
                    markJobCanceled(fileId, message);
                    return { ok: false, message };
                }

                // V8: キューが解放されないまま無限に待たない
                if (waitedMs >= CONVERSION_QUEUE_WAIT_LIMIT_MS) {
                    const message = '他のファイルの音声変換が終わらないため、順番待ちを打ち切りました。しばらくしてから、もう一度再開してください。';
                    processingWorkflowLogger.error('音声変換キューの待機が上限に達した', undefined, {
                        fileId,
                        waitedMs,
                    });
                    updateById(fileId, current => ({
                        ...current,
                        status: 'error',
                        phase: 'waiting',
                        failedPhase: 'audio_conversion',
                        error: message,
                    }));
                    setWorkflowError(message);
                    return { ok: false, message };
                }

                await new Promise(resolve => setTimeout(resolve, CONVERSION_QUEUE_POLL_MS));
                waitedMs += CONVERSION_QUEUE_POLL_MS;
            }
            processingWorkflowLogger.info('音声変換キューを確保', { fileId, waitedMs });

            audioConversionQueueRef.current = true;

            try {
                updateById(fileId, current => ({
                    ...current,
                    status: 'converting',
                    phase: plan === 'convert_full' ? 'video_analysis' : 'audio_conversion',
                }));

                const audioBlob = plan === 'convert_resume'
                    ? await resumeVideoConversion(
                        file,
                        fileIndex,
                        status,
                        converterRef.current!,
                        bitrate,
                        sampleRate,
                        debugErrorMode,
                        setProcessingStatuses
                    )
                    : await convertVideoToAudioSegments(
                        file,
                        fileIndex,
                        converterRef.current!,
                        bitrate,
                        sampleRate,
                        debugErrorMode,
                        setProcessingStatuses
                    );

                if (!audioBlob) {
                    // 失敗の詳細は変換サービス側がステータスへ書き込んでいる
                    return { ok: false };
                }

                updateById(fileId, current => ({ ...current, convertedAudioBlob: audioBlob }));
                await processTranscriptionResume(job, audioBlob, status.completedPromptIds, bitrate, sampleRate);
                return { ok: true };
            } finally {
                audioConversionQueueRef.current = false;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : '不明なエラー';
            processingWorkflowLogger.error('再開処理でエラーが発生', error, { fileId });
            updateById(fileId, current => ({
                ...current,
                status: 'error',
                error: message,
            }));
            return { ok: false, message };
        } finally {
            claim.release();
            updateById(fileId, current => (current.isResuming ? { ...current, isResuming: false } : current));
        }
    }, [
        audioConversionQueueRef,
        claimJob,
        converterRef,
        debugErrorMode,
        markJobCanceled,
        prepareEngines,
        processTranscriptionResume,
        resolveResumePlan,
        sendVideoDirectly,
        setProcessingStatuses,
        updateById,
    ]);

    return {
        handleStartProcessing,
        handleResumeFile,
        workflowError,
        clearWorkflowError,
        reportWorkflowError: setWorkflowError,
    };
};

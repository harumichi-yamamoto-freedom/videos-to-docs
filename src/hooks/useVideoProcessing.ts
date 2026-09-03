import { useCallback, useEffect, useRef, useState } from 'react';
import { VideoConverter } from '@/lib/ffmpeg';
import { GeminiClient } from '@/lib/gemini';
import { saveTranscription } from '@/lib/firestore';
import { uploadAudioToStorage } from '@/lib/storage';
import {
    FileProcessingStatus,
    FileWithPrompts,
    DebugErrorMode,
    ProcessingFailedPhase,
    ProcessingPhase,
    PromptJobState,
} from '@/types/processing';
import { Prompt } from '@/lib/prompts';
import { isTranscriptPrompt } from '@/lib/transcriptPrompt';
import { runTranscriptPipeline } from '@/hooks/transcriptPipelineAdapter';
import { validatePromptPermission } from '@/lib/promptPermissions';
import { getCurrentUserId } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import {
    canonicalizeGeminiModel,
    GEMINI_DEFAULT_MODEL_SENTINEL,
} from '@/constants/geminiModels';

const videoProcessingLogger = createLogger('useVideoProcessing');

/** 中止要求を出してからジョブの決着を待つ上限。超えたら利用者に強制破棄を選ばせる */
export const JOB_SETTLE_TIMEOUT_MS = 30_000;

/** 中止（認証変更・リセット・アンマウント・利用者操作）で終了したジョブを表す */
export class ProcessingAbortedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProcessingAbortedError';
    }
}

/** どのフェーズで失敗したかを保持したまま伝播させるためのエラー */
class PromptPhaseError extends Error {
    constructor(readonly failedPhase: ProcessingFailedPhase, message: string) {
        super(message);
        this.name = 'PromptPhaseError';
    }
}

interface GeneratedDraft {
    text: string;
    usedModel?: string;
    usedThinkingLevel?: string;
    audioStoragePath?: string;
    originalFileType: 'video' | 'audio';
    bitrate: string;
    sampleRate: number;
}

/**
 * #4: サーバへ渡す「元ファイルの種別」。生成に使う Blob の種別が正 (変換済みなら audio/mpeg、
 * 動画直送なら video/*)。Blob に種別が無いときだけ元ファイルの区分から補う。
 */
export const resolveMediaMimeType = (
    blobType: string,
    originalFileType: 'video' | 'audio',
): string => blobType || (originalFileType === 'video' ? 'video/mp4' : 'audio/mpeg');

export interface JobClaim {
    signal: AbortSignal;
    release: () => void;
}

export interface TranscriptionJobRef {
    file: FileWithPrompts;
    fileIndex: number;
    fileId: string;
    /** 呼び出し側が既に claimJob 済みの場合に渡す。未指定なら内部で占有を取る */
    signal?: AbortSignal;
}

const describeError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return '不明なエラー';
};

const FAILED_PHASE_TO_PHASE: Record<ProcessingFailedPhase, ProcessingPhase> = {
    engine_init: 'waiting',
    audio_conversion: 'audio_conversion',
    upload: 'uploading',
    text_generation: 'text_generation',
    saving: 'saving',
};

/**
 * R10: プロンプト単位の状態がフェーズを決めるのは生成中と保存中だけ。
 * それ以外は uploading や audio_conversion など現在のフェーズをそのまま残す。
 */
export const derivePhase = (
    promptStates: Record<string, PromptJobState>,
    currentPhase: ProcessingPhase
): ProcessingPhase => {
    const states = Object.values(promptStates);
    if (states.some(state => state === 'generating')) return 'text_generation';
    if (states.some(state => state === 'saving')) return 'saving';
    return currentPhase;
};

/**
 * U1: 「保存待ち」はプロンプト状態と下書きの有無から決まる派生値。
 * promptStates を書く経路ごとに手で足し引きすると、中止経路のように必ずどこかが漏れる。
 */
export const resolveSavePendingPromptIds = (
    promptStates: Record<string, PromptJobState>,
    hasDraft: (promptId: string) => boolean
): string[] =>
    Object.entries(promptStates)
        .filter(([promptId, state]) =>
            // 保存中は当然として、下書きが手元にある限りどの状態でも「保存待ち」。
            // pending を外すと、保存のみ再試行の開始時に破棄確認が消える
            state === 'saving' || (state !== 'saved' && hasDraft(promptId))
        )
        .map(([promptId]) => promptId);

/** 中止時のプロンプト状態。確定済み（保存済み・失敗）はそのまま残す */
export const cancelPromptStates = (
    promptStates: Record<string, PromptJobState>
): Record<string, PromptJobState> =>
    Object.fromEntries(
        Object.entries(promptStates).map(([promptId, state]) => [
            promptId,
            state === 'saved' || state === 'failed' ? state : 'canceled',
        ])
    );

/** V1: 生成済みで未保存の下書き件数。破棄で失われる課金済み資産の量にあたる */
export const countPendingSaveDrafts = (statuses: readonly FileProcessingStatus[]): number =>
    statuses.reduce((total, status) => total + (status.savePendingPromptIds?.length ?? 0), 0);

/**
 * V1: 破棄前に確認を挟むかどうか。実行中のジョブだけでなく、
 * 生成済みで未保存の下書き（再生成に費用がかかる）も失われる資産として数える。
 */
export const needsDiscardConfirmation = (
    activeJobCount: number,
    pendingSaveCount: number
): boolean => activeJobCount > 0 || pendingSaveCount > 0;

/**
 * R3: 完了判定の唯一の入口。保存済みIDを必ず計画集合と交差させてから数えるので、
 * 計画外のID（削除済みプロンプトの completedPromptIds など）が分母を超えることはない。
 */
export const evaluateCompletion = (
    plannedPromptIds: readonly string[],
    savedPromptIds: Iterable<string>
): { savedCount: number; plannedCount: number; isComplete: boolean } => {
    const planned = new Set(plannedPromptIds);
    const saved = new Set<string>();
    for (const promptId of savedPromptIds) {
        if (planned.has(promptId)) saved.add(promptId);
    }

    return {
        savedCount: saved.size,
        plannedCount: planned.size,
        isComplete: planned.size > 0 && saved.size === planned.size,
    };
};

export const useVideoProcessing = (
    availablePrompts: Prompt[],
    debugErrorMode: DebugErrorMode,
    onDocumentSaved?: () => void
) => {
    const [processingStatuses, setProcessingStatuses] = useState<FileProcessingStatus[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
    const [activeJobIds, setActiveJobIds] = useState<string[]>([]);
    const [isCanceling, setIsCanceling] = useState(false);
    const converterRef = useRef<VideoConverter | null>(null);
    const geminiClientRef = useRef<GeminiClient | null>(null);
    const audioConversionQueueRef = useRef<boolean>(false);
    const jobControllersRef = useRef<Map<string, AbortController>>(new Map());
    // 占有が空になるのを待っている解決関数（リセットが実行中ジョブの決着を待つために使う）
    const idleWaitersRef = useRef<Array<() => void>>([]);
    // 保存が完了した (fileId, promptId) の冪等キー。再開しても二重保存・二重課金しない
    const savedKeysRef = useRef<Set<string>>(new Set());
    // 生成済みで保存だけが残っている下書き。保存のみの再試行に使う
    const draftsRef = useRef<Map<string, GeneratedDraft>>(new Map());

    const updateStatus = useCallback((
        fileId: string,
        updater: (status: FileProcessingStatus) => FileProcessingStatus
    ) => {
        setProcessingStatuses(prev =>
            prev.map(status => (status.fileId === fileId ? updater(status) : status))
        );
    }, []);

    /**
     * U1: promptStates を書き換える経路は必ずここを通す。
     * savePendingPromptIds を手で足し引きすると、中止経路のようにどこかで漏れる。
     */
    const withPromptStates = useCallback((
        status: FileProcessingStatus,
        promptStates: Record<string, PromptJobState>
    ): FileProcessingStatus => ({
        ...status,
        promptStates,
        savePendingPromptIds: resolveSavePendingPromptIds(
            promptStates,
            promptId => draftsRef.current.has(`${status.fileId}::${promptId}`)
        ),
        phase: derivePhase(promptStates, status.phase),
    }), []);

    const claimJob = useCallback((fileId: string): JobClaim | null => {
        if (jobControllersRef.current.has(fileId)) return null;

        const controller = new AbortController();
        jobControllersRef.current.set(fileId, controller);
        setActiveJobIds(prev => (prev.includes(fileId) ? prev : [...prev, fileId]));

        return {
            signal: controller.signal,
            release: () => {
                if (jobControllersRef.current.get(fileId) !== controller) return;
                jobControllersRef.current.delete(fileId);
                setActiveJobIds(prev => prev.filter(id => id !== fileId));

                if (jobControllersRef.current.size === 0) {
                    idleWaitersRef.current.splice(0).forEach(resolve => resolve());
                }
            },
        };
    }, []);

    const cancelJob = useCallback((fileId: string, reason = 'ユーザー操作により中止されました。') => {
        jobControllersRef.current.get(fileId)?.abort(new ProcessingAbortedError(reason));
    }, []);

    /**
     * R2: 中止は「要求」でしかない。videoConversionService は signal を見ないため、
     * 実際に走っている変換は自分のタイミングでしか止まらない。
     * よって占有は解放せず、各ジョブが自分で release するのを待つ。
     */
    const abortAllJobs = useCallback((reason: string) => {
        jobControllersRef.current.forEach(controller =>
            controller.abort(new ProcessingAbortedError(reason))
        );
    }, []);

    /**
     * V2: 占有中のジョブが全て決着するまで待つ。文書生成 API の fetch は signal で切れるが、
     * ffmpeg・Storage は signal を見ないので、待ちが返らないことがある。上限を超えたら false を返す。
     */
    const waitForJobsToSettle = useCallback((
        timeoutMs: number = JOB_SETTLE_TIMEOUT_MS
    ): Promise<boolean> => {
        if (jobControllersRef.current.size === 0) return Promise.resolve(true);

        return new Promise<boolean>(resolve => {
            let waiter: () => void;
            const timer = setTimeout(() => {
                idleWaitersRef.current = idleWaitersRef.current.filter(entry => entry !== waiter);
                resolve(false);
            }, timeoutMs);

            waiter = () => {
                clearTimeout(timer);
                resolve(true);
            };
            idleWaitersRef.current.push(waiter);
        });
    }, []);

    const clearProcessingState = useCallback(() => {
        savedKeysRef.current.clear();
        draftsRef.current.clear();
        setProcessingStatuses([]);
        setIsProcessing(false);
        setIsCanceling(false);
    }, []);

    /**
     * R2: 中止を要求し、実行中の変換・生成が全て終わってから状態を落とす。
     * 先に isProcessing を落とすと、ffmpeg が走ったまま開始ボタンが復活して二重走行する。
     * V2: 期限内に止まらなければ状態を残したまま 'timeout' を返し、判断を呼び出し側へ返す。
     */
    const resetProcessing = useCallback(async (
        reason: string,
        timeoutMs: number = JOB_SETTLE_TIMEOUT_MS
    ): Promise<'settled' | 'timeout'> => {
        abortAllJobs(reason);
        setIsCanceling(jobControllersRef.current.size > 0);

        const settled = await waitForJobsToSettle(timeoutMs);
        if (!settled) {
            setIsCanceling(false);
            return 'timeout';
        }

        clearProcessingState();
        return 'settled';
    }, [abortAllJobs, clearProcessingState, waitForJobsToSettle]);

    /**
     * V2: 止まらないジョブを見限って画面だけ解放する。
     * 下層の変換は走り続けるため、利用者が明示的に選んだときだけ呼ぶ。
     */
    const forceDiscardProcessing = useCallback(() => {
        jobControllersRef.current.clear();
        setActiveJobIds([]);
        idleWaitersRef.current.splice(0).forEach(resolve => resolve());
        clearProcessingState();
    }, [clearProcessingState]);

    /** 待機中のまま中止されたファイルなど、ジョブ本体を通らない経路から終端状態を書く */
    const markJobCanceled = useCallback((fileId: string, message: string) => {
        updateStatus(fileId, status => (
            status.status === 'completed' || status.status === 'error'
                ? status
                : {
                    ...withPromptStates(status, cancelPromptStates(status.promptStates)),
                    status: 'canceled',
                    phase: 'canceled',
                    error: message,
                    isResuming: false,
                }
        ));
    }, [updateStatus, withPromptStates]);

    useEffect(() => {
        const controllers = jobControllersRef.current;
        return () => {
            // 占有は各ジョブ自身が解放する。ここでは中止を要求するだけ
            controllers.forEach(controller =>
                controller.abort(new ProcessingAbortedError('画面を離れたため処理を中止しました。'))
            );
        };
    }, []);

    const markPromptState = useCallback((
        fileId: string,
        promptId: string,
        state: PromptJobState
    ) => {
        updateStatus(fileId, status =>
            withPromptStates(status, { ...status.promptStates, [promptId]: state })
        );
    }, [updateStatus, withPromptStates]);

    const runTranscriptionJob = useCallback(async (
        job: TranscriptionJobRef,
        audioBlob: Blob | null,
        bitrate: string,
        sampleRate: number,
        alreadyCompletedPromptIds: string[]
    ) => {
        const { file, fileIndex, fileId } = job;

        let claim: JobClaim;
        if (job.signal) {
            claim = { signal: job.signal, release: () => { } };
        } else {
            // H2: 同じファイルのジョブが決着するまで、新しい開始要求は受け付けない
            const claimed = claimJob(fileId);
            if (!claimed) {
                videoProcessingLogger.warn('同じファイルの処理が実行中のため開始要求を無視', {
                    fileId,
                    fileIndex,
                });
                return;
            }
            claim = claimed;
        }

        const { signal } = claim;
        // H1: 開始時のUIDを固定し、保存直前に現在のUIDと照合する
        const ownerUid = getCurrentUserId();

        const throwIfAborted = () => {
            if (signal.aborted) {
                throw signal.reason instanceof ProcessingAbortedError
                    ? signal.reason
                    : new ProcessingAbortedError('処理が中止されました。');
            }
        };

        const savedPromptIds = [...alreadyCompletedPromptIds];
        const failures: string[] = [];
        let failedPhase: ProcessingFailedPhase = 'text_generation';

        const failJob = (phase: ProcessingFailedPhase, messages: string[]) => {
            updateStatus(fileId, status => ({
                ...status,
                status: 'error',
                phase: FAILED_PHASE_TO_PHASE[phase],
                failedPhase: phase,
                error: messages.join('\n'),
            }));
        };

        const cancelStatus = (message: string) => {
            updateStatus(fileId, status => ({
                ...withPromptStates(status, cancelPromptStates(status.promptStates)),
                status: 'canceled',
                phase: 'canceled',
                error: message,
            }));
        };

        try {
            throwIfAborted();

            // デバッグ用: 意図的にGeminiエラーを発生させる
            if (debugErrorMode.geminiError && fileIndex === debugErrorMode.errorAtFileIndex) {
                throw new PromptPhaseError('text_generation', '[デバッグ] 意図的に発生させたGemini APIエラー');
            }

            const plannedPromptIds = file.selectedPromptIds;
            const selectedPrompts = availablePrompts.filter(prompt =>
                prompt.id ? plannedPromptIds.includes(prompt.id) : false
            );

            // H4: 生成対象が0件のまま「完了」にしない
            if (plannedPromptIds.length === 0) {
                failJob('text_generation', ['生成対象のプロンプトが選択されていません。']);
                return;
            }

            const missingPromptIds = plannedPromptIds.filter(
                promptId => !selectedPrompts.some(prompt => prompt.id === promptId)
            );
            if (missingPromptIds.length > 0) {
                failJob('text_generation', [
                    `選択されていたプロンプトが見つかりません（${missingPromptIds.length}件）。プロンプト一覧を再読み込みしてから、選択し直してください。`,
                ]);
                return;
            }

            // H2: 既に保存済みの (ファイル, プロンプト) は再開しても再生成・再保存しない
            const isAlreadySaved = (promptId: string) =>
                alreadyCompletedPromptIds.includes(promptId)
                || savedKeysRef.current.has(`${fileId}::${promptId}`);

            plannedPromptIds.forEach(promptId => {
                if (isAlreadySaved(promptId) && !savedPromptIds.includes(promptId)) {
                    savedPromptIds.push(promptId);
                }
            });

            const remainingPrompts = selectedPrompts.filter(prompt => !isAlreadySaved(prompt.id!));
            // 表示の分母も完了判定と同じ集合から取る
            const { plannedCount: plannedTotal } = evaluateCompletion(plannedPromptIds, []);

            if (remainingPrompts.length === 0) {
                // H4/R3: 完了判定は evaluateCompletion だけが決める
                const { savedCount, plannedCount, isComplete } =
                    evaluateCompletion(plannedPromptIds, savedPromptIds);

                if (isComplete) {
                    updateStatus(fileId, status => ({
                        ...status,
                        status: 'completed',
                        phase: 'completed',
                        error: undefined,
                        failedPhase: undefined,
                        transcriptionCount: savedCount,
                        totalTranscriptions: plannedCount,
                    }));
                } else {
                    failJob('text_generation', [
                        `保存できた文書は ${savedCount}/${plannedCount} 件です。未処理のプロンプトが残っているため完了にできません。`,
                    ]);
                }
                return;
            }

            for (const prompt of remainingPrompts) {
                try {
                    validatePromptPermission(prompt);
                } catch (permissionError) {
                    videoProcessingLogger.error('プロンプト利用権限チェックに失敗', permissionError, {
                        promptId: prompt.id,
                    });
                    failJob('text_generation', [describeError(permissionError)]);
                    return;
                }
            }

            videoProcessingLogger.info('文書生成を開始', {
                fileName: file.file.name,
                fileId,
                fileIndex,
                promptCount: remainingPrompts.length,
                promptNames: remainingPrompts.map(prompt => prompt.name),
                blobMimeType: audioBlob?.type,
                blobSizeInMB: audioBlob ? (audioBlob.size / 1024 / 1024).toFixed(2) : undefined,
            });

            const originalFileType = file.file.type.startsWith('video/') ? 'video' as const : 'audio' as const;
            // H7: 生成済みの下書きしか残っていないなら、アップロードをやり直さず保存だけ再試行する
            const needsGeneration = remainingPrompts.some(
                prompt => !draftsRef.current.has(`${fileId}::${prompt.id}`)
            );

            updateStatus(fileId, status => ({
                ...withPromptStates(status, {
                    ...status.promptStates,
                    ...Object.fromEntries(
                        remainingPrompts.map(prompt => [prompt.id!, 'pending' as PromptJobState])
                    ),
                }),
                status: 'transcribing',
                phase: needsGeneration ? 'uploading' : 'saving',
                error: undefined,
                failedPhase: undefined,
                ownerUid,
                totalTranscriptions: plannedTotal,
            }));

            // #4: サーバは Storage 上のパスから読むので、生成に入る前にアップロードを完了させる。
            // 1 ファイルにつき 1 回だけ上げ、全プロンプトで同じパスを渡す
            let uploadedMedia: { storagePath: string; mimeType: string } | null = null;

            if (needsGeneration) {
                if (!audioBlob) {
                    failJob('upload', ['変換済みの音声データが見つかりませんでした。音声変換からやり直してください。']);
                    return;
                }

                const mimeType = resolveMediaMimeType(audioBlob.type, originalFileType);
                videoProcessingLogger.info('Storage へのアップロードを開始', {
                    fileId,
                    fileIndex,
                    mimeType,
                    blobSizeBytes: audioBlob.size,
                    bitrate,
                });

                let storagePath: string | null;
                try {
                    storagePath = await uploadAudioToStorage(audioBlob, file.file.name, {
                        originalFileName: file.file.name,
                        originalFileType,
                        bitrate,
                        sampleRate: String(sampleRate),
                    });
                } catch (uploadError) {
                    throwIfAborted();
                    const reason = `Storageアップロード: ${describeError(uploadError)}`;
                    videoProcessingLogger.error('文書生成の準備に失敗', uploadError, { fileId, fileIndex, reason });
                    failJob('upload', [reason]);
                    return;
                }

                throwIfAborted();

                // 以前の「失敗しても null で続行」の名残 (古い実装や test double) を黙って通さない
                if (!storagePath) {
                    failJob('upload', ['Storageアップロード: 保存先のパスが得られませんでした。もう一度お試しください。']);
                    return;
                }

                uploadedMedia = { storagePath, mimeType };
                updateStatus(fileId, status => ({ ...status, phase: 'text_generation' }));
            }

            const runPrompt = async (prompt: Prompt) => {
                const promptId = prompt.id!;
                const idempotencyKey = `${fileId}::${promptId}`;
                let draft = draftsRef.current.get(idempotencyKey);

                if (!draft) {
                    throwIfAborted();
                    const media = uploadedMedia;
                    if (!media) {
                        throw new PromptPhaseError(
                            'upload',
                            '送信用の音声/動画データが準備されていません。音声変換からやり直してください。'
                        );
                    }
                    markPromptState(fileId, promptId, 'generating');

                    // 🔴 全文文字起こしだけは分割パイプラインへ流す (設計 §3)。
                    //    ここで分けると、**下流の下書き・保存・冪等・中断はすべて既存のまま効く**。
                    //    戻り値を TranscriptionResult に揃えてあるので、以降の処理は分岐を知らない。
                    //    中止は fetch に渡して切る。サーバ側の処理は継続し得る (仕様として許容)
                    const transcriptionResult = isTranscriptPrompt(prompt)
                        ? await runTranscriptPipeline({
                            file: file.file,
                            converter: converterRef.current,
                            signal,
                        })
                        : await geminiClientRef.current!.generateDocument({
                            storagePath: media.storagePath,
                            fileName: file.file.name,
                            mimeType: media.mimeType,
                            prompt: {
                                name: prompt.name,
                                content: prompt.content,
                                model: prompt.model,
                                thinkingLevel: prompt.thinkingLevel,
                            },
                            signal,
                        });

                    videoProcessingLogger.info('文書生成 API の応答', {
                        fileId,
                        fileIndex,
                        promptId,
                        success: transcriptionResult.success,
                        transport: transcriptionResult.transport,
                        usedModel: transcriptionResult.usedModel,
                        elapsedMs: transcriptionResult.elapsedMs,
                    });

                    if (!transcriptionResult.success) {
                        throw new PromptPhaseError(
                            'text_generation',
                            transcriptionResult.error || 'Gemini API処理失敗'
                        );
                    }

                    // H4: 空文字の生成結果を成功として保存しない
                    const generatedText = transcriptionResult.text?.trim() ?? '';
                    if (generatedText.length === 0) {
                        throw new PromptPhaseError(
                            'text_generation',
                            '生成結果が空でした。プロンプトまたは入力ファイルを確認してください。'
                        );
                    }

                    draft = {
                        text: generatedText,
                        usedModel: transcriptionResult.usedModel,
                        usedThinkingLevel: transcriptionResult.usedThinkingLevel,
                        audioStoragePath: media.storagePath,
                        originalFileType,
                        bitrate,
                        sampleRate,
                    };
                    // H7: 生成結果を先に確保しておき、保存だけの再試行を可能にする
                    draftsRef.current.set(idempotencyKey, draft);
                }

                throwIfAborted();

                // H1: 保存直前に所有者を照合し、別ユーザー/GUEST帰属での保存を防ぐ
                const currentUid = getCurrentUserId();
                if (currentUid !== ownerUid) {
                    const ownershipError = new ProcessingAbortedError(
                        '処理中に認証状態が変わったため、保存を中止しました。ログイン状態を確認してから、もう一度お試しください。'
                    );
                    jobControllersRef.current.get(fileId)?.abort(ownershipError);
                    throw ownershipError;
                }

                markPromptState(fileId, promptId, 'saving');

                try {
                    await saveTranscription(
                        file.file.name,
                        draft.text,
                        prompt.name,
                        draft.originalFileType,
                        draft.bitrate,
                        draft.sampleRate,
                        undefined,
                        draft.audioStoragePath,
                        draft.usedModel,
                        canonicalizeGeminiModel(prompt.model) === GEMINI_DEFAULT_MODEL_SENTINEL
                            ? 'default'
                            : 'pinned',
                        draft.usedThinkingLevel,
                        // R7: 実際に書き込まれる所有者UIDを保存側でも照合させる
                        ownerUid,
                    );
                } catch (saveError) {
                    throw new PromptPhaseError('saving', describeError(saveError));
                }

                savedKeysRef.current.add(idempotencyKey);
                draftsRef.current.delete(idempotencyKey);
                savedPromptIds.push(promptId);

                updateStatus(fileId, status => ({
                    ...withPromptStates(status, { ...status.promptStates, [promptId]: 'saved' }),
                    transcriptionCount: status.transcriptionCount + 1,
                    completedPromptIds: status.completedPromptIds.includes(promptId)
                        ? status.completedPromptIds
                        : [...status.completedPromptIds, promptId],
                }));

                onDocumentSaved?.();
            };

            // H2: 兄弟プロンプトが全て決着するまで待ってから、まとめて結果を判定する
            const settled = await Promise.allSettled(
                remainingPrompts.map(prompt => runPrompt(prompt))
            );

            let aborted = false;
            settled.forEach((result, index) => {
                if (result.status === 'fulfilled') return;

                const prompt = remainingPrompts[index];
                const reason = result.reason;

                if (reason instanceof ProcessingAbortedError) {
                    aborted = true;
                    return;
                }

                if (reason instanceof PromptPhaseError && reason.failedPhase === 'saving') {
                    failedPhase = 'saving';
                }
                failures.push(`プロンプト「${prompt.name}」: ${describeError(reason)}`);
                markPromptState(fileId, prompt.id!, 'failed');
                videoProcessingLogger.error(`プロンプト「${prompt.name}」の処理に失敗`, reason, {
                    fileId,
                    fileIndex,
                    promptId: prompt.id,
                });
            });

            if (aborted && failures.length === 0) {
                cancelStatus(
                    signal.reason instanceof ProcessingAbortedError
                        ? signal.reason.message
                        : '処理を中止しました。'
                );
                return;
            }

            // H4/R3: 完了判定は evaluateCompletion だけが決める
            const { savedCount, plannedCount, isComplete } =
                evaluateCompletion(plannedPromptIds, savedPromptIds);

            if (failures.length === 0 && isComplete) {
                updateStatus(fileId, status => ({
                    ...status,
                    status: 'completed',
                    phase: 'completed',
                    error: undefined,
                    failedPhase: undefined,
                    transcriptionCount: savedCount,
                    totalTranscriptions: plannedCount,
                }));
                return;
            }

            if (failures.length === 0) {
                failures.push(
                    `保存できた文書は ${savedCount}/${plannedCount} 件です。未保存のプロンプトが残っています。`
                );
            }

            failJob(failedPhase, failures);
        } catch (error) {
            if (error instanceof ProcessingAbortedError) {
                videoProcessingLogger.info('文書生成を中止', { fileId, fileIndex, reason: error.message });
                cancelStatus(error.message);
                return;
            }

            videoProcessingLogger.error(`ファイル ${file.file.name} の文書生成に失敗`, error, {
                fileId,
                fileIndex,
            });
            failJob(
                error instanceof PromptPhaseError ? error.failedPhase : 'text_generation',
                [describeError(error)]
            );
        } finally {
            claim.release();
        }
    }, [availablePrompts, claimJob, debugErrorMode, markPromptState, onDocumentSaved, updateStatus, withPromptStates]);

    const processTranscription = useCallback((
        job: TranscriptionJobRef,
        audioBlob: Blob | null,
        bitrate: string,
        sampleRate: number
    ) => runTranscriptionJob(job, audioBlob, bitrate, sampleRate, []),
        [runTranscriptionJob]);

    const processTranscriptionResume = useCallback((
        job: TranscriptionJobRef,
        audioBlob: Blob | null,
        completedPromptIds: string[],
        bitrate: string,
        sampleRate: number
    ) => runTranscriptionJob(job, audioBlob, bitrate, sampleRate, completedPromptIds),
        [runTranscriptionJob]);

    /**
     * 生成済みで保存だけが残っているプロンプトの数。
     * V7: 「1件でもあるか」では混在集合を save_only と誤判定するため件数で返す。
     */
    const countPendingSaves = useCallback((fileId: string, promptIds: readonly string[]) =>
        promptIds.filter(promptId => draftsRef.current.has(`${fileId}::${promptId}`)).length,
        []);

    const pendingSaveCount = countPendingSaveDrafts(processingStatuses);

    /** そのファイルだけで失われる、生成済み未保存の下書き件数 */
    const pendingSavesForFile = useCallback((fileId: string) =>
        countPendingSaveDrafts(processingStatuses.filter(status => status.fileId === fileId)),
        [processingStatuses]);

    /** G3: 個別削除も一括破棄と同じ基準で確認を挟む */
    const needsRemovalConfirm = useCallback((fileId: string) =>
        needsDiscardConfirmation(0, pendingSavesForFile(fileId)),
        [pendingSavesForFile]);

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
        activeJobIds,
        hasActiveJobs: activeJobIds.length > 0,
        pendingSaveCount,
        needsDiscardConfirm: needsDiscardConfirmation(activeJobIds.length, pendingSaveCount),
        pendingSavesForFile,
        needsRemovalConfirm,
        isCanceling,
        claimJob,
        cancelJob,
        markJobCanceled,
        abortAllJobs,
        waitForJobsToSettle,
        resetProcessing,
        forceDiscardProcessing,
        countPendingSaves,
        updateStatus,
    };
};

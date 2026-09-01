'use client';

import React from 'react';
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react';
import {
    FileProcessingStatus,
    ProcessingFailedPhase,
    ProcessingPhase,
} from '@/types/processing';

interface ProcessingStatusListProps {
    statuses: FileProcessingStatus[];
    onResumeFile: (fileId: string) => void;
    onCancelFile?: (fileId: string) => void;
    /** 実際にジョブを占有しているファイル。これ以外に中止ボタンを出しても何も起きない */
    activeFileIds?: readonly string[];
}

const PHASE_LABELS: Record<ProcessingPhase, string> = {
    waiting: '待機中です',
    video_analysis: '動画情報を解析しています',
    audio_conversion: '音声に変換しています',
    audio_concat: '音声ファイルを結合しています',
    direct_video_send: '動画を直接送信しています',
    uploading: '音声データをアップロードしています',
    text_generation: '文書を生成しています',
    saving: '文書を保存しています',
    completed: '完了しました',
    canceled: '中止しました',
};

const FAILED_PHASE_LABELS: Record<ProcessingFailedPhase, string> = {
    engine_init: '処理エンジンの初期化',
    audio_conversion: '音声変換',
    upload: 'アップロード',
    text_generation: '文書生成',
    saving: '文書の保存',
};

export const ProcessingStatusList: React.FC<ProcessingStatusListProps> = ({
    statuses,
    onResumeFile,
    onCancelFile,
    activeFileIds = [],
}) => {
    if (statuses.length === 0) {
        return null;
    }

    const completedCount = statuses.filter(status => status.status === 'completed').length;

    return (
        <section className="rounded-xl bg-white p-6 shadow-lg" aria-labelledby="processing-status-heading">
            <h2 id="processing-status-heading" className="mb-4 text-lg font-medium text-gray-900">
                処理進捗 ({completedCount} / {statuses.length})
            </h2>
            <ul className="space-y-3">
                {statuses.map(status => {
                    // H9: 終了状態を最優先で描画し、失敗後にスピナーが回り続けないようにする
                    const isTerminal = status.status === 'completed'
                        || status.status === 'error'
                        || status.status === 'canceled';
                    const savePendingCount = status.savePendingPromptIds?.length ?? 0;

                    return (
                        <li key={status.fileId} className="rounded-lg border bg-white p-4 shadow-sm">
                            <p className="mb-3 truncate text-sm font-medium text-gray-900">
                                {status.fileName}
                            </p>

                            {status.status === 'completed' && (
                                <p className="flex items-center gap-2 text-sm font-medium text-green-800" role="status">
                                    <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
                                    完了しました（{status.transcriptionCount}/{status.totalTranscriptions} 件の文書を保存しました）
                                </p>
                            )}

                            {status.status === 'canceled' && (
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1" role="status">
                                        <p className="flex items-center gap-2 text-sm font-medium text-gray-700">
                                            <XCircle className="h-5 w-5 shrink-0 text-gray-500" aria-hidden="true" />
                                            処理を中止しました
                                        </p>
                                        {status.error && (
                                            <p className="mt-1 text-[13px] text-gray-600">{status.error}</p>
                                        )}
                                        {status.completedPromptIds.length > 0 && (
                                            <p className="mt-1 text-[13px] text-green-700">
                                                保存済み: {status.completedPromptIds.length}/{status.totalTranscriptions} プロンプト
                                            </p>
                                        )}
                                        {savePendingCount > 0 && (
                                            <p className="mt-1 text-[13px] text-blue-700">
                                                生成済みで保存待ち: {savePendingCount} 件（再開すると保存からやり直します）
                                            </p>
                                        )}
                                    </div>
                                    {/* R6: 中止しても生成済みの下書きを回収できるよう再開導線を残す */}
                                    <button
                                        type="button"
                                        onClick={() => onResumeFile(status.fileId)}
                                        disabled={status.isResuming}
                                        className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-orange-600 px-4 text-sm font-medium text-white transition-colors hover:bg-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                                        {status.isResuming ? '再開しています...' : '再開する'}
                                    </button>
                                </div>
                            )}

                            {status.status === 'error' && (
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1" role="alert">
                                        <p className="mb-1 flex items-center gap-2 text-sm font-medium text-red-800">
                                            <AlertCircle className="h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
                                            エラーが発生しました
                                            {status.failedPhase && `（${FAILED_PHASE_LABELS[status.failedPhase]}）`}
                                        </p>
                                        {status.error && (
                                            <p className="mb-1 whitespace-pre-line text-[13px] text-red-700">
                                                {status.error}
                                            </p>
                                        )}
                                        {status.completedSegmentIndices.length > 0 && (
                                            <p className="mb-1 text-[13px] text-green-700">
                                                完了した区間: {status.completedSegmentIndices.length}/{status.segments.length}（{status.audioConversionProgress}%）
                                            </p>
                                        )}
                                        {status.completedPromptIds.length > 0 && (
                                            <p className="mb-1 text-[13px] text-green-700">
                                                保存済み: {status.completedPromptIds.length}/{status.totalTranscriptions} プロンプト
                                            </p>
                                        )}
                                        {savePendingCount > 0 && (
                                            <p className="mb-1 text-[13px] text-blue-700">
                                                生成済みで保存待ち: {savePendingCount} 件（再開すると保存からやり直します）
                                            </p>
                                        )}
                                        {status.convertedAudioBlob && (
                                            <p className="text-[13px] text-blue-700">
                                                音声変換済みです（再開時は変換をスキップします）
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => onResumeFile(status.fileId)}
                                        disabled={status.isResuming}
                                        className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg bg-orange-600 px-4 text-sm font-medium text-white transition-colors hover:bg-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                                        {status.isResuming ? '再開しています...' : '再開する'}
                                    </button>
                                </div>
                            )}

                            {!isTerminal && (
                                <div className="space-y-2">
                                    {status.phase === 'audio_conversion' ? (
                                        <div>
                                            <p className="mb-1 text-sm font-medium text-blue-800">
                                                音声変換: {status.audioConversionProgress}%
                                                {status.segments.length > 0 && (
                                                    <span className="ml-2 text-[13px] text-gray-600">
                                                        ({status.completedSegmentIndices.length}/{status.segments.length} 区間完了)
                                                    </span>
                                                )}
                                            </p>
                                            <div
                                                role="progressbar"
                                                aria-label={`${status.fileName} の音声変換の進捗`}
                                                aria-valuenow={Math.round(status.audioConversionProgress)}
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
                                            >
                                                <div
                                                    className="h-full bg-blue-600 transition-all duration-300"
                                                    style={{ width: `${status.audioConversionProgress}%` }}
                                                />
                                            </div>
                                        </div>
                                    ) : (
                                        <p
                                            role="status"
                                            aria-live="polite"
                                            className="flex items-center gap-3 text-sm font-medium text-purple-800"
                                        >
                                            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-purple-600" aria-hidden="true" />
                                            <span>
                                                {status.phase === 'waiting' && status.isResuming
                                                    ? '音声変換の順番を待っています（他のファイルの変換が終わり次第開始します）'
                                                    : PHASE_LABELS[status.phase]}
                                                {(status.phase === 'text_generation' || status.phase === 'saving') && (
                                                    `: ${status.transcriptionCount}/${status.totalTranscriptions}`
                                                )}
                                            </span>
                                        </p>
                                    )}

                                    {/* U7: 反応しない中止ボタンを置かない */}
                                    {onCancelFile && activeFileIds.includes(status.fileId) && (
                                        <button
                                            type="button"
                                            onClick={() => onCancelFile(status.fileId)}
                                            className="min-h-11 rounded-md px-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                                        >
                                            このファイルの処理を中止する
                                        </button>
                                    )}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
};

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { FileDropZone } from '@/components/FileDropZone';
import { ProcessingStatusList } from '@/components/ProcessingStatusList';
import { DebugControls } from '@/components/DebugControls';
import { BulkPromptSelector } from '@/components/BulkPromptSelector';
import { FilePromptSelector } from '@/components/FilePromptSelector';
import { PromptListSidebar } from '@/components/PromptListSidebar';
import { PromptModals } from '@/components/prompts/PromptModals';
import { NotificationBanner } from '@/components/NotificationBanner';
import { useFileManagement } from '@/hooks/useFileManagement';
import { usePromptManagement } from '@/hooks/usePromptManagement';
import { useVideoProcessing } from '@/hooks/useVideoProcessing';
import { useProcessingWorkflow } from '@/hooks/useProcessingWorkflow';
import { DebugErrorMode, FileProcessingStatus } from '@/types/processing';
import { Prompt } from '@/lib/prompts';
import { useAuth } from '@/hooks/useAuth';
import { createLogger } from '@/lib/logger';

const homePageLogger = createLogger('HomePage');

/**
 * V3: ファイル削除は fileIds と processingStatuses を同じ fileId で同時に落とす。
 * 片方だけ縮めると両者の位置がずれ、再開が全ファイルで拒否される。
 */
export const removeFileEntry = (
  fileIds: readonly string[],
  removedFileId: string,
  statuses: readonly FileProcessingStatus[] = []
): { fileIds: string[]; statuses: FileProcessingStatus[] } => ({
  fileIds: fileIds.filter(fileId => fileId !== removedFileId),
  statuses: statuses.filter(status => status.fileId !== removedFileId),
});

export default function HomePage() {
  const { user } = useAuth();
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [showPromptCreateModal, setShowPromptCreateModal] = useState(false);
  const [promptUpdateTrigger, setPromptUpdateTrigger] = useState(0);
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [isDiscardConfirmOpen, setIsDiscardConfirmOpen] = useState(false);
  const [isForceDiscardOpen, setIsForceDiscardOpen] = useState(false);
  const [pendingRemovalFileId, setPendingRemovalFileId] = useState<string | null>(null);
  const [debugErrorMode, setDebugErrorMode] = useState<DebugErrorMode>({
    ffmpegError: false,
    geminiError: false,
    errorAtFileIndex: 0,
    errorAtSegmentIndex: 2,
  });

  // 🎬 動画を直接送信する機能（試験的）
  const [sendVideoDirectly, setSendVideoDirectly] = useState(false);

  const bitrate = '192k';
  const sampleRate = 44100;

  const {
    availablePrompts,
    bulkSelectedPromptIds,
    toggleBulkPrompt,
    reloadPrompts,
    retry: retryPrompts,
    status: promptStatus,
    error: promptError,
  } = usePromptManagement();

  const {
    selectedFiles,
    handleFilesSelected,
    handleRemoveFile,
    toggleFilePrompt,
    clearFiles,
    cleanupDeletedPrompts,
  } = useFileManagement(bulkSelectedPromptIds);

  const {
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
    hasActiveJobs,
    pendingSaveCount,
    needsDiscardConfirm,
    pendingSavesForFile,
    needsRemovalConfirm,
    isCanceling,
    claimJob,
    cancelJob,
    markJobCanceled,
    resetProcessing,
    forceDiscardProcessing,
    countPendingSaves,
  } = useVideoProcessing(availablePrompts, debugErrorMode, () => { });

  const {
    handleStartProcessing,
    handleResumeFile,
    workflowError,
    clearWorkflowError,
    reportWorkflowError,
  } = useProcessingWorkflow({
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
      // 🎬 動画を直接送信するフラグ（試験的）
      sendVideoDirectly,
    });

  useEffect(() => {
    homePageLogger.info('認証状態の変化を検知し処理状態を初期化', { userId: user?.uid });
    setPromptUpdateTrigger(prev => prev + 1);
    setIsDiscardConfirmOpen(false);
    // G1: 前の利用者に出していた確認ダイアログを次の利用者の画面へ持ち越さない
    setIsForceDiscardOpen(false);
    setPendingRemovalFileId(null);
    // H1: 認証が変わると保存先の所有者も変わるため、実行中のジョブを中止して破棄する
    void resetProcessing('認証状態が変わったため、処理を中止しました。').then(outcome => {
      // U3: 利用者が変わった以上、前の利用者の進捗を画面に残さない。
      // ジョブが期限内に止まらなくても表示だけは境界で切る
      if (outcome === 'timeout') forceDiscardProcessing();
      clearFiles();
      setFileIds([]);
    });
  }, [user, resetProcessing, forceDiscardProcessing, clearFiles]);

  // H3: ファイルは発行時のIDで参照する。インデックスは追加・削除でずれる
  const onFilesSelected = useCallback((files: File[], newFileIds: string[]) => {
    handleFilesSelected(files);
    setFileIds(prev => [...prev, ...newFileIds]);
  }, [handleFilesSelected]);

  const applyRemoval = useCallback((removedFileId: string) => {
    const index = fileIds.indexOf(removedFileId);
    if (index < 0) return;

    handleRemoveFile(index);
    setFileIds(prev => removeFileEntry(prev, removedFileId).fileIds);
    setProcessingStatuses(prev => removeFileEntry(fileIds, removedFileId, prev).statuses);
    setPendingRemovalFileId(null);
  }, [fileIds, handleRemoveFile, setProcessingStatuses]);

  const removeFileAt = useCallback((index: number) => {
    const removedFileId = fileIds[index];
    if (removedFileId === undefined) return;

    // G3: 一括破棄と同じ基準で、個別削除でも課金済みの下書きを無確認で捨てない
    if (needsRemovalConfirm(removedFileId)) {
      setPendingRemovalFileId(removedFileId);
      return;
    }
    applyRemoval(removedFileId);
  }, [applyRemoval, fileIds, needsRemovalConfirm]);

  const onRemoveFileById = useCallback((fileId: string) => {
    const index = fileIds.indexOf(fileId);
    if (index < 0) return;
    removeFileAt(index);
  }, [fileIds, removeFileAt]);

  const onRemoveFile = useCallback((index: number) => {
    removeFileAt(index);
  }, [removeFileAt]);

  const onStartProcessing = async () => {
    clearWorkflowError();
    setIsProcessing(true);
    try {
      // R4: 開始に失敗した理由を握り潰さない。画面に出し、待機中のまま残る進捗を巻き戻す
      const result = await handleStartProcessing(selectedFiles, fileIds, bitrate, sampleRate);
      if (!result.ok) {
        if (result.message) reportWorkflowError(result.message);
        setProcessingStatuses(prev => (prev.every(status => status.status === 'waiting') ? [] : prev));
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const finishDiscard = useCallback(() => {
    clearFiles();
    setFileIds([]);
    clearWorkflowError();
    setIsDiscardConfirmOpen(false);
    setIsForceDiscardOpen(false);
  }, [clearFiles, clearWorkflowError]);

  // R2: 中止要求を出したあと、実行中の変換・生成が決着するまで待ってから状態を落とす
  const discardEverything = useCallback(async () => {
    setIsDiscardConfirmOpen(false);
    const outcome = await resetProcessing('新しい処理を開始するため、実行中の処理を中止しました。');

    // V2: 期限内に止まらなければ進捗を消さず、強制破棄を選べるようにする
    if (outcome === 'timeout') {
      setIsForceDiscardOpen(true);
      return;
    }
    finishDiscard();
  }, [finishDiscard, resetProcessing]);

  const forceDiscard = useCallback(() => {
    forceDiscardProcessing();
    finishDiscard();
  }, [finishDiscard, forceDiscardProcessing]);

  // H5/V1: 実行中のジョブ、または保存待ちの下書きがある間は確認なしで破棄しない
  const requestDiscard = useCallback(() => {
    if (needsDiscardConfirm) {
      setIsDiscardConfirmOpen(true);
      return;
    }
    void discardEverything();
  }, [discardEverything, needsDiscardConfirm]);

  const onResumeFile = (fileId: string) => {
    void handleResumeFile(fileId, selectedFiles, fileIds, processingStatuses, bitrate, sampleRate);
  };

  const handlePromptClick = (prompt: Prompt) => {
    setSelectedPrompt(prompt);
  };

  const handleClosePromptModal = () => {
    setSelectedPrompt(null);
  };

  const handlePromptCreateClick = () => {
    setShowPromptCreateModal(true);
  };

  const handleClosePromptCreateModal = () => {
    setShowPromptCreateModal(false);
  };

  const refreshPromptSelections = async () => {
    const updatedPrompts = await reloadPrompts();
    // H10: 読み込みに失敗したときは選択を整理しない（通信障害で選択が消えるのを防ぐ）
    if (!updatedPrompts) return;

    cleanupDeletedPrompts(updatedPrompts.flatMap(prompt => (prompt.id ? [prompt.id] : [])));
    if (selectedPrompt) {
      const updatedPrompt = updatedPrompts.find(prompt => prompt.id === selectedPrompt.id);
      if (updatedPrompt) {
        setSelectedPrompt(updatedPrompt);
      }
    }
  };

  const handlePromptSaved = async () => {
    setPromptUpdateTrigger(prev => prev + 1);
    await refreshPromptSelections();
  };

  const handlePromptDeleted = async () => {
    await refreshPromptSelections();
  };

  // 中止の受付から実際の停止までの間もファイル操作と再開始を止めておく
  const isBusy = isProcessing || hasActiveJobs || isCanceling;
  const hasStatuses = processingStatuses.length > 0;
  const canStart = selectedFiles.length > 0 && !isBusy && !hasStatuses && availablePrompts.length > 0;


  return (
    <div className="space-y-4">
      <NotificationBanner />

      {/* R11: ページの h1 はここに一本化する（AppHeader のブランドは見出しではない） */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">ホーム</h1>
          <p className="mt-1 text-sm text-gray-600">
            動画・音声ファイルをアップロードして、文書を生成します。
          </p>
        </div>
      </header>

      {/* H12: アップロードを主役に置き、補助のプロンプト一覧は幅を固定した脇のペインに寄せる */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section className="space-y-6 lg:order-1">
          <div className="rounded-xl bg-white p-6 shadow-lg">
            <header className="mb-4">
              <h2 className="text-xl font-semibold text-gray-900">
                動画・音声をアップロード
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                ファイルを追加し、適用するプロンプトを選んでから文書生成を開始してください。
              </p>
            </header>

            <div className="flex flex-col gap-6">
              <FileDropZone
                onFilesSelected={onFilesSelected}
                selectedFiles={selectedFiles.map(fileWithPrompts => fileWithPrompts.file)}
                fileIds={fileIds}
                onRemoveFile={onRemoveFile}
                onRemoveFileById={onRemoveFileById}
                isProcessing={isBusy}
                activeFileIds={activeJobIds}
                onCancelFile={cancelJob}
              />

              {/* 🎬 動画直接送信オプション（試験的機能） */}
              {selectedFiles.length > 0 && !hasStatuses && (
                <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                  <label className="flex min-h-11 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={sendVideoDirectly}
                      onChange={event => setSendVideoDirectly(event.target.checked)}
                      disabled={isBusy}
                      className="h-4 w-4 rounded border-gray-300 bg-gray-100 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-3 text-sm font-medium text-gray-900">
                      🎬 動画を直接送信する（試験的）
                    </span>
                  </label>
                  <p className="ml-7 mt-1 text-[13px] text-gray-700">
                    音声変換をスキップして動画をそのまま送信します。ファイルサイズが大きいと失敗することがあります。
                  </p>
                </div>
              )}

              {selectedFiles.length === 0 && (
                <BulkPromptSelector
                  availablePrompts={availablePrompts}
                  bulkSelectedPromptIds={bulkSelectedPromptIds}
                  onToggleBulkPrompt={toggleBulkPrompt}
                />
              )}

              {selectedFiles.length > 0 && !hasStatuses && (
                <FilePromptSelector
                  selectedFiles={selectedFiles}
                  availablePrompts={availablePrompts}
                  onToggleFilePrompt={toggleFilePrompt}
                />
              )}
            </div>

            {/* H11: プロンプトが無いときは、開始ボタンのすぐ近くで理由と作成導線を示す */}
            {/* R8: 読み込みに失敗しているときは赤いエラーだけを出し、「まだありません」とは言わない */}
            {availablePrompts.length === 0 && promptStatus === 'success' && (
              <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4" role="status">
                <p className="text-sm font-medium text-amber-900">
                  文書生成に使えるプロンプトがまだありません。
                </p>
                <p className="mt-1 text-[13px] text-amber-800">
                  プロンプトを1つ以上作成すると、文書生成を開始できます。
                </p>
                <button
                  type="button"
                  onClick={handlePromptCreateClick}
                  className="mt-3 min-h-11 rounded-lg bg-amber-600 px-4 text-sm font-medium text-white transition-colors hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
                >
                  プロンプトを作成する
                </button>
              </div>
            )}

            {/* U4: 知らせと、その知らせに対応する操作を必ず同じ枠に置く */}
            {workflowError && (
              <div
                className="mt-6 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
                <p className="min-w-0 flex-1 whitespace-pre-line text-sm text-red-800">
                  {workflowError}
                </p>
              </div>
            )}

            {promptStatus === 'error' && (
              <div
                className="mt-6 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-line text-sm text-red-800">
                    {promptError ?? 'プロンプト一覧の読み込みに失敗しました。'}
                  </p>
                  {/* V5: 読み込み失敗を行き止まりにしない */}
                  <button
                    type="button"
                    onClick={() => { void retryPrompts(); }}
                    className="mt-3 min-h-11 rounded-lg border border-red-300 bg-white px-4 text-sm font-medium text-red-800 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                  >
                    プロンプト一覧を再読み込みする
                  </button>
                </div>
              </div>
            )}

            {promptStatus === 'loading' && availablePrompts.length === 0 && (
              <p className="mt-6 text-sm text-gray-600" role="status" aria-live="polite">
                プロンプト一覧を読み込んでいます。
              </p>
            )}

            {selectedFiles.length > 0 && !isBusy && !hasStatuses && (
              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={onStartProcessing}
                  disabled={!canStart}
                  className="min-h-11 flex-1 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-3 font-medium text-white shadow-md transition-all hover:from-blue-700 hover:to-indigo-700 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  変換・文書生成を開始する
                </button>
                <button
                  type="button"
                  onClick={requestDiscard}
                  className="min-h-11 rounded-lg border-2 border-gray-300 px-6 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2"
                >
                  クリアする
                </button>
              </div>
            )}

            {hasStatuses && (
              <button
                type="button"
                onClick={requestDiscard}
                disabled={isCanceling}
                className="mt-6 min-h-11 w-full rounded-lg bg-gray-600 px-6 py-3 font-medium text-white transition-colors hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCanceling ? '実行中の処理を中止しています...' : '新しい処理を開始する'}
              </button>
            )}

            {isCanceling && (
              <p className="mt-3 text-[13px] text-gray-700" role="status" aria-live="polite">
                実行中の音声変換と文書生成は途中で打ち切れないため、完了するまで止まりません。完了を確認してから画面を初期化します。
              </p>
            )}

            {/* G3: 個別削除でも、失われる下書きの件数を示してから消す */}
            {pendingRemovalFileId && (
              <div
                className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4"
                role="alertdialog"
                aria-labelledby="remove-file-confirm-title"
              >
                <p id="remove-file-confirm-title" className="text-sm font-medium text-red-900">
                  このファイルには保存されていない生成結果があります。削除してよろしいですか。
                </p>
                <p className="mt-1 text-[13px] font-medium text-red-900">
                  生成済みで保存待ちの文書 {pendingSavesForFile(pendingRemovalFileId)} 件が失われます。削除せずに「再開する」を押すと、保存だけをやり直せます。
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => applyRemoval(pendingRemovalFileId)}
                    className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                  >
                    削除する
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingRemovalFileId(null)}
                    className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2"
                  >
                    削除をやめる
                  </button>
                </div>
              </div>
            )}

            {/* H5: browser confirm を使わず、画面内で破棄の確認を取る */}
            {isDiscardConfirmOpen && (
              <div
                className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4"
                role="alertdialog"
                aria-labelledby="discard-confirm-title"
              >
                <p id="discard-confirm-title" className="text-sm font-medium text-red-900">
                  {hasActiveJobs
                    ? '実行中の処理があります。破棄してよろしいですか。'
                    : '保存されていない生成結果があります。破棄してよろしいですか。'}
                </p>
                <p className="mt-1 text-[13px] text-red-800">
                  破棄すると、進行中の変換と文書生成を中止します。保存済みの文書は残ります。
                </p>
                {/* V1: 生成済みで未保存の下書きは再生成に費用がかかるため件数を明示する */}
                {pendingSaveCount > 0 && (
                  <p className="mt-1 text-[13px] font-medium text-red-900">
                    生成済みで保存待ちの文書 {pendingSaveCount} 件が失われます。破棄せずに「再開する」を押すと、保存だけをやり直せます。
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => { void discardEverything(); }}
                    className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                  >
                    中止して破棄する
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsDiscardConfirmOpen(false)}
                    className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2"
                  >
                    処理を続ける
                  </button>
                </div>
              </div>
            )}

            {/* V2: 期限内に止まらなかったときの逃げ道。画面だけ解放することを正直に伝える */}
            {isForceDiscardOpen && (
              <div
                className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4"
                role="alertdialog"
                aria-labelledby="force-discard-title"
              >
                <p id="force-discard-title" className="text-sm font-medium text-red-900">
                  {hasActiveJobs
                    ? '実行中の処理を停止できませんでした。'
                    : '処理は停止しました。'}
                </p>
                {/* U6: ジョブが決着したあとも「まだ動いています」と言い続けない */}
                <p className="mt-1 text-[13px] text-red-800">
                  {hasActiveJobs
                    ? '音声変換や通信は途中で打ち切れないため、まだ動いています。強制的に破棄すると画面は初期化できますが、動いている処理はバックグラウンドで最後まで続き、その間はブラウザが重くなることがあります。'
                    : '待っている間に処理が終わりました。このまま破棄すると画面を初期化します。'}
                </p>
                {pendingSaveCount > 0 && (
                  <p className="mt-1 text-[13px] font-medium text-red-900">
                    生成済みで保存待ちの文書 {pendingSaveCount} 件も失われます。
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={forceDiscard}
                    className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                  >
                    {hasActiveJobs ? '強制的に破棄する' : '破棄する'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setIsForceDiscardOpen(false); void discardEverything(); }}
                    className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2"
                  >
                    もう少し待つ
                  </button>
                </div>
              </div>
            )}
          </div>

          <ProcessingStatusList
            statuses={processingStatuses}
            onResumeFile={onResumeFile}
            onCancelFile={cancelJob}
            activeFileIds={activeJobIds}
          />

          {process.env.NODE_ENV === 'development' && (
            <div className="rounded-xl bg-white p-6 shadow-lg">
              <DebugControls debugErrorMode={debugErrorMode} onDebugModeChange={setDebugErrorMode} />
            </div>
          )}
        </section>

        {/* 補助ペイン。広い画面でだけ高さを固定し、内側だけをスクロールさせる */}
        <aside className="lg:order-2">
          <div className="overflow-hidden rounded-xl shadow-lg lg:sticky lg:top-6 lg:h-[calc(100vh-9rem)]">
            <PromptListSidebar
              onPromptClick={handlePromptClick}
              onCreateClick={handlePromptCreateClick}
              onPromptDeleted={handlePromptDeleted}
              updateTrigger={promptUpdateTrigger}
            />
          </div>
        </aside>
      </div>

      <PromptModals
        selectedPrompt={selectedPrompt}
        onClosePrompt={handleClosePromptModal}
        isCreateOpen={showPromptCreateModal}
        onCloseCreate={handleClosePromptCreateModal}
        onSave={handlePromptSaved}
        onDelete={handlePromptDeleted}
      />
    </div>
  );
}

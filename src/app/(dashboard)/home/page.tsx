'use client';

import React, { useEffect, useState } from 'react';
import { FileDropZone } from '@/components/FileDropZone';
import { ProcessingStatusList } from '@/components/ProcessingStatusList';
import { DebugControls } from '@/components/DebugControls';
import { BulkPromptSelector } from '@/components/BulkPromptSelector';
import { FilePromptSelector } from '@/components/FilePromptSelector';
import { PromptListSidebar } from '@/components/PromptListSidebar';
import { PromptModals } from '@/components/prompts/PromptModals';
import { useFileManagement } from '@/hooks/useFileManagement';
import { usePromptManagement } from '@/hooks/usePromptManagement';
import { useVideoProcessing } from '@/hooks/useVideoProcessing';
import { useProcessingWorkflow } from '@/hooks/useProcessingWorkflow';
import { DebugErrorMode } from '@/types/processing';
import { Prompt } from '@/lib/prompts';
import { useAuth } from '@/hooks/useAuth';
import { createLogger } from '@/lib/logger';

const homePageLogger = createLogger('HomePage');

export default function HomePage() {
  const { user } = useAuth();
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [showPromptCreateModal, setShowPromptCreateModal] = useState(false);
  const [promptUpdateTrigger, setPromptUpdateTrigger] = useState(0);
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

  const { availablePrompts, bulkSelectedPromptIds, toggleBulkPrompt, reloadPrompts } = usePromptManagement();

  const {
    selectedFiles,
    handleFilesSelected,
    handleRemoveFile,
    toggleFilePrompt,
    clearFiles,
    cleanupDeletedPrompts,
  } = useFileManagement(bulkSelectedPromptIds);

  useEffect(() => {
    const handleAuthChange = async () => {
      homePageLogger.info('認証状態の変化を検知しデータを再読み込み', { userId: user?.uid });
      setPromptUpdateTrigger(prev => prev + 1);
      await reloadPrompts();
      clearFiles();
      setProcessingStatuses([]);
      setIsProcessing(false);
    };

    handleAuthChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

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
  } = useVideoProcessing(availablePrompts, debugErrorMode, () => {});

  const { handleStartProcessing, handleResumeFile } = useProcessingWorkflow({
    converterRef,
    geminiClientRef,
    audioConversionQueueRef,
    ffmpegLoaded,
    setFfmpegLoaded,
    setProcessingStatuses,
    processTranscription: (file, fileIndex, audioBlob) =>
      processTranscription(file, fileIndex, audioBlob, bitrate, sampleRate),
    processTranscriptionResume: (file, fileIndex, audioBlob, completedPromptIds) =>
      processTranscriptionResume(file, fileIndex, audioBlob, completedPromptIds, bitrate, sampleRate),
    debugErrorMode,
    // 🎬 動画を直接送信するフラグ（試験的）
    sendVideoDirectly,
  });

  const onStartProcessing = async () => {
    setIsProcessing(true);
    try {
      await handleStartProcessing(selectedFiles, bitrate, sampleRate);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    clearFiles();
    setProcessingStatuses([]);
    setIsProcessing(false);
  };

  const onResumeFile = (index: number) => {
    handleResumeFile(index, selectedFiles, processingStatuses, bitrate, sampleRate);
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
    const validPromptIds = updatedPrompts.map(p => p.id!);
    cleanupDeletedPrompts(validPromptIds);
    if (selectedPrompt) {
      const updatedPrompt = updatedPrompts.find(p => p.id === selectedPrompt.id);
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className="rounded-xl shadow-lg overflow-hidden h-[calc(100vh-125px)] min-h-[532px]">
          <PromptListSidebar
            onPromptClick={handlePromptClick}
            onCreateClick={handlePromptCreateClick}
            onPromptDeleted={handlePromptDeleted}
            updateTrigger={promptUpdateTrigger}
          />
        </div>
      </div>

      <div className="lg:col-span-3 space-y-6">
        <div className="bg-white rounded-xl shadow-lg p-6 h-[calc(100vh-125px)] min-h-[532px] flex flex-col">
          <div className="flex-1 overflow-y-auto flex flex-col gap-6">
            <FileDropZone onFilesSelected={handleFilesSelected} selectedFiles={selectedFiles.map(f => f.file)} onRemoveFile={handleRemoveFile} />

            {/* 🎬 動画直接送信オプション（試験的機能） */}
            {selectedFiles.length > 0 && processingStatuses.length === 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendVideoDirectly}
                    onChange={(e) => setSendVideoDirectly(e.target.checked)}
                    className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span className="ml-3 text-sm font-medium text-gray-900">
                    🎬 動画を直接送信（試験的）
                  </span>
                </label>
                <p className="ml-7 mt-1 text-xs text-gray-600">
                  ⚠️ 音声変換をスキップして動画を直接Gemini APIに送信します。ファイルサイズが大きいと失敗する可能性があります。
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

            {selectedFiles.length > 0 && processingStatuses.length === 0 && (
              <FilePromptSelector selectedFiles={selectedFiles} availablePrompts={availablePrompts} onToggleFilePrompt={toggleFilePrompt} />
            )}
          </div>

          {selectedFiles.length > 0 && !isProcessing && processingStatuses.length === 0 && (
            <div className="mt-6 flex space-x-3">
              <button
                onClick={onStartProcessing}
                className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 px-6 rounded-lg font-medium hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md hover:shadow-lg"
              >
                変換・文書生成開始
              </button>
              <button
                onClick={handleReset}
                className="px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition-colors"
              >
                クリア
              </button>
            </div>
          )}

          {processingStatuses.length > 0 && !isProcessing && (
            <button
              onClick={handleReset}
              className="mt-6 w-full bg-gray-600 text-white py-3 px-6 rounded-lg font-medium hover:bg-gray-700 transition-colors"
            >
              新しい処理を開始
            </button>
          )}
        </div>

        <ProcessingStatusList statuses={processingStatuses} onResumeFile={onResumeFile} />

        {process.env.NODE_ENV === 'development' && (
          <div className="bg-white rounded-xl shadow-lg p-6">
            <DebugControls debugErrorMode={debugErrorMode} onDebugModeChange={setDebugErrorMode} />
          </div>
        )}
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



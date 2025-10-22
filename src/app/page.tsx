'use client';

import React, { useState } from 'react';
import { FileDropZone } from '@/components/FileDropZone';
import { ProcessingStatusList } from '@/components/ProcessingStatusList';
import { DebugControls } from '@/components/DebugControls';
import { BulkPromptSelector } from '@/components/BulkPromptSelector';
import { FilePromptSelector } from '@/components/FilePromptSelector';
import { DocumentListSidebar } from '@/components/DocumentListSidebar';
import { DocumentModal } from '@/components/DocumentModal';
import { PromptListSidebar } from '@/components/PromptListSidebar';
import { PromptEditModal } from '@/components/PromptEditModal';
import { PromptCreateModal } from '@/components/PromptCreateModal';
import { useFileManagement } from '@/hooks/useFileManagement';
import { usePromptManagement } from '@/hooks/usePromptManagement';
import { useVideoProcessing } from '@/hooks/useVideoProcessing';
import { useProcessingWorkflow } from '@/hooks/useProcessingWorkflow';
import { DebugErrorMode } from '@/types/processing';
import { Transcription } from '@/lib/firestore';
import { Prompt } from '@/lib/prompts';
import { Music, Sparkles } from 'lucide-react';
import AuthButton from '@/components/AuthButton';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';

export default function Home() {
  const { user } = useAuth();

  // 固定値
  const bitrate = '192k';
  const sampleRate = 44100;

  const [selectedDocument, setSelectedDocument] = useState<Transcription | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [showPromptCreateModal, setShowPromptCreateModal] = useState(false);
  const [promptUpdateTrigger, setPromptUpdateTrigger] = useState(0);
  const [documentUpdateTrigger, setDocumentUpdateTrigger] = useState(0);
  const [debugErrorMode, setDebugErrorMode] = useState<DebugErrorMode>({
    ffmpegError: false,
    geminiError: false,
    errorAtFileIndex: 0,
    errorAtSegmentIndex: 2,
  });

  // プロンプト管理
  const { availablePrompts, bulkSelectedPromptIds, toggleBulkPrompt, reloadPrompts } = usePromptManagement();

  // ファイル管理
  const {
    selectedFiles,
    handleFilesSelected,
    handleRemoveFile,
    toggleFilePrompt,
    clearFiles,
    cleanupDeletedPrompts,
  } = useFileManagement(bulkSelectedPromptIds);

  // ログイン/ログアウト時の自動更新
  useEffect(() => {
    // 認証状態が変更されたら、すべてのデータを更新
    const handleAuthChange = async () => {
      console.log('認証状態が変更されました。データを更新します...');

      // プロンプト一覧を更新
      setPromptUpdateTrigger(prev => prev + 1);
      await reloadPrompts();

      // 文書一覧を更新
      setDocumentUpdateTrigger(prev => prev + 1);

      // ファイル選択とBulkPromptsをクリア
      clearFiles();

      // 処理中のステータスをクリア
      setProcessingStatuses([]);
      setIsProcessing(false);
    };

    handleAuthChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]); // userが変更されたら実行

  // ビデオ処理
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
  } = useVideoProcessing(availablePrompts, debugErrorMode);

  // 処理ワークフロー
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
  });

  // 処理開始
  const onStartProcessing = async () => {
    setIsProcessing(true);
    try {
      await handleStartProcessing(selectedFiles, bitrate, sampleRate);
    } finally {
      setIsProcessing(false);
    }
  };

  // リセット
  const handleReset = () => {
    clearFiles();
    setProcessingStatuses([]);
    setIsProcessing(false);
  };

  // 再開処理のラッパー
  const onResumeFile = (index: number) => {
    handleResumeFile(index, selectedFiles, processingStatuses, bitrate, sampleRate);
  };

  // 文書モーダル処理
  const handleDocumentClick = (transcription: Transcription) => {
    setSelectedDocument(transcription);
  };

  const handleCloseDocumentModal = () => {
    setSelectedDocument(null);
  };

  // プロンプトモーダル処理
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

  const handlePromptSaved = async () => {
    // 左側のプロンプト一覧を更新
    setPromptUpdateTrigger(prev => prev + 1);
    // 右側のプロンプト一覧も更新
    const updatedPrompts = await reloadPrompts();
    // ファイルごとの選択プロンプトから削除されたものを除外
    const validPromptIds = updatedPrompts.map(p => p.id!);
    cleanupDeletedPrompts(validPromptIds);
  };

  const handlePromptDeleted = async () => {
    // 右側のプロンプト一覧を更新
    const updatedPrompts = await reloadPrompts();
    // ファイルごとの選択プロンプトから削除されたものを除外
    const validPromptIds = updatedPrompts.map(p => p.id!);
    cleanupDeletedPrompts(validPromptIds);
  };

  const handleDownloadDocument = () => {
    if (!selectedDocument) return;

    const blob = new Blob([selectedDocument.text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedDocument.fileName}_${selectedDocument.promptName}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDeleteDocument = async () => {
    if (!selectedDocument) return;

    if (!confirm(`「${selectedDocument.fileName} - ${selectedDocument.promptName}」を削除しますか？`)) return;

    try {
      const { deleteTranscription } = await import('@/lib/firestore');
      await deleteTranscription(selectedDocument.id!);
      setSelectedDocument(null);
    } catch (error) {
      alert('削除に失敗しました');
      console.error(error);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* ヘッダー */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-3">
              <div className="p-3 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl shadow-lg">
                <Music className="w-8 h-8 text-white" />
              </div>
              <div>
                <h1 className="text-4xl font-bold text-gray-900 flex items-center gap-2">
                  商談くんミニ（簡易版）
                  <Sparkles className="w-6 h-6 text-yellow-500" />
                </h1>
                <p className="text-gray-600 text-left">
                  動画・音声から自動で文書を生成
                </p>
              </div>
            </div>
            <AuthButton />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* 左側: サイドバー (2/5) */}
          <div className="lg:col-span-2 space-y-6">
            {/* プロンプト一覧 */}
            <div className="rounded-xl shadow-lg overflow-hidden">
              <PromptListSidebar
                onPromptClick={handlePromptClick}
                onCreateClick={handlePromptCreateClick}
                onPromptDeleted={handlePromptDeleted}
                updateTrigger={promptUpdateTrigger}
              />
            </div>

            {/* 生成された文書一覧 */}
            <div className="h-[calc(100vh-12rem)] rounded-xl shadow-lg overflow-hidden">
              <DocumentListSidebar
                onDocumentClick={handleDocumentClick}
                updateTrigger={documentUpdateTrigger}
              />
            </div>
          </div>

          {/* 右側: ファイル選択と処理 (3/5) */}
          <div className="lg:col-span-3 space-y-6">
            <div className="bg-white rounded-xl shadow-lg p-6">
              <FileDropZone
                onFilesSelected={handleFilesSelected}
                selectedFiles={selectedFiles.map(f => f.file)}
                onRemoveFile={handleRemoveFile}
              />

              {/* 一括プロンプト選択 */}
              {selectedFiles.length === 0 && (
                <BulkPromptSelector
                  availablePrompts={availablePrompts}
                  bulkSelectedPromptIds={bulkSelectedPromptIds}
                  onToggleBulkPrompt={toggleBulkPrompt}
                />
              )}

              {/* ファイルごとのプロンプト選択 */}
              {selectedFiles.length > 0 && processingStatuses.length === 0 && (
                <FilePromptSelector
                  selectedFiles={selectedFiles}
                  availablePrompts={availablePrompts}
                  onToggleFilePrompt={toggleFilePrompt}
                />
              )}

              {/* 処理開始ボタン */}
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

              {/* リセットボタン */}
              {processingStatuses.length > 0 && !isProcessing && (
                <button
                  onClick={handleReset}
                  className="mt-6 w-full bg-gray-600 text-white py-3 px-6 rounded-lg font-medium hover:bg-gray-700 transition-colors"
                >
                  新しい処理を開始
                </button>
              )}
            </div>

            {/* 進捗表示 */}
            <ProcessingStatusList
              statuses={processingStatuses}
              onResumeFile={onResumeFile}
            />

            {/* デバッグコントロール */}
            {process.env.NODE_ENV === 'development' && (
              <div className="bg-white rounded-xl shadow-lg p-6">
                <DebugControls
                  debugErrorMode={debugErrorMode}
                  onDebugModeChange={setDebugErrorMode}
                />
              </div>
            )}
          </div>
        </div>

        {/* 文書モーダル */}
        <DocumentModal
          isOpen={!!selectedDocument}
          onClose={handleCloseDocumentModal}
          title={selectedDocument ? `${selectedDocument.fileName} - ${selectedDocument.promptName}` : ''}
          content={selectedDocument?.text || ''}
          onDownload={handleDownloadDocument}
          onDelete={handleDeleteDocument}
        />

        {/* プロンプト編集モーダル */}
        <PromptEditModal
          isOpen={!!selectedPrompt}
          onClose={handleClosePromptModal}
          prompt={selectedPrompt}
          onSave={handlePromptSaved}
          onDelete={handlePromptSaved}
        />

        {/* プロンプト作成モーダル */}
        <PromptCreateModal
          isOpen={showPromptCreateModal}
          onClose={handleClosePromptCreateModal}
          onSave={handlePromptSaved}
        />

        {/* フッター */}
        <div className="mt-8 text-center text-sm text-gray-500">
          <p>Powered by FFmpeg.wasm, Gemini 2.5 Flash & Firestore</p>
        </div>
      </div>
    </main>
  );
}


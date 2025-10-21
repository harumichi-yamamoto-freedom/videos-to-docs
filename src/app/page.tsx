'use client';

import React, { useState } from 'react';
import { FileDropZone } from '@/components/FileDropZone';
import { ConversionSettings } from '@/components/ConversionSettings';
import { TranscriptionList } from '@/components/TranscriptionList';
import { PromptManager } from '@/components/PromptManager';
import { ProcessingStatusList } from '@/components/ProcessingStatusList';
import { DebugControls } from '@/components/DebugControls';
import { BulkPromptSelector } from '@/components/BulkPromptSelector';
import { FilePromptSelector } from '@/components/FilePromptSelector';
import { useFileManagement } from '@/hooks/useFileManagement';
import { usePromptManagement } from '@/hooks/usePromptManagement';
import { useVideoProcessing } from '@/hooks/useVideoProcessing';
import { useProcessingWorkflow } from '@/hooks/useProcessingWorkflow';
import { DebugErrorMode } from '@/types/processing';
import { Music, Sparkles, FileText, Settings } from 'lucide-react';

export default function Home() {
  const [bitrate, setBitrate] = useState('192k');
  const [sampleRate, setSampleRate] = useState(44100);
  const [showTranscriptions, setShowTranscriptions] = useState(false);
  const [showPromptManager, setShowPromptManager] = useState(false);
  const [debugErrorMode, setDebugErrorMode] = useState<DebugErrorMode>({
    ffmpegError: false,
    geminiError: false,
    errorAtFileIndex: 0,
    errorAtSegmentIndex: 2,
  });

  // プロンプト管理
  const { availablePrompts, bulkSelectedPromptIds, toggleBulkPrompt } = usePromptManagement();

  // ファイル管理
  const {
    selectedFiles,
    handleFilesSelected,
    handleRemoveFile,
    toggleFilePrompt,
    clearFiles,
  } = useFileManagement(bulkSelectedPromptIds);

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

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        {/* ヘッダー */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center space-x-3 mb-4">
            <div className="p-3 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl shadow-lg">
              <Music className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900">
              動画→文書生成
            </h1>
            <Sparkles className="w-6 h-6 text-yellow-500" />
          </div>
          <p className="text-gray-600">
            WebAssembly + Gemini AIで音声から自動文書生成
          </p>
        </div>

        {/* プロンプト管理タブ */}
        <div className="mb-6">
          <button
            onClick={() => setShowPromptManager(!showPromptManager)}
            className="flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
          >
            <Settings className="w-4 h-4" />
            <span>{showPromptManager ? 'プロンプト管理を閉じる' : 'プロンプト管理を開く'}</span>
          </button>
        </div>

        {showPromptManager && (
          <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
            <PromptManager />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左側: ファイル選択と設定 */}
          <div className="lg:col-span-2 space-y-6">
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
          </div>

          {/* 右側: 設定 */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-xl shadow-lg p-6 sticky top-8">
              <ConversionSettings
                bitrate={bitrate}
                sampleRate={sampleRate}
                onBitrateChange={setBitrate}
                onSampleRateChange={setSampleRate}
              />

              {/* 情報ボックス */}
              <div className="mt-6 bg-gradient-to-br from-purple-50 to-pink-50 border border-purple-200 rounded-lg p-4">
                <h4 className="text-sm font-medium text-purple-900 mb-2">
                  🤖 AI文書生成
                </h4>
                <p className="text-xs text-purple-800">
                  Gemini 2.5 Flashで音声を分析し、選択したプロンプトごとに文書を自動生成します。
                </p>
              </div>

              <div className="mt-4 bg-gradient-to-br from-blue-50 to-cyan-50 border border-blue-200 rounded-lg p-4">
                <h4 className="text-sm font-medium text-blue-900 mb-2">
                  ⚡ 並列処理
                </h4>
                <p className="text-xs text-blue-800">
                  複数ファイルの音声変換と文書生成を並列で処理し、高速化します。
                </p>
              </div>

              <div className="mt-4 bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4">
                <h4 className="text-sm font-medium text-green-900 mb-2">
                  📝 複数プロンプト
                </h4>
                <p className="text-xs text-green-800">
                  1つのファイルに複数のプロンプトを適用し、異なる形式の文書を同時生成できます。
                </p>
              </div>

              {/* デバッグコントロール */}
              <DebugControls
                debugErrorMode={debugErrorMode}
                onDebugModeChange={setDebugErrorMode}
              />
            </div>
          </div>
        </div>

        {/* 生成された文書セクション */}
        <div className="mt-12">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center">
              <FileText className="w-7 h-7 mr-2 text-purple-600" />
              生成された文書
            </h2>
            <button
              onClick={() => setShowTranscriptions(!showTranscriptions)}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              {showTranscriptions ? '非表示' : '表示'}
            </button>
          </div>

          {showTranscriptions && (
            <div className="bg-white rounded-xl shadow-lg p-6">
              <TranscriptionList />
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="mt-8 text-center text-sm text-gray-500">
          <p>Powered by FFmpeg.wasm, Gemini 2.5 Flash & Firestore</p>
        </div>
      </div>
    </main>
  );
}


'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { FileDropZone } from '@/components/FileDropZone';
import { ConversionSettings } from '@/components/ConversionSettings';
import { TranscriptionList } from '@/components/TranscriptionList';
import { PromptManager } from '@/components/PromptManager';
import { VideoConverter } from '@/lib/ffmpeg';
import { GeminiClient } from '@/lib/gemini';
import { saveTranscription } from '@/lib/firestore';
import { Prompt, getPrompts } from '@/lib/prompts';
import { Music, Sparkles, FileText, Settings, CheckSquare, Square, Loader2 } from 'lucide-react';

interface FileWithPrompts {
  file: File;
  selectedPromptIds: string[];
}

interface FileProcessingStatus {
  fileName: string;
  status: 'waiting' | 'converting' | 'transcribing' | 'completed' | 'error';
  phase: 'waiting' | 'audio_conversion' | 'text_generation' | 'completed';
  audioConversionProgress: number; // 音声変換の進捗（0-100）
  transcriptionCount: number; // 生成された文書数
  totalTranscriptions: number; // 生成予定の文書数
  error?: string;
  convertedAudioBlob?: Blob; // 変換済み音声データ（再開用）
  completedPromptIds: string[]; // 完了したプロンプトID（再開用）
  failedPhase?: 'audio_conversion' | 'text_generation'; // 失敗したフェーズ
  isResuming?: boolean; // 再開処理中かどうか
}

export default function Home() {
  const [selectedFiles, setSelectedFiles] = useState<FileWithPrompts[]>([]);
  const [processingStatuses, setProcessingStatuses] = useState<FileProcessingStatus[]>([]);
  const [bitrate, setBitrate] = useState('192k');
  const [sampleRate, setSampleRate] = useState(44100);
  const [isProcessing, setIsProcessing] = useState(false);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [showTranscriptions, setShowTranscriptions] = useState(false);
  const [showPromptManager, setShowPromptManager] = useState(false);
  const [availablePrompts, setAvailablePrompts] = useState<Prompt[]>([]);
  const [bulkSelectedPromptIds, setBulkSelectedPromptIds] = useState<string[]>([]);
  const converterRef = useRef<VideoConverter | null>(null);
  const geminiClientRef = useRef<GeminiClient | null>(null);

  // 音声変換の処理キュー（直列処理用）
  const audioConversionQueueRef = useRef<boolean>(false); // 音声変換処理中かどうか

  // デバッグ用: テストエラーの設定
  const [debugErrorMode, setDebugErrorMode] = useState({
    ffmpegError: false,
    geminiError: false,
    errorAtFileIndex: 0, // どのファイルでエラーを起こすか
  });

  // プロンプト一覧を読み込み
  useEffect(() => {
    loadPrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPrompts = async () => {
    try {
      const prompts = await getPrompts();
      setAvailablePrompts(prompts);
      // デフォルトで最初のプロンプトを選択
      if (prompts.length > 0 && bulkSelectedPromptIds.length === 0) {
        setBulkSelectedPromptIds([prompts[0].id!]);
      }
    } catch (error) {
      console.error('プロンプト読み込みエラー:', error);
    }
  };

  // ファイルが選択された時
  const handleFilesSelected = useCallback((files: File[]) => {
    const filesWithPrompts: FileWithPrompts[] = files.map(file => ({
      file,
      selectedPromptIds: [...bulkSelectedPromptIds]
    }));
    setSelectedFiles(prev => [...prev, ...filesWithPrompts]);
  }, [bulkSelectedPromptIds]);

  // ファイルを削除
  const handleRemoveFile = useCallback((index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  // 一括プロンプト選択のトグル
  const toggleBulkPrompt = (promptId: string) => {
    setBulkSelectedPromptIds(prev => {
      if (prev.includes(promptId)) {
        return prev.filter(id => id !== promptId);
      } else {
        return [...prev, promptId];
      }
    });
  };

  // ファイルごとのプロンプト選択のトグル
  const toggleFilePrompt = (fileIndex: number, promptId: string) => {
    setSelectedFiles(prev => prev.map((fileWithPrompts, idx) => {
      if (idx === fileIndex) {
        const selectedPromptIds = fileWithPrompts.selectedPromptIds.includes(promptId)
          ? fileWithPrompts.selectedPromptIds.filter(id => id !== promptId)
          : [...fileWithPrompts.selectedPromptIds, promptId];
        return {
          ...fileWithPrompts,
          selectedPromptIds
        };
      }
      return fileWithPrompts;
    }));
  };

  // 変換・文書生成開始
  const handleStartProcessing = async () => {
    if (selectedFiles.length === 0) return;

    // プロンプトが選択されているか確認
    const hasPrompts = selectedFiles.every(file => file.selectedPromptIds.length > 0);
    if (!hasPrompts) {
      alert('すべてのファイルに最低1つのプロンプトを選択してください');
      return;
    }

    setIsProcessing(true);

    // 初期ステータスを設定
    const initialStatuses: FileProcessingStatus[] = selectedFiles.map(fileWithPrompts => ({
      fileName: fileWithPrompts.file.name,
      status: 'waiting',
      phase: 'waiting',
      audioConversionProgress: 0,
      totalTranscriptions: fileWithPrompts.selectedPromptIds.length,
      transcriptionCount: 0,
      completedPromptIds: [],
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
          const transcriptionPromise = processTranscription(file, i, file.file as Blob);
          transcriptionPromises.push(transcriptionPromise);
        } else {
          // 動画ファイルの場合：音声変換が必要（直列処理）
          audioConversionQueueRef.current = true;

          try {
            // 音声変換開始
            setProcessingStatuses(prev =>
              prev.map((status, idx) =>
                idx === i
                  ? { ...status, status: 'converting', phase: 'audio_conversion', audioConversionProgress: 0 }
                  : status
              )
            );

            // デバッグ用: 意図的にFFmpegエラーを発生させる
            let result;
            if (debugErrorMode.ffmpegError && i === debugErrorMode.errorAtFileIndex) {
              result = {
                success: false,
                error: '[デバッグ] 意図的に発生させたFFmpegエラー'
              };
            } else {
              result = await converterRef.current!.convertToMp3(file.file, {
                bitrate,
                sampleRate,
                onProgress: (progress) => {
                  setProcessingStatuses(prev =>
                    prev.map((status, idx) =>
                      idx === i
                        ? { ...status, audioConversionProgress: Math.round(progress.ratio * 100) }
                        : status
                    )
                  );
                },
              });
            }

            if (!result.success || !result.outputBlob) {
              setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                  idx === i
                    ? {
                      ...status,
                      status: 'error',
                      error: result.error || '音声変換に失敗しました',
                      failedPhase: 'audio_conversion'
                    }
                    : status
                )
              );
            } else {
              // 音声変換が成功したら、Blobをキャッシュしてすぐに文書生成を並列で開始
              setProcessingStatuses(prev =>
                prev.map((status, idx) =>
                  idx === i
                    ? { ...status, convertedAudioBlob: result.outputBlob }
                    : status
                )
              );
              const transcriptionPromise = processTranscription(file, i, result.outputBlob);
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
    } finally {
      setIsProcessing(false);
    }
  };

  // 文書生成処理（並列実行される）
  const processTranscription = async (file: FileWithPrompts, fileIndex: number, audioBlob: Blob) => {
    try {
      // デバッグ用: 意図的にGeminiエラーを発生させる
      if (debugErrorMode.geminiError && fileIndex === debugErrorMode.errorAtFileIndex) {
        throw new Error('[デバッグ] 意図的に発生させたGemini APIエラー');
      }

      // 文書生成開始
      setProcessingStatuses(prev =>
        prev.map((status, idx) =>
          idx === fileIndex
            ? { ...status, status: 'transcribing', phase: 'text_generation', transcriptionCount: 0 }
            : status
        )
      );

      // 選択されたプロンプト情報を取得
      const selectedPrompts = availablePrompts.filter(p =>
        file.selectedPromptIds.includes(p.id!)
      );

      // 各プロンプトで文書生成（並列処理）
      await Promise.all(
        selectedPrompts.map(async (prompt) => {
          try {
            const transcriptionResult = await geminiClientRef.current!.transcribeAudio(
              audioBlob,
              file.file.name,
              prompt.content
            );

            if (transcriptionResult.success && transcriptionResult.text) {
              // Firestoreに保存
              await saveTranscription(
                file.file.name,
                transcriptionResult.text,
                prompt.name,
                file.file.type.startsWith('video/') ? 'video' : 'audio',
                bitrate,
                sampleRate
              );

              // 進捗を更新（完了したプロンプトIDを記録）
              setProcessingStatuses(prev =>
                prev.map((status, idx) => {
                  if (idx === fileIndex) {
                    const newCount = status.transcriptionCount + 1;
                    const completedPromptIds = [...status.completedPromptIds, prompt.id!];
                    return {
                      ...status,
                      transcriptionCount: newCount,
                      completedPromptIds,
                    };
                  }
                  return status;
                })
              );
            } else if (!transcriptionResult.success) {
              // API呼び出しは成功したが、処理が失敗した場合
              console.error(`プロンプト「${prompt.name}」での文書生成失敗:`, transcriptionResult.error);
              throw new Error(transcriptionResult.error || 'Gemini API処理失敗');
            }
          } catch (promptError) {
            console.error(`プロンプト「${prompt.name}」での文書生成エラー:`, promptError);
            // エラーを再スローして外側のcatchで処理
            throw promptError;
          }
        })
      );

      // 完了
      setProcessingStatuses(prev =>
        prev.map((status, idx) =>
          idx === fileIndex
            ? { ...status, status: 'completed', phase: 'completed' }
            : status
        )
      );

    } catch (error) {
      console.error(`ファイル ${file.file.name} の文書生成エラー:`, error);
      setProcessingStatuses(prev =>
        prev.map((status, idx) =>
          idx === fileIndex
            ? {
              ...status,
              status: 'error',
              error: error instanceof Error ? error.message : '不明なエラー',
              failedPhase: 'text_generation'
            }
            : status
        )
      );
    }
  };

  // 文書生成処理（再開用 - 未完了のプロンプトのみ処理）
  const processTranscriptionResume = async (file: FileWithPrompts, fileIndex: number, audioBlob: Blob, completedPromptIds: string[]) => {
    try {
      // デバッグ用: 意図的にGeminiエラーを発生させる
      if (debugErrorMode.geminiError && fileIndex === debugErrorMode.errorAtFileIndex) {
        throw new Error('[デバッグ] 意図的に発生させたGemini APIエラー');
      }

      // 文書生成開始
      setProcessingStatuses(prev =>
        prev.map((status, idx) =>
          idx === fileIndex
            ? { ...status, status: 'transcribing', phase: 'text_generation', error: undefined }
            : status
        )
      );

      // 選択されたプロンプトのうち、未完了のものだけを取得
      const selectedPrompts = availablePrompts.filter(p =>
        file.selectedPromptIds.includes(p.id!) && !completedPromptIds.includes(p.id!)
      );

      // 未完了のプロンプトがない場合は完了扱い
      if (selectedPrompts.length === 0) {
        setProcessingStatuses(prev =>
          prev.map((status, idx) =>
            idx === fileIndex
              ? { ...status, status: 'completed', phase: 'completed' }
              : status
          )
        );
        return;
      }

      // 各プロンプトで文書生成（並列処理）
      await Promise.all(
        selectedPrompts.map(async (prompt) => {
          try {
            const transcriptionResult = await geminiClientRef.current!.transcribeAudio(
              audioBlob,
              file.file.name,
              prompt.content
            );

            if (transcriptionResult.success && transcriptionResult.text) {
              // Firestoreに保存
              await saveTranscription(
                file.file.name,
                transcriptionResult.text,
                prompt.name,
                file.file.type.startsWith('video/') ? 'video' : 'audio',
                bitrate,
                sampleRate
              );

              // 進捗を更新（完了したプロンプトIDを記録）
              setProcessingStatuses(prev =>
                prev.map((status, idx) => {
                  if (idx === fileIndex) {
                    const newCount = status.transcriptionCount + 1;
                    const newCompletedPromptIds = [...status.completedPromptIds, prompt.id!];
                    return {
                      ...status,
                      transcriptionCount: newCount,
                      completedPromptIds: newCompletedPromptIds,
                    };
                  }
                  return status;
                })
              );
            } else if (!transcriptionResult.success) {
              // API呼び出しは成功したが、処理が失敗した場合
              console.error(`プロンプト「${prompt.name}」での文書生成失敗:`, transcriptionResult.error);
              throw new Error(transcriptionResult.error || 'Gemini API処理失敗');
            }
          } catch (promptError) {
            console.error(`プロンプト「${prompt.name}」での文書生成エラー:`, promptError);
            // エラーを再スローして外側のcatchで処理
            throw promptError;
          }
        })
      );

      // 完了
      setProcessingStatuses(prev =>
        prev.map((status, idx) =>
          idx === fileIndex
            ? { ...status, status: 'completed', phase: 'completed' }
            : status
        )
      );

    } catch (error) {
      console.error(`ファイル ${file.file.name} の文書生成エラー:`, error);
      setProcessingStatuses(prev =>
        prev.map((status, idx) =>
          idx === fileIndex
            ? {
              ...status,
              status: 'error',
              error: error instanceof Error ? error.message : '不明なエラー',
              failedPhase: 'text_generation'
            }
            : status
        )
      );
    }
  };

  // 個別ファイルの再開処理
  const handleResumeFile = (fileIndex: number) => {
    const file = selectedFiles[fileIndex];
    const status = processingStatuses[fileIndex];

    if (!file || !status) return;
    if (status.isResuming) return; // 既に再開処理中の場合はスキップ

    // 再開処理中フラグを立てる
    setProcessingStatuses(prev =>
      prev.map((s, idx) =>
        idx === fileIndex
          ? { ...s, isResuming: true, error: undefined }
          : s
      )
    );

    // 非同期処理を開始（await せずにバックグラウンドで実行）
    (async () => {
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

        // 音声変換済みの場合は、文書生成のみを実行（並列処理可能）
        if (status.convertedAudioBlob) {
          // Geminiエラーの場合：即座に並列処理を開始
          await processTranscriptionResume(file, fileIndex, status.convertedAudioBlob, status.completedPromptIds);
        } else {
          // 音声ファイルかどうかを判定
          const isAudioFile = file.file.type.startsWith('audio/') ||
            file.file.name.toLowerCase().match(/\.(mp3|wav|m4a|aac|ogg|flac)$/);

          if (isAudioFile) {
            // 音声ファイルの場合：音声変換をスキップして直接文書生成へ
            setProcessingStatuses(prev =>
              prev.map((s, idx) =>
                idx === fileIndex
                  ? { ...s, convertedAudioBlob: file.file as Blob }
                  : s
              )
            );
            await processTranscriptionResume(file, fileIndex, file.file as Blob, status.completedPromptIds);
          } else {
            // 動画ファイルで音声変換エラーの場合：他の音声変換処理が終わるまで待機（直列処理）
            // 待機中の状態を表示
            setProcessingStatuses(prev =>
              prev.map((s, idx) =>
                idx === fileIndex
                  ? { ...s, phase: 'waiting' }
                  : s
              )
            );

            // 音声変換処理中の場合は待機
            while (audioConversionQueueRef.current) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }

            // 音声変換を開始
            audioConversionQueueRef.current = true;

            try {
              setProcessingStatuses(prev =>
                prev.map((s, idx) =>
                  idx === fileIndex
                    ? { ...s, status: 'converting', phase: 'audio_conversion', audioConversionProgress: 0 }
                    : s
                )
              );

              // デバッグ用: 意図的にFFmpegエラーを発生させる
              let result;
              if (debugErrorMode.ffmpegError && fileIndex === debugErrorMode.errorAtFileIndex) {
                result = {
                  success: false,
                  error: '[デバッグ] 意図的に発生させたFFmpegエラー'
                };
              } else {
                result = await converterRef.current!.convertToMp3(file.file, {
                  bitrate,
                  sampleRate,
                  onProgress: (progress) => {
                    setProcessingStatuses(prev =>
                      prev.map((s, idx) =>
                        idx === fileIndex
                          ? { ...s, audioConversionProgress: Math.round(progress.ratio * 100) }
                          : s
                      )
                    );
                  },
                });
              }

              if (!result.success || !result.outputBlob) {
                setProcessingStatuses(prev =>
                  prev.map((s, idx) =>
                    idx === fileIndex
                      ? {
                        ...s,
                        status: 'error',
                        error: result.error || '音声変換に失敗しました',
                        failedPhase: 'audio_conversion',
                        isResuming: false
                      }
                      : s
                  )
                );
              } else {
                // 音声変換が成功したら、Blobをキャッシュしてすぐに文書生成を開始
                setProcessingStatuses(prev =>
                  prev.map((s, idx) =>
                    idx === fileIndex
                      ? { ...s, convertedAudioBlob: result.outputBlob }
                      : s
                  )
                );
                await processTranscriptionResume(file, fileIndex, result.outputBlob, status.completedPromptIds);
              }
            } finally {
              // 音声変換処理完了
              audioConversionQueueRef.current = false;
            }
          }
        }

      } catch (error) {
        console.error('個別ファイル再開処理エラー:', error);
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
        // 再開処理完了フラグをクリア
        setProcessingStatuses(prev =>
          prev.map((s, idx) =>
            idx === fileIndex && s.isResuming
              ? { ...s, isResuming: false }
              : s
          )
        );
      }
    })();
  };

  // リセット
  const handleReset = () => {
    setSelectedFiles([]);
    setProcessingStatuses([]);
    setIsProcessing(false);
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
              {selectedFiles.length === 0 && availablePrompts.length > 0 && (
                <div className="mt-6 bg-purple-50 border border-purple-200 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-purple-900 mb-3">
                    📝 デフォルトプロンプト選択（ファイル追加時に適用）
                  </h3>
                  <div className="space-y-2">
                    {availablePrompts.map(prompt => (
                      <div
                        key={prompt.id}
                        className="flex items-center space-x-2 cursor-pointer hover:bg-purple-100 p-2 rounded"
                        onClick={() => toggleBulkPrompt(prompt.id!)}
                      >
                        {bulkSelectedPromptIds.includes(prompt.id!) ? (
                          <CheckSquare className="w-4 h-4 text-purple-600" />
                        ) : (
                          <Square className="w-4 h-4 text-gray-400" />
                        )}
                        <span className="text-sm text-gray-700">{prompt.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ファイルごとのプロンプト選択 */}
              {selectedFiles.length > 0 && processingStatuses.length === 0 && (
                <div className="mt-6 space-y-4">
                  <h3 className="text-lg font-medium text-gray-900">
                    ファイルごとのプロンプト設定
                  </h3>
                  {selectedFiles.map((fileWithPrompts, fileIndex) => (
                    <div key={fileIndex} className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                      <p className="text-sm font-medium text-gray-900 mb-3">
                        📄 {fileWithPrompts.file.name}
                      </p>
                      <div className="space-y-1">
                        {availablePrompts.map(prompt => (
                          <div
                            key={prompt.id}
                            className="flex items-center space-x-2 cursor-pointer hover:bg-gray-100 p-2 rounded"
                            onClick={() => toggleFilePrompt(fileIndex, prompt.id!)}
                          >
                            {fileWithPrompts.selectedPromptIds.includes(prompt.id!) ? (
                              <CheckSquare className="w-4 h-4 text-blue-600" />
                            ) : (
                              <Square className="w-4 h-4 text-gray-400" />
                            )}
                            <span className="text-sm text-gray-700">{prompt.name}</span>
                            <span className="text-xs text-gray-500">
                              ({fileWithPrompts.selectedPromptIds.includes(prompt.id!) ? '選択中' : '未選択'})
                            </span>
                          </div>
                        ))}
                      </div>
                      {fileWithPrompts.selectedPromptIds.length === 0 && (
                        <p className="text-xs text-red-600 mt-2">
                          ⚠️ 最低1つのプロンプトを選択してください
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {selectedFiles.length > 0 && !isProcessing && processingStatuses.length === 0 && (
                <div className="mt-6 flex space-x-3">
                  <button
                    onClick={handleStartProcessing}
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

            {/* 進捗表示 */}
            {processingStatuses.length > 0 && (
              <div className="bg-white rounded-xl shadow-lg p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">
                  処理進捗 ({processingStatuses.filter(s => s.status === 'completed').length} / {processingStatuses.length})
                </h3>
                <div className="space-y-3">
                  {processingStatuses.map((status, index) => (
                    <div key={index} className="border rounded-lg p-4 bg-white shadow-sm">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {status.fileName}
                          </p>
                          {status.error && (
                            <p className="text-xs text-red-600 mt-1">
                              エラー: {status.error}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* 進捗表示 */}
                      <div className="space-y-2">
                        {/* 音声変換 */}
                        {status.phase === 'audio_conversion' && (
                          <div>
                            <p className="text-sm font-medium text-blue-800 mb-1">
                              音声変換: {status.audioConversionProgress}%
                            </p>
                            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                              <div
                                className="h-full bg-blue-600 transition-all duration-300"
                                style={{ width: `${status.audioConversionProgress}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {/* 文章生成中 */}
                        {status.phase === 'text_generation' && (
                          <div className="flex items-center space-x-3">
                            <Loader2 className="w-5 h-5 text-purple-600 animate-spin" />
                            <p className="text-sm font-medium text-purple-800">
                              文章生成中: {status.transcriptionCount}/{status.totalTranscriptions}
                            </p>
                          </div>
                        )}

                        {/* 完了 */}
                        {status.phase === 'completed' && (
                          <p className="text-sm font-medium text-green-800">
                            ✅ 完了
                          </p>
                        )}

                        {/* 待機中 */}
                        {status.phase === 'waiting' && status.isResuming && (
                          <p className="text-sm text-yellow-700">
                            🕐 音声変換待機中...（他のファイルの音声変換が終わり次第開始されます）
                          </p>
                        )}
                        {status.phase === 'waiting' && !status.isResuming && (
                          <p className="text-sm text-gray-500">待機中...</p>
                        )}

                        {/* エラー */}
                        {status.status === 'error' && !status.isResuming && (
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium text-red-800 mb-1">
                                ❌ エラーが発生しました
                                {status.failedPhase === 'audio_conversion' && ' (音声変換)'}
                                {status.failedPhase === 'text_generation' && ' (文書生成)'}
                              </p>
                              {status.completedPromptIds.length > 0 && (
                                <p className="text-xs text-green-600 mb-1">
                                  ✓ 完了: {status.completedPromptIds.length}/{status.totalTranscriptions} プロンプト
                                </p>
                              )}
                              {status.convertedAudioBlob && (
                                <p className="text-xs text-blue-600 mb-1">
                                  ✓ 音声変換済み（再開時はスキップされます）
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => handleResumeFile(index)}
                              disabled={status.isResuming}
                              className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-1"
                            >
                              <span>🔄</span>
                              <span>{status.isResuming ? '再開中...' : '再開'}</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
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

              {/* デバッグ用エラー注入コントロール */}
              {process.env.NODE_ENV === 'development' && (
                <div className="mt-4 bg-gradient-to-br from-red-50 to-orange-50 border border-red-300 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-red-900 mb-3">
                    🐛 デバッグモード
                  </h4>
                  <div className="space-y-3">
                    <div>
                      <label className="flex items-center space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={debugErrorMode.ffmpegError}
                          onChange={(e) => setDebugErrorMode(prev => ({ ...prev, ffmpegError: e.target.checked }))}
                          className="w-4 h-4 text-red-600"
                        />
                        <span className="text-xs text-red-800">FFmpegエラーを発生させる</span>
                      </label>
                    </div>
                    <div>
                      <label className="flex items-center space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={debugErrorMode.geminiError}
                          onChange={(e) => setDebugErrorMode(prev => ({ ...prev, geminiError: e.target.checked }))}
                          className="w-4 h-4 text-red-600"
                        />
                        <span className="text-xs text-red-800">Geminiエラーを発生させる</span>
                      </label>
                    </div>
                    <div>
                      <label className="block text-xs text-red-800 mb-1">
                        エラーを起こすファイル（インデックス）:
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={debugErrorMode.errorAtFileIndex}
                        onChange={(e) => setDebugErrorMode(prev => ({ ...prev, errorAtFileIndex: parseInt(e.target.value) || 0 }))}
                        className="w-full px-2 py-1 text-xs border border-red-300 rounded"
                      />
                    </div>
                    <p className="text-xs text-red-600 italic">
                      ※ 開発環境でのみ表示されます
                    </p>
                  </div>
                </div>
              )}
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

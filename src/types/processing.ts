export interface SegmentStatus {
    segmentIndex: number;
    startTime: number;
    endTime: number;
    status: 'pending' | 'converting' | 'completed' | 'error';
    progress: number; // 0-100: このセグメントの変換進捗
    audioBlob?: Blob;
    error?: string;
}

export interface FileProcessingStatus {
    fileName: string;
    status: 'waiting' | 'converting' | 'transcribing' | 'completed' | 'error';
    phase: 'waiting' | 'audio_conversion' | 'audio_concat' | 'text_generation' | 'completed';
    audioConversionProgress: number; // 音声変換の進捗（0-100）
    transcriptionCount: number; // 生成された文書数
    totalTranscriptions: number; // 生成予定の文書数
    error?: string;
    convertedAudioBlob?: Blob; // 変換済み音声データ（再開用）
    completedPromptIds: string[]; // 完了したプロンプトID（再開用）
    failedPhase?: 'audio_conversion' | 'text_generation'; // 失敗したフェーズ
    isResuming?: boolean; // 再開処理中かどうか

    // 区間管理用
    totalDuration?: number; // 動画の総時間（秒）
    segmentDuration: number; // 各区間の長さ（秒）、デフォルト30秒
    segments: SegmentStatus[]; // 区間ごとの状態
    completedSegmentIndices: number[]; // 完了した区間のインデックス
}

export interface FileWithPrompts {
    file: File;
    selectedPromptIds: string[];
}

export interface DebugErrorMode {
    ffmpegError: boolean;
    geminiError: boolean;
    errorAtFileIndex: number;
    errorAtSegmentIndex: number;
}


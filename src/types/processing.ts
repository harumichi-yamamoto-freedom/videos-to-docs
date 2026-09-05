import type { TranscribeProgressStage } from '@/lib/transcribeBatchContract';

export interface SegmentStatus {
    segmentIndex: number;
    startTime: number;
    endTime: number;
    status: 'pending' | 'converting' | 'completed' | 'error';
    progress: number; // 0-100: このセグメントの変換進捗
    audioBlob?: Blob;
    error?: string;
}

export type ProcessingPhase =
    | 'waiting'
    | 'video_analysis'
    | 'audio_conversion'
    | 'audio_concat'
    // 🎬 動画を直接送信する試験的機能用
    | 'direct_video_send'
    | 'uploading'
    | 'text_generation'
    | 'saving'
    /** 全文文字起こし（バッチ）の確認上限に達し、この画面での自動確認を止めている。失敗ではない */
    | 'awaiting_confirmation'
    | 'completed'
    | 'canceled';

export type ProcessingFailedPhase =
    | 'engine_init'
    | 'audio_conversion'
    | 'upload'
    | 'text_generation'
    | 'saving';

/** プロンプト単位の進行状態。生成と保存を分けて持つことで保存のみの再試行を可能にする */
export type PromptJobState =
    | 'pending'
    | 'generating'
    | 'saving'
    | 'saved'
    | 'failed'
    | 'canceled'
    /** バッチ提出済みで、完了の確認だけがこの画面で止まっている（仕様 §A4「確認待ち」） */
    | 'awaiting_confirmation';

/** 状態確認の状態。polling=確認中 / pending=上限で停止（確認待ち） / stopped=利用者が停止 / done=終端確定 */
export type BatchConfirmationState = 'polling' | 'pending' | 'stopped' | 'done';

/**
 * 全文文字起こし（非同期バッチ）の進捗（仕様 §A4）。
 * 🔴 音声変換の区間（segments）・生成件数とは別物。段階だけを持ち、%・チャンク数は持たない。
 */
export interface BatchTranscriptionProgress {
    jobId: string;
    docId: string;
    promptId: string;
    /** 最後に観測した表示段階。旧サーバ応答では更新されないことがある */
    stage?: TranscribeProgressStage;
    /** 有効な Azure 観測の鮮度（サーバ時刻・ms） */
    observedAtMs?: number;
    /** 最後に status 応答を受信したローカル時刻（ms） */
    lastCheckedAtMs?: number;
    confirmation: BatchConfirmationState;
}

export interface FileProcessingStatus {
    /** ファイルの同一性を表す不変ID。配列インデックスは追加・削除でずれるため参照に使わない */
    fileId: string;
    fileName: string;
    /** pending_confirmation: バッチの確認上限に達した「確認待ち」。error（失敗）と区別する */
    status: 'waiting' | 'converting' | 'transcribing' | 'pending_confirmation' | 'completed' | 'error' | 'canceled';
    phase: ProcessingPhase;
    audioConversionProgress: number; // 音声変換の進捗（0-100）
    transcriptionCount: number; // 保存が完了した文書数
    totalTranscriptions: number; // 生成予定の文書数
    error?: string;
    convertedAudioBlob?: Blob; // 変換済み音声データ（再開用）
    completedPromptIds: string[]; // 保存まで完了したプロンプトID（再開用）
    promptStates: Record<string, PromptJobState>; // プロンプト単位の状態
    savePendingPromptIds?: string[]; // 生成済みで保存だけが残っているプロンプトID
    failedPhase?: ProcessingFailedPhase; // 失敗したフェーズ
    isResuming?: boolean; // 再開処理中かどうか
    /** ジョブ開始時に固定した所有者UID。保存直前にこの値と現在のUIDを照合する */
    ownerUid?: string;
    /** 全文文字起こし（バッチ）を提出した後の進捗。提出前は無い */
    batch?: BatchTranscriptionProgress;

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

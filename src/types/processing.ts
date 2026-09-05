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

/**
 * 失敗の種別。今は「送るデータが上限を超えていた」だけを区別する。
 * 🔴 時間上限 (AZURE_BATCH_MAX_AUDIO_SEC) 超過はビットレートでは直らないので含めない。
 */
export type ProcessingFailureKind = 'too_large';

/**
 * サイズ超過で失敗したときの実測値。再変換の下げ先を決めるために失敗時点で控える。
 * 🔴 `wasConverted` が無いと「下げても効かない入力」を見分けられず、
 *    ビットレートを下げる提案が空振りする (2026-09-04 の実害と同じ形)。
 */
export interface SizeFailureMeasurement {
    /** 実際に送ろうとしたデータのバイト数 */
    bytes: number;
    /** そのとき使っていたビットレート ('96k' 形式) */
    bitrate: string;
    /** そのデータが変換由来か。false = 元ファイルをそのまま送っていた */
    wasConverted: boolean;
    /**
     * 実測できた音声の長さ（秒）。そのまま送られた入力の下げ先を見積もるのに使う。
     * 測れなかったときは無く、計画側が上界（4 時間）で見積もる。
     */
    durationSec?: number;
    /**
     * 🔴 **実際に破った**上限のバイト数。経路ごとに違うので必ず失敗時点で控える:
     *   - アップロード前ガード = GENERATE_MAX_MEDIA_BYTES (500MB・Storage 側)
     *   - 同期の文書生成の 413 = GENERATE_SYNC_MAX_MEDIA_BYTES (200MB・サーバのメモリ側)
     * 一律 500MB で見積もると、200MB で落ちた失敗に 200MB を超える下げ先を選んでしまう。
     */
    limitBytes: number;
}

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
    /**
     * 🔴 `convertedAudioBlob` を**実際に符号化したときの**ビットレート。
     *    画面のビットレート選択は全行で共有されるグローバル値なので、他の行の再試行で
     *    書き換わる。キャッシュを再利用した失敗にその値を記録すると、下げ先の計算が
     *    実在しない前提（例: 192k のデータを 64k 由来と誤認）で走る。
     *    そのまま送る経路（変換していない）では入れない。
     */
    convertedAudioBitrate?: string;
    completedPromptIds: string[]; // 保存まで完了したプロンプトID（再開用）
    promptStates: Record<string, PromptJobState>; // プロンプト単位の状態
    savePendingPromptIds?: string[]; // 生成済みで保存だけが残っているプロンプトID
    failedPhase?: ProcessingFailedPhase; // 失敗したフェーズ
    /** 失敗がサイズ由来か。'too_large' のときだけ「変換し直して再試行」を出す */
    failureKind?: ProcessingFailureKind;
    /** 'too_large' のときの実測値。下げ先の決定 (lib/retryBitrate) はここだけを読む */
    sizeFailure?: SizeFailureMeasurement;
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

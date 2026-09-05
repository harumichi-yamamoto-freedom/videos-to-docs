/**
 * クライアント ⇄ サーバの契約（非同期バッチ文字起こし）。
 * 提出は短命に返り、状態確認で完了を拾う。同期チャンク方式の `/api/transcribe/chunk` を置き換える。
 */

export const TRANSCRIBE_SUBMIT_PATH = '/api/transcribe/submit';
export const TRANSCRIBE_STATUS_PATH = '/api/transcribe/status';

/** 提出。音声は既に Storage にある前提（storagePath）。分割しない。 */
export interface TranscribeSubmitRequest {
    storagePath: string;
    fileName: string;
    mimeType: string;
    /** 音声長（秒）。クライアントの実測。Azure 上限（240分）判定に使う */
    audioSec: number;
    promptName: string;
    title?: string;
    /** 'audio' | 'video' */
    originalFileType: string;
}

export interface TranscribeSubmitResponse {
    jobId: string;
    /** 先に作られた「処理中」文書の ID。一覧に即出る */
    docId: string;
}

/** 既存の poll は jobId、文書を開いたときの再確定は docId を指定する。 */
export type TranscribeStatusRequest =
    | { jobId: string; docId?: never }
    | { docId: string; jobId?: never };

export type TranscribeJobPublicStatus = 'running' | 'succeeded' | 'failed';

/**
 * 表示専用の進捗段階（設計 §A1・2026-09-05）。公開 status（running/succeeded/failed）とは別物で、
 * 「今どの段階か」を利用者に見せるための派生値。🔴 Azure は進捗パーセントを返さないので段階のみ。
 * - checking: 受付済み・Azure の有効状態をまだ観測していない
 * - queued: 最後の観測が NotStarted（開始待ち）
 * - transcribing: 最後の観測が Running（文字起こし中）
 * - importing: Azure Succeeded を観測し、結果取り込み中（終端確定はまだ）
 * - completed / failed: サーバが文書とジョブを終端確定済み
 * 🔴 内部の finalizing は「取り込み中」ではない（開始待ちでも一時的に finalizing になる）。段階に使わない。
 */
export type TranscribeProgressStage =
    | 'checking' | 'queued' | 'transcribing' | 'importing' | 'completed' | 'failed';

/**
 * 文書に載せる小さな進捗投影（一覧が API 応答を待たずに段階を読めるようにする・設計 §A3）。
 * Firestore には stageObservedAt を Timestamp で保存し、クライアント読取境界で ms へ正規化する。
 */
export interface DocumentProcessingProgress {
    stage: TranscribeProgressStage;
    /** その段階を観測したサーバ時刻（ms）。最新照会時刻ではない */
    stageObservedAtMs?: number;
    /** 受付からの経過の近似起点（ジョブ作成時刻・ms） */
    jobCreatedAtMs?: number;
    /** 音声長（秒・概算含む）。推定残り時間の後続版で使う */
    audioSec?: number;
}

export interface TranscribeStatusResponse {
    status: TranscribeJobPublicStatus;
    docId: string;
    /** 失敗時のみ。利用者向けの短い理由 */
    error?: string;
    /** 表示段階（設計 §A1）。終端 status を優先。旧サーバ応答では欠落し得る */
    stage?: TranscribeProgressStage;
    /** 有効な Azure 観測の鮮度（ms）。HTTP 応答受信時刻とは区別する */
    azureStatusCheckedAtMs?: number;
    /** 既存 job の値を公開（受付からの経過推定に使う）。旧データ・不正値は省略 */
    createdAtMs?: number;
    audioSec?: number;
    /** 応答生成時刻（ms）。クライアント時計のずれを抑え、受信後はローカル経過を足す */
    serverNowMs?: number;
}

export interface TranscribeBatchErrorBody {
    error: string;
    message: string;
    retryAfterSec?: number;
}

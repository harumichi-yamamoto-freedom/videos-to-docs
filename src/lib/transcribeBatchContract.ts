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

export interface TranscribeStatusResponse {
    status: TranscribeJobPublicStatus;
    docId: string;
    /** 失敗時のみ。利用者向けの短い理由 */
    error?: string;
}

export interface TranscribeBatchErrorBody {
    error: string;
    message: string;
    retryAfterSec?: number;
}

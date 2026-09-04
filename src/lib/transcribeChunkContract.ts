/**
 * `POST /api/transcribe/chunk` の契約。型と定数だけ (実装は持たない)。
 *
 * 長時間音声を 25 分チャンクに割って文字起こしする経路 (設計 §3)。
 * 既存の `/api/generate` と違い、**1 リクエスト = 1 チャンク**で、
 * サーバはチャンクを跨いだ状態を持たない。分割と結合はクライアント側の責務。
 *
 * 🔴 `audioSec` と `speechSec` はクライアントが測って渡す。
 * サーバは元音声を持たないため自分では測れず、この 2 つが無いと品質ゲートの
 * G6 (過少出力) と G8 (カバレッジ) が判定できない。
 */
import type { TranscriptAnnotation } from '@/lib/transcriptQuality';
import type { QualityGateId } from '@/lib/transcriptQuality';
import type { TranscribeEngine } from '@/lib/maiTranscribeContract';

export const TRANSCRIBE_CHUNK_API_PATH = '/api/transcribe/chunk';

/** チャンク音声として受け付ける MIME (ブラウザ側の ffmpeg が mp3 に揃える) */
export const TRANSCRIBE_CHUNK_ALLOWED_MIME_PREFIXES = ['audio/'] as const;

/**
 * 1 チャンクの音声長の上限 (秒)。
 *
 * 公称上限は「話者分離・単語タイムスタンプ有効時は 30 分」(ai.google.dev)。
 * ⚠️ Vertex 側ドキュメントは 15 分と書いており**面で食い違っている**ため、上限に張り付けない。
 * 既定のチャンク長 25 分 + オーバーラップ 30 秒 = 25.5 分がこの上限の内側に入る。
 */
export const TRANSCRIBE_CHUNK_MAX_AUDIO_SEC = 29 * 60;

export interface TranscribeChunkRequestBody {
    /** Storage 上のチャンク音声 */
    storagePath: string;
    fileName: string;
    mimeType: string;
    /** このチャンクの音声長 (秒)。G8 (カバレッジ) の分母 */
    audioSec: number;
    /**
     * VAD (silencedetect / Silero VAD) で測った発話秒数。G6 の分母。
     * 🔴 「音声の長さ」ではない — 商談録音には移動・雑談・無音が実際に含まれ、
     * 音声長を分母にすると正常な静かな区間を誤検出する (設計 §4.1)。
     */
    speechSec: number;
    /**
     * VAD で測った**発話区間**。チャンク先頭を 0 とした `[開始秒, 終了秒]` の並び。
     *
     * 🔴 **G6 (最長穴) はこれが無いと走らない。** `speechSec` (総量) では代替できない —
     * 2026-09-04 の較正で、総量を分母に使う旧 G6 が**分母の側で壊れていた**ことが分かった (設計 §1.11)。
     * 区間で持てば「注釈が空いている連続区間」だけを見るので、VAD がノイズを拾っても判定が反転しない。
     */
    speechIntervals: Array<[number, number]>;
}

/** 送れる発話区間の上限。これを超える並びは分割が壊れている疑いがあるので弾く */
export const TRANSCRIBE_CHUNK_MAX_SPEECH_INTERVALS = 5000;

export interface TranscribeChunkQuality {
    /** fail が 0 件なら true (warn / indeterminate は合否に影響しない) */
    passed: boolean;
    failedGates: QualityGateId[];
    warnedGates: QualityGateId[];
    indeterminateGates: QualityGateId[];
}

export interface TranscribeChunkResponseBody {
    status: string;
    text: string;
    /** 🔴 ゲート・結合と同じ形に正規化済み (時刻が読めなかった注釈は落としてある) */
    annotations: TranscriptAnnotation[];
    quality: TranscribeChunkQuality;
    /**
     * 暗黙キャッシュのヒット量。
     * 🔴 0 でない走は「同じ結果を返しただけ」の可能性がある。測定・再試行の判断に使う (設計 §3.3)。
     */
    cachedTokens?: number;
    elapsedMs: number;
    /**
     * この本文を起こしたエンジン（設計 §3.7）。
     * 🔴 **用語集は MAI でしか効かない**ので、`gemini` に落ちた区間だけ用語の反映が弱い。
     * 黙って混ぜると、なぜその区間だけ表記が揺れるのかを後から追えなくなる。
     */
    engine: TranscribeEngine;
    /** MAI を試して落ちたときだけ入る短い理由。利用者向けの文言ではない */
    fallbackReason?: string;
}

/**
 * エラーは `/api/generate` と同じコード体系 (`GenerateApiError`) を使う。
 * クライアントは既存の受け方をそのまま流用できる。
 */
export type TranscribeChunkErrorBody = {
    error: string;
    message: string;
    retryAfterSec?: number;
};

/**
 * Azure Speech **Batch transcription** クライアント（非同期・設計 §3.7 改訂／2026-09-05 裁定）。
 *
 * 使い方は 3 手:
 *   1. `submitBatchJob(signedAudioUrl)` → `selfUrl`（ジョブの参照 URL）
 *   2. `getBatchJob(selfUrl)` を時々叩いて `status` を見る（`Succeeded`/`Failed` で確定）
 *   3. `fetchBatchResult(selfUrl)` → `parseBatchResult()` で注釈へ
 *
 * 🔴 Vercel の関数はこのファイルの各呼び出し**単位**で短命（提出も照会も数秒）。同期方式のように
 *    1 リクエストで 300 秒粘らない。だから Hobby の 300 秒上限に当たらない。
 * 🔴 実顧客の音声を扱う。ログにファイル名・本文・URL を残さない（件数・秒・status のみ）。
 */
import {
    AZURE_BATCH_SUBMIT_PATH,
    AZURE_BATCH_API_VERSION,
    AZURE_BATCH_API_KEY_HEADER,
    AZURE_BATCH_LOCALE,
    buildBatchProperties,
    type AzureBatchResult,
    type AzureBatchPhrase,
    type AzureBatchNBest,
} from '@/lib/azureBatchContract';
import type { TranscriptAnnotation } from '@/lib/transcribeApiContract';
import { GenerateApiError } from './errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('server/azureBatchTranscribe');

export interface AzureCredentials {
    endpoint: string;
    apiKey: string;
}

/** MAI 同期側と同じ環境変数を読む。無ければ null（設定漏れと障害を混同しない）。 */
export function getAzureCredentials(): AzureCredentials | null {
    const endpoint = process.env.AZURE_SPEECH_ENDPOINT?.trim();
    const apiKey = process.env.AZURE_SPEECH_KEY?.trim();
    if (!endpoint || !apiKey) return null;
    return { endpoint: endpoint.replace(/\/+$/, ''), apiKey };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * self URL は提出応答から来る（`?api-version=...` を**既に含む**ことがある）。
 * 🔴 二重に付けると 400/None になる（実測で poller が status=None を返し続けた原因）。
 * base（クエリ無し）から必要な派生 URL を組み立てる。
 */
const baseOf = (selfUrl: string): string => selfUrl.split('?')[0];
const withApiVersion = (url: string): string =>
    url.includes('api-version=') ? url : `${url}${url.includes('?') ? '&' : '?'}api-version=${AZURE_BATCH_API_VERSION}`;

async function azureFetch(
    url: string,
    credentials: AzureCredentials,
    init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { [AZURE_BATCH_API_KEY_HEADER]: credentials.apiKey };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = { raw: text.slice(0, 400) };
    }
    return { status: res.status, json };
}

export interface SubmitResult {
    /** ジョブの参照 URL。以後の照会・結果取得はここから派生させる */
    selfUrl: string;
}

/**
 * 音声（署名付き URL）を 1 本のバッチジョブとして投げる。**分割しない**。
 * 成功は 201 Created。返る `self` を保存すること。
 */
export async function submitBatchJob(
    signedAudioUrl: string,
    credentials: AzureCredentials,
    displayName = 'vtd-transcript',
): Promise<SubmitResult> {
    const url = `${credentials.endpoint}${AZURE_BATCH_SUBMIT_PATH}?api-version=${AZURE_BATCH_API_VERSION}`;
    const body = {
        contentUrls: [signedAudioUrl],
        locale: AZURE_BATCH_LOCALE,
        displayName,
        properties: buildBatchProperties(),
    };
    const { status, json } = await azureFetch(url, credentials, { method: 'POST', body });
    if (status !== 200 && status !== 201) {
        const rec = asRecord(json);
        const msg = str(asRecord(rec?.error)?.message) ?? str(rec?.message) ?? '';
        logger.warn('バッチ提出に失敗', { status, msg: msg.slice(0, 200) });
        throw new GenerateApiError('upstream_error', `文字起こしジョブの登録に失敗しました (${status})。`);
    }
    const selfUrl = str(asRecord(json)?.self);
    if (!selfUrl) throw new GenerateApiError('upstream_error', '文字起こしジョブの参照が取得できませんでした。');
    return { selfUrl };
}

export interface BatchJobState {
    status: string; // NotStarted | Running | Succeeded | Failed | (unknown)
    error?: string;
}

/** ジョブの現在状態を返す。🔴 self URL をそのまま使う（api-version を二重に付けない）。 */
export async function getBatchJob(selfUrl: string, credentials: AzureCredentials): Promise<BatchJobState> {
    const { status, json } = await azureFetch(withApiVersion(selfUrl), credentials);
    if (status !== 200) {
        throw new GenerateApiError('upstream_error', `文字起こしジョブの状態を取得できませんでした (${status})。`);
    }
    const rec = asRecord(json);
    const jobStatus = str(rec?.status) ?? 'unknown';
    const err = asRecord(rec?.properties)?.error;
    return {
        status: jobStatus,
        ...(err ? { error: JSON.stringify(err).slice(0, 300) } : {}),
    };
}

/** 成功したジョブの結果ファイル（kind==='Transcription'）を取得する。 */
export async function fetchBatchResult(selfUrl: string, credentials: AzureCredentials): Promise<AzureBatchResult> {
    const filesUrl = `${baseOf(selfUrl)}/files?api-version=${AZURE_BATCH_API_VERSION}`;
    const { status, json } = await azureFetch(filesUrl, credentials);
    if (status !== 200) {
        throw new GenerateApiError('upstream_error', `文字起こし結果の一覧を取得できませんでした (${status})。`);
    }
    const values = asRecord(json)?.values;
    const list = Array.isArray(values) ? values : [];
    let contentUrl: string | undefined;
    for (const f of list) {
        const rec = asRecord(f);
        if (str(rec?.kind) === 'Transcription') {
            contentUrl = str(asRecord(rec?.links)?.contentUrl);
            break;
        }
    }
    if (!contentUrl) throw new GenerateApiError('upstream_error', '文字起こし結果ファイルが見つかりませんでした。');
    // 結果ファイルは SAS 付きの一時 URL。鍵ヘッダは不要。
    const res = await fetch(contentUrl);
    if (!res.ok) throw new GenerateApiError('upstream_error', `文字起こし結果を取得できませんでした (${res.status})。`);
    return (await res.json()) as AzureBatchResult;
}

/** ジョブと結果ファイルを削除する（TTL でも消えるが、取り終えたら即消す）。失敗は無視。 */
export async function deleteBatchJob(selfUrl: string, credentials: AzureCredentials): Promise<void> {
    try {
        await azureFetch(withApiVersion(selfUrl), credentials, { method: 'DELETE' });
    } catch (error) {
        logger.warn('バッチジョブの削除に失敗（TTL に任せる）', {
            reason: error instanceof Error ? error.message : String(error),
        });
    }
}

export interface ParsedBatch {
    status: 'completed';
    text: string;
    annotations: TranscriptAnnotation[];
    audioSec: number;
    speakers: number;
    /** 単語時刻は落とした語も数える（黙って減らさない） */
    droppedPhrases: number;
}

/**
 * バッチ結果を注釈モデルへ。**句（recognizedPhrases）単位**で 1 注釈にする。
 * 🔴 単語全部を注釈にすると 2 時間で ~15,000 語になり Firestore の 1 MiB ドキュメント上限に当たる。
 *    UI は段落先頭に時刻リンクを張る方式なので、句単位で十分（設計 §6.4・データモデルの注意）。
 * 🔴 時刻が読めなかった句は落とし、件数を返す（0 埋めでカバレッジを偽らない）。
 */
export function parseBatchResult(result: AzureBatchResult): ParsedBatch {
    const audioSec = (num(result.durationMilliseconds) ?? 0) / 1000;
    const phrases = Array.isArray(result.recognizedPhrases)
        ? (result.recognizedPhrases as AzureBatchPhrase[])
        : [];

    const annotations: TranscriptAnnotation[] = [];
    const speakerSet = new Set<string>();
    let droppedPhrases = 0;

    for (const phrase of phrases) {
        const offsetMs = num(phrase.offsetMilliseconds);
        const durationMs = num(phrase.durationMilliseconds);
        if (offsetMs === undefined || durationMs === undefined) {
            droppedPhrases += 1;
            continue;
        }
        const nBest = Array.isArray(phrase.nBest) ? (phrase.nBest[0] as AzureBatchNBest | undefined) : undefined;
        const text = str(nBest?.display) ?? '';
        const speaker = num(phrase.speaker);
        const speakerLabel = speaker !== undefined ? `spk:${speaker}` : null;
        if (speakerLabel) speakerSet.add(speakerLabel);
        annotations.push({
            text,
            startSec: offsetMs / 1000,
            endSec: (offsetMs + durationMs) / 1000,
            speaker: speakerLabel,
        });
    }

    // 本文は combinedRecognizedPhrases があればそれ、無ければ句を連結
    const combined = Array.isArray(result.combinedRecognizedPhrases)
        ? (result.combinedRecognizedPhrases as unknown[])
        : [];
    const combinedText = combined
        .map((c) => str(asRecord(c)?.display))
        .filter((t): t is string => typeof t === 'string')
        .join('\n');
    const text = combinedText || annotations.map((a) => a.text ?? '').join('\n');

    return {
        status: 'completed',
        text,
        annotations,
        audioSec,
        speakers: speakerSet.size,
        droppedPhrases,
    };
}

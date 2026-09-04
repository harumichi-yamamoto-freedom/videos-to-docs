/**
 * `MAI-Transcribe-2` (Azure Speech) でチャンク 1 本を文字起こしする。
 *
 * 🔴 **戻り値は Gemini 側 (`TranscribeChunkResult`) と同じ形に正規化する。**
 * 品質ゲート (§4.1) は両エンジンの出力に**同じもの**を当てる決まりで (設計 §3.7)、
 * ゲートをエンジンごとに分けると片方だけ検査が緩いという事故が起きる。
 *
 * MAI の出力は `phrases[].words[].offsetMilliseconds`、Gemini は
 * `annotations[].start_offset` (`"3.900s"`) と形が違うので、差はここで吸収する。
 */
import {
    MAI_API_KEY_HEADER,
    MAI_API_VERSION,
    MAI_LOCALES,
    MAI_MAX_AUDIO_BYTES,
    MAI_MODEL,
    MAI_REQUEST_TIMEOUT_MS,
    MAI_TIMESTAMPS,
    MAI_TRANSCRIBE_PATH,
    MAI_TRANSCRIBE_STYLE,
    type MaiPhrase,
    type MaiWord,
} from '@/lib/maiTranscribeContract';
import type { TranscribeChunkResult, TranscriptAnnotation } from '@/lib/transcribeApiContract';
import { createLogger } from '@/lib/logger';
import { GenerateApiError } from './errors';

const logger = createLogger('server/maiTranscribe');

export interface MaiCredentials {
    endpoint: string;
    apiKey: string;
}

/**
 * 資格情報。**無ければ null を返す** — 例外にしない。
 * 🔴 MAI は preview なので「設定されていない」ことが正常な運用状態でありうる。
 * その場合は Gemini だけで動く (設計 §3.7 のフォールバック)。
 */
export function getMaiCredentials(): MaiCredentials | null {
    const endpoint = process.env.AZURE_SPEECH_ENDPOINT?.trim();
    const apiKey = process.env.AZURE_SPEECH_KEY?.trim();
    if (!endpoint || !apiKey) return null;
    return { endpoint: endpoint.replace(/\/+$/, ''), apiKey };
}

/** `definition` は 1 か所でしか組み立てない。リテラルを散らさない */
export function buildMaiDefinition(phrases: readonly string[] = []): Record<string, unknown> {
    const definition: Record<string, unknown> = {
        enhancedMode: {
            enabled: true,
            model: MAI_MODEL,
            modelOptions: { timestamps: MAI_TIMESTAMPS, transcribeStyle: MAI_TRANSCRIBE_STYLE },
        },
        diarization: { enabled: true },
        locales: [...MAI_LOCALES],
    };
    // 🔴 空配列を送らない。用語集を使わない構成と「空の用語集」を区別できなくする
    if (phrases.length > 0) definition.phraseList = { phrases: [...phrases] };
    return definition;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
const asNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * `phrases[].words[]` を共通形の注釈へ。
 *
 * 🔴 話者は**句**に付き、語には付かない。句の話者を語へ配る。
 * 🔴 時刻が読めない語は**落とす。0 で埋めない** — 埋めると G6 (最長穴) が
 *    「冒頭に注釈がある」と誤認して穴を短く見積もる。
 */
export function normalizeMaiPhrases(rawPhrases: unknown): {
    annotations: TranscriptAnnotation[];
    droppedWords: number;
    speakers: number;
} {
    const annotations: TranscriptAnnotation[] = [];
    const speakers = new Set<string>();
    let droppedWords = 0;
    for (const item of Array.isArray(rawPhrases) ? rawPhrases : []) {
        const phrase = asRecord(item) as MaiPhrase | undefined;
        if (!phrase) continue;
        const speakerRaw = phrase.speaker;
        // 話者は 0 始まりの数値で返る。Gemini 側の `spk:0` と表記を揃える
        const speaker =
            typeof speakerRaw === 'number' && Number.isFinite(speakerRaw)
                ? `spk:${speakerRaw}`
                : typeof speakerRaw === 'string' && speakerRaw !== ''
                    ? speakerRaw
                    : null;
        if (speaker) speakers.add(speaker);
        for (const wordItem of Array.isArray(phrase.words) ? phrase.words : []) {
            const word = asRecord(wordItem) as MaiWord | undefined;
            if (!word) { droppedWords += 1; continue; }
            const offsetMs = asNumber(word.offsetMilliseconds);
            const durationMs = asNumber(word.durationMilliseconds);
            if (offsetMs === undefined || durationMs === undefined) { droppedWords += 1; continue; }
            annotations.push({
                text: typeof word.text === 'string' ? word.text : '',
                startSec: offsetMs / 1000,
                endSec: (offsetMs + durationMs) / 1000,
                speaker,
            });
        }
    }
    return { annotations, droppedWords, speakers: speakers.size };
}

/** `combinedPhrases[].text` を連結。無ければ `phrases[].text` から組む */
export function extractMaiText(response: Record<string, unknown>): string {
    const combined = response.combinedPhrases;
    if (Array.isArray(combined)) {
        const parts = combined
            .map(item => asRecord(item)?.text)
            .filter((t): t is string => typeof t === 'string');
        if (parts.length > 0) return parts.join(' ');
    }
    const phrases = response.phrases;
    if (Array.isArray(phrases)) {
        return phrases
            .map(item => asRecord(item)?.text)
            .filter((t): t is string => typeof t === 'string')
            .join(' ');
    }
    return '';
}

export interface MaiTranscribeInput {
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    audioSec: number;
    /** 用語集 (キーワードバイアス)。🔴 Gemini では渡せない — MAI だけの機能 (§1.5 / §3.7) */
    phraseList?: readonly string[];
}

export class MaiTranscribeClient {
    constructor(private readonly credentials: MaiCredentials) {}

    async transcribe(input: MaiTranscribeInput): Promise<TranscribeChunkResult> {
        if (input.bytes.byteLength > MAI_MAX_AUDIO_BYTES) {
            throw new GenerateApiError(
                'media_too_large',
                `音声が MAI の上限 (${Math.floor(MAI_MAX_AUDIO_BYTES / 1024 / 1024)}MB) を超えています。`,
            );
        }
        const definition = buildMaiDefinition(input.phraseList ?? []);
        const form = new FormData();
        form.append('definition', JSON.stringify(definition));
        form.append(
            'audio',
            new Blob([input.bytes as unknown as BlobPart], { type: input.mimeType }),
            input.fileName,
        );

        const url = `${this.credentials.endpoint}${MAI_TRANSCRIBE_PATH}?api-version=${MAI_API_VERSION}`;
        const controller = new AbortController();
        // 🔴 サーバ側の約 120 秒より **手前で** 諦める。向こうに切られると 408 が返るだけで、
        //    こちらの再試行・フォールバックの判断が 1 往復ぶん遅れる。
        const timer = setTimeout(() => controller.abort(), MAI_REQUEST_TIMEOUT_MS);
        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { [MAI_API_KEY_HEADER]: this.credentials.apiKey },
                body: form,
                signal: controller.signal,
            });
        } catch (error) {
            const aborted = error instanceof Error && error.name === 'AbortError';
            throw new GenerateApiError(
                aborted ? 'upstream_timeout' : 'upstream_error',
                aborted
                    ? `MAI が ${MAI_REQUEST_TIMEOUT_MS / 1000} 秒以内に応答しませんでした。`
                    : 'MAI へ接続できませんでした。',
                { cause: error },
            );
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const body = (await response.text()).slice(0, 400);
            // 実測した preview 固有の失敗: 408 Timeout / 503 diarization_unavailable / 500 / 接続断
            logger.warn('MAI が失敗を返した', { status: response.status, body });
            throw new GenerateApiError('upstream_error', `MAI がエラーを返しました (${response.status})。`);
        }

        const parsed = asRecord(await response.json());
        if (!parsed) {
            throw new GenerateApiError('upstream_error', 'MAI の応答を解釈できませんでした。');
        }
        const { annotations, droppedWords, speakers } = normalizeMaiPhrases(parsed.phrases);
        const text = extractMaiText(parsed);
        logger.info('MAI で文字起こし', {
            chars: text.length, annotations: annotations.length, droppedWords, speakers,
            audioSec: input.audioSec,
        });
        return {
            // MAI は成否を HTTP で返し、部分成功の状態を持たない。
            // ゲートの G1 は `completed` 以外を落とすので、成功した応答はここで `completed` に揃える。
            status: 'completed',
            text,
            annotations,
            audioSec: input.audioSec,
            transport: 'mai_multipart',
        };
    }
}

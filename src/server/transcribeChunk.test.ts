import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    TRANSCRIBE_INTERACTIONS_URL,
    TRANSCRIBE_MODEL,
} from '@/lib/transcribeApiContract';

const doubles = vi.hoisted(() => ({
    filesUpload: vi.fn(),
    filesGet: vi.fn(),
    filesDelete: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@google/genai', () => ({
    ThinkingLevel: { LOW: 'SDK_LOW', MEDIUM: 'SDK_MEDIUM', HIGH: 'SDK_HIGH' },
    GoogleGenAI: class {
        models = { generateContent: vi.fn() };
        files = { upload: doubles.filesUpload, get: doubles.filesGet, delete: doubles.filesDelete };
    },
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => doubles.logger }));

import {
    TranscribeChunkClient,
    buildTranscribeRequest,
    extractOutputTokens,
    parseOffsetSeconds,
    parseTranscribeResponse,
} from './transcribeChunk';
import { GenerateApiError } from './errors';

const ACTIVE_FILE = {
    name: 'files/abc',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
    mimeType: 'audio/mpeg',
    state: 'ACTIVE',
};

/** 実測の応答を縮めたもの。本文・注釈・usage の形はそのまま */
const OK_PAYLOAD = {
    status: 'completed',
    steps: [{
        content: [{
            text: 'こんにちは、今日は銀行の話をします。',
            annotations: [
                {
                    start_index: 21, end_index: 27, text: '銀行',
                    start_offset: '3.900s', end_offset: '4.200s',
                    speaker: 'spk:0', type: 'word_info',
                },
            ],
        }],
    }],
    usage: {
        total_output_tokens: 0,
        total_cached_tokens: 1234,
        model_invocation_token_counts: [{
            candidates_tokens_details: [
                { modality: 'text', tokenCount: 900 },
                { modality: 'audio', tokenCount: 5000 },
                { modality: 'text', tokenCount: 100 },
            ],
        }],
    },
};

const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
}) as unknown as Response;

const makeClient = (fetchImpl: ReturnType<typeof vi.fn>) =>
    new TranscribeChunkClient({ apiKey: 'server-key', fetchImpl: fetchImpl as unknown as typeof fetch });

const input = { bytes: Buffer.from('mp3-bytes'), mimeType: 'audio/mpeg', fileName: 'chunk-01.mp3' };

beforeEach(() => {
    vi.clearAllMocks();
    doubles.filesUpload.mockResolvedValue(ACTIVE_FILE);
    doubles.filesDelete.mockResolvedValue(undefined);
});

describe('buildTranscribeRequest — silent fail-open する値を 1 か所に固定する', () => {
    const body = buildTranscribeRequest('files/uri', 'audio/mpeg');

    it('実測で通るリクエストの形と完全一致する', () => {
        expect(body).toEqual({
            model: 'gemini-3.5-transcribe',
            input: [{ type: 'audio', uri: 'files/uri', mime_type: 'audio/mpeg' }],
            generation_config: {
                transcription_config: {
                    language_codes: ['ja-JP'],
                    mode: {
                        type: 'verbatim',
                        diarization_mode: 'speaker',
                        timestamp_granularities: ['word'],
                    },
                },
            },
        });
    });

    it('🔴 mode.type がある (無いと 400)', () => {
        expect(body.generation_config.transcription_config.mode.type).toBe('verbatim');
    });

    it('🔴 type を transcription_config 直下に置かない (置くと Unknown parameter で 400)', () => {
        expect(body.generation_config.transcription_config).not.toHaveProperty('type');
    });

    it('🔴 diarization_mode / timestamp_granularities の綴りを固定する (誤りは 400 でなく 200 + 空の注釈)', () => {
        expect(body.generation_config.transcription_config.mode.diarization_mode).toBe('speaker');
        expect(body.generation_config.transcription_config.mode.timestamp_granularities).toEqual(['word']);
    });

    it('実装は contract の定数だけを綴り、テストとは別経路で値が来る', () => {
        expect(TRANSCRIBE_MODEL).toBe(body.model);
    });
});

describe('parseOffsetSeconds', () => {
    it('"3.900s" を秒に直す', () => {
        expect(parseOffsetSeconds('3.900s')).toBe(3.9);
        expect(parseOffsetSeconds('0s')).toBe(0);
        expect(parseOffsetSeconds('12')).toBe(12);
    });
    it('読めない値は undefined (0 に丸めない)', () => {
        expect(parseOffsetSeconds('abc')).toBeUndefined();
        expect(parseOffsetSeconds(undefined)).toBeUndefined();
        expect(parseOffsetSeconds(null)).toBeUndefined();
    });
});

describe('extractOutputTokens — 🔴 total_output_tokens を見ない', () => {
    it('total_output_tokens が 0 でも明細から合計を取る (複数要素を足す)', () => {
        expect(extractOutputTokens(OK_PAYLOAD.usage)).toBe(1000);
    });

    it('text 以外の modality は数えない', () => {
        expect(extractOutputTokens({
            total_output_tokens: 0,
            model_invocation_token_counts: [{ candidates_tokens_details: [{ modality: 'audio', tokenCount: 5000 }] }],
        })).toBe(0);
    });

    it('呼び出しが複数に割れていても全部足す', () => {
        expect(extractOutputTokens({
            model_invocation_token_counts: [
                { candidates_tokens_details: [{ modality: 'text', tokenCount: 300 }] },
                { candidates_tokens_details: [{ modality: 'text', tokenCount: 700 }] },
            ],
        })).toBe(1000);
    });

    it('model_invocation_token_counts が無ければ undefined (0 に丸めない)', () => {
        expect(extractOutputTokens({ total_output_tokens: 0, total_cached_tokens: 5 })).toBeUndefined();
        expect(extractOutputTokens(undefined)).toBeUndefined();
    });

    it('明細そのものが 1 つも無ければ undefined', () => {
        expect(extractOutputTokens({ model_invocation_token_counts: [{}] })).toBeUndefined();
    });
});

describe('parseTranscribeResponse', () => {
    it('本文・注釈・秒変換・cachedTokens を取り出す', () => {
        expect(parseTranscribeResponse(OK_PAYLOAD)).toEqual({
            status: 'completed',
            text: 'こんにちは、今日は銀行の話をします。',
            annotations: [{
                startIndex: 21, endIndex: 27, text: '銀行',
                startSec: 3.9, endSec: 4.2, speaker: 'spk:0', type: 'word_info',
            }],
            audioSec: 4.2,
            outputTokens: 1000,
            cachedTokens: 1234,
            transport: 'files_api',
        });
    });

    it('audioSec は呼び出し側の指定を優先する', () => {
        expect(parseTranscribeResponse(OK_PAYLOAD, 1500).audioSec).toBe(1500);
    });

    it('content が複数に割れたら注釈の index を連結後の本文に合わせてずらす', () => {
        const result = parseTranscribeResponse({
            status: 'completed',
            steps: [{
                content: [
                    { text: 'ABCDE', annotations: [{ start_index: 0, end_index: 5, text: 'ABCDE' }] },
                    { text: 'FGHIJ', annotations: [{ start_index: 0, end_index: 5, text: 'FGHIJ' }] },
                ],
            }],
        });
        expect(result.text).toBe('ABCDEFGHIJ');
        expect(result.annotations.map(a => [a.startIndex, a.endIndex])).toEqual([[0, 5], [5, 10]]);
    });

    it('話者が null でもそのまま通す (silent fail-open を潰さない)', () => {
        const result = parseTranscribeResponse({
            steps: [{ content: [{ text: 'あ', annotations: [{ text: 'あ', speaker: null }] }] }],
        });
        expect(result.annotations[0].speaker).toBeNull();
    });

    it('注釈 0 件・本文空・status incomplete をそのまま返す (例外にしない)', () => {
        expect(parseTranscribeResponse({ status: 'incomplete', steps: [{ content: [{ text: '' }] }] })).toEqual({
            status: 'incomplete', text: '', annotations: [], transport: 'files_api',
        });
    });

    it('status が無ければ unknown・usage が無ければトークンは undefined', () => {
        const result = parseTranscribeResponse({ steps: [] });
        expect(result.status).toBe('unknown');
        expect(result.outputTokens).toBeUndefined();
        expect(result.cachedTokens).toBeUndefined();
        expect(result.audioSec).toBeUndefined();
    });
});

describe('TranscribeChunkClient.transcribe', () => {
    it('Files API へ上げ、uri でリクエストし、終わったら削除する', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(OK_PAYLOAD));
        const result = await makeClient(fetchImpl).transcribe({ ...input, audioSec: 1500 });

        expect(doubles.filesUpload).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
        expect(url).toBe(TRANSCRIBE_INTERACTIONS_URL);
        expect(init.method).toBe('POST');
        expect(init.headers['x-goog-api-key']).toBe('server-key');
        expect(JSON.parse(init.body as string)).toEqual(buildTranscribeRequest(ACTIVE_FILE.uri, 'audio/mpeg'));

        expect(result.text).toBe('こんにちは、今日は銀行の話をします。');
        expect(result.annotations[0]).toMatchObject({ startSec: 3.9, endSec: 4.2, speaker: 'spk:0' });
        expect(result.outputTokens).toBe(1000);
        expect(result.cachedTokens).toBe(1234);
        expect(result.audioSec).toBe(1500);
        expect(result.transport).toBe('files_api');
        expect(doubles.filesDelete).toHaveBeenCalledWith({ name: 'files/abc' });
    });

    it('🔴 total_output_tokens が 0 でも outputTokens が 0 にならない (G1 の発火条件)', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(OK_PAYLOAD));
        const result = await makeClient(fetchImpl).transcribe(input);
        expect(result.outputTokens).toBe(1000);
    });

    it('明細が無ければ outputTokens は undefined のまま返る', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
            ...OK_PAYLOAD, usage: { total_output_tokens: 0, total_cached_tokens: 0 },
        }));
        const result = await makeClient(fetchImpl).transcribe(input);
        expect(result.outputTokens).toBeUndefined();
        expect(result.cachedTokens).toBe(0);
    });

    it('status incomplete / 注釈 0 件をそのまま呼び出し側へ渡す', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
            status: 'incomplete', steps: [{ content: [{ text: '途中まで', annotations: [] }] }],
        }));
        const result = await makeClient(fetchImpl).transcribe(input);
        expect(result.status).toBe('incomplete');
        expect(result.annotations).toEqual([]);
        expect(result.text).toBe('途中まで');
    });

    it('空のチャンクは 400 invalid_request (Files API を叩かない)', async () => {
        const fetchImpl = vi.fn();
        await expect(makeClient(fetchImpl).transcribe({ ...input, bytes: Buffer.alloc(0) }))
            .rejects.toMatchObject({ code: 'invalid_request', status: 400 });
        expect(doubles.filesUpload).not.toHaveBeenCalled();
    });

    it('Files API のアップロード失敗は GenerateApiError に写り、fetch まで行かない', async () => {
        doubles.filesUpload.mockRejectedValue(new Error('PERMISSION_DENIED: files.upload'));
        const fetchImpl = vi.fn();
        await expect(makeClient(fetchImpl).transcribe(input))
            .rejects.toMatchObject({ code: 'upstream_error', status: 502 });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(doubles.filesDelete).not.toHaveBeenCalled();
    });

    it('ACTIVE 待ちのタイムアウトは 504 upstream_timeout', async () => {
        doubles.filesUpload.mockResolvedValue({ ...ACTIVE_FILE, state: 'PROCESSING' });
        doubles.filesGet.mockResolvedValue({ ...ACTIVE_FILE, state: 'PROCESSING' });
        let clock = 0;
        const client = new TranscribeChunkClient({
            apiKey: 'server-key',
            fetchImpl: vi.fn() as unknown as typeof fetch,
            pollIntervalMs: 0,
            activationTimeoutMs: 10,
            now: () => (clock += 100),
        });
        await expect(client.transcribe(input)).rejects.toMatchObject({ code: 'upstream_timeout', status: 504 });
    });

    it('非 2xx は本文を利用者に出さず GenerateApiError にする。上げたファイルは消す', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: false, status: 429,
            text: async () => 'RESOURCE_EXHAUSTED: quota',
            json: async () => ({}),
        } as unknown as Response);
        const error = await makeClient(fetchImpl).transcribe(input).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GenerateApiError);
        expect(error).toMatchObject({ code: 'upstream_error', status: 502 });
        expect((error as Error).message).not.toContain('RESOURCE_EXHAUSTED');
        expect(doubles.filesDelete).toHaveBeenCalledWith({ name: 'files/abc' });
    });

    it('fetch のタイムアウトは 504 upstream_timeout に写る', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout'));
        await expect(makeClient(fetchImpl).transcribe(input))
            .rejects.toMatchObject({ code: 'upstream_timeout', status: 504 });
        expect(doubles.filesDelete).toHaveBeenCalledWith({ name: 'files/abc' });
    });
});

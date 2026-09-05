import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GEMINI_MODEL } from '@/constants/geminiModels';
import { INLINE_REQUEST_BUDGET_BYTES } from '@/lib/inlineMediaBudget';

const doubles = vi.hoisted(() => ({
    generateContent: vi.fn(),
    filesUpload: vi.fn(),
    filesGet: vi.fn(),
    filesDelete: vi.fn(),
    ctorArgs: [] as unknown[],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@google/genai', () => ({
    ThinkingLevel: { LOW: 'SDK_LOW', MEDIUM: 'SDK_MEDIUM', HIGH: 'SDK_HIGH' },
    GoogleGenAI: class {
        models = { generateContent: doubles.generateContent };
        files = { upload: doubles.filesUpload, get: doubles.filesGet, delete: doubles.filesDelete };
        constructor(args: unknown) { doubles.ctorArgs.push(args); }
    },
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => doubles.logger }));

import { GeminiServerClient, classifyGeminiError, getGeminiApiKey } from './geminiServer';
import { GenerateApiError } from './errors';

/** base64 長が予算を超える最小のバイト数 (+1 で files_api 側に落ちる) */
const BYTES_OVER_BUDGET = Math.floor((INLINE_REQUEST_BUDGET_BYTES * 3) / 4) + 4;

const prompt = { name: 'p', content: 'テスト用プロンプト', model: 'default', thinkingLevel: 'default' as const };

const env = { ...process.env };
beforeEach(() => {
    vi.clearAllMocks();
    doubles.ctorArgs.length = 0;
    process.env.GEMINI_API_KEY = 'server-key';
    doubles.generateContent.mockResolvedValue({
        text: '# 文書',
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35 },
    });
});
afterEach(() => { process.env = { ...env }; });

describe('getGeminiApiKey', () => {
    it('GEMINI_API_KEY が無ければ 503 not_configured (NEXT_PUBLIC_ は見ない)', () => {
        delete process.env.GEMINI_API_KEY;
        process.env.NEXT_PUBLIC_GEMINI_API_KEY = 'browser-key';
        expect(() => getGeminiApiKey()).toThrow(expect.objectContaining({ code: 'not_configured', status: 503 }));
        expect(() => new GeminiServerClient()).toThrow(GenerateApiError);
    });
    it('空白だけも未設定扱い', () => {
        process.env.GEMINI_API_KEY = '   ';
        expect(() => getGeminiApiKey()).toThrow(GenerateApiError);
    });
    it('SDK にはサーバのキーを渡す', () => {
        new GeminiServerClient();
        expect(doubles.ctorArgs).toEqual([{ apiKey: 'server-key' }]);
    });
});

describe('GeminiServerClient.generate — inline', () => {
    it('予算内は inlineData で送り、センチネル解決・thinkingLevel・usage を返す', async () => {
        const client = new GeminiServerClient();
        const bytes = Buffer.from('audio-bytes');
        const result = await client.generate({ bytes, mimeType: 'audio/mpeg', fileName: 'a.mp3', prompt });

        expect(result).toEqual({
            text: '# 文書',
            usedModel: DEFAULT_GEMINI_MODEL,
            thinkingLevel: 'MEDIUM',
            transport: 'inline',
            usage: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35 },
        });
        expect(doubles.filesUpload).not.toHaveBeenCalled();
        expect(doubles.generateContent).toHaveBeenCalledWith({
            model: DEFAULT_GEMINI_MODEL,
            config: { thinkingConfig: { thinkingLevel: 'SDK_MEDIUM' } },
            contents: [{
                role: 'user',
                parts: [
                    { text: 'テスト用プロンプト' },
                    { inlineData: { mimeType: 'audio/mpeg', data: bytes.toString('base64') } },
                ],
            }],
        });
        expect(doubles.logger.info).toHaveBeenCalledWith('Gemini API usage', expect.objectContaining({
            model: DEFAULT_GEMINI_MODEL, thinkingLevel: 'MEDIUM', totalTokenCount: 35,
        }));
    });

    it('thinkingLevel 非対応モデルは config を付けず unspecified', async () => {
        const client = new GeminiServerClient();
        const result = await client.generate({
            bytes: Buffer.from('x'), mimeType: 'audio/mpeg', fileName: 'a.mp3',
            prompt: { ...prompt, model: 'gemini-2.5-flash', thinkingLevel: 'high' },
        });
        expect(result.usedModel).toBe('gemini-2.5-flash');
        expect(result.thinkingLevel).toBe('unspecified');
        expect(doubles.generateContent.mock.calls[0][0]).not.toHaveProperty('config');
    });

    it('high は SDK_HIGH、video の MIME はそのまま渡し、空プロンプトは動画用既定文', async () => {
        const client = new GeminiServerClient();
        await client.generate({
            bytes: Buffer.from('x'), mimeType: 'video/mp4', fileName: 'v.mp4',
            prompt: { ...prompt, content: '', thinkingLevel: 'high' },
        });
        const call = doubles.generateContent.mock.calls[0][0];
        expect(call.config).toEqual({ thinkingConfig: { thinkingLevel: 'SDK_HIGH' } });
        expect(call.contents[0].parts[0].text).toContain('動画ファイルの内容');
        expect(call.contents[0].parts[1].inlineData.mimeType).toBe('video/mp4');
    });

    it('空バイトは 400 invalid_request で API を呼ばない', async () => {
        const client = new GeminiServerClient();
        await expect(client.generate({ bytes: Buffer.alloc(0), mimeType: 'audio/mpeg', fileName: 'a.mp3', prompt }))
            .rejects.toMatchObject({ code: 'invalid_request' });
        expect(doubles.generateContent).not.toHaveBeenCalled();
    });

    it('text 無しは空文字', async () => {
        doubles.generateContent.mockResolvedValue({});
        const client = new GeminiServerClient();
        const result = await client.generate({ bytes: Buffer.from('x'), mimeType: 'audio/mpeg', fileName: 'a.mp3', prompt });
        expect(result.text).toBe('');
        expect(result.usage).toEqual({});
    });
});

describe('GeminiServerClient.generate — files_api', () => {
    const bigBytes = Buffer.alloc(BYTES_OVER_BUDGET, 1);

    it('予算超は upload → ACTIVE 待ち → fileData で生成 → 削除', async () => {
        doubles.filesUpload.mockResolvedValue({ name: 'files/abc', state: 'PROCESSING' });
        doubles.filesGet.mockResolvedValue({ name: 'files/abc', state: 'ACTIVE', uri: 'https://files/abc', mimeType: 'video/mp4' });
        doubles.filesDelete.mockResolvedValue(undefined);

        const client = new GeminiServerClient({ pollIntervalMs: 0 });
        const result = await client.generate({ bytes: bigBytes, mimeType: 'video/mp4', fileName: 'big.mp4', prompt });

        expect(result.transport).toBe('files_api');
        expect(doubles.filesUpload).toHaveBeenCalledTimes(1);
        const uploadArg = doubles.filesUpload.mock.calls[0][0];
        expect(uploadArg.config).toEqual({ mimeType: 'video/mp4', displayName: 'big.mp4' });
        expect(uploadArg.file).toBeInstanceOf(Blob);
        expect((uploadArg.file as Blob).size).toBe(BYTES_OVER_BUDGET);
        expect(doubles.filesGet).toHaveBeenCalledWith({ name: 'files/abc' });
        expect(doubles.generateContent.mock.calls[0][0].contents[0].parts[1])
            .toEqual({ fileData: { fileUri: 'https://files/abc', mimeType: 'video/mp4' } });
        expect(doubles.filesDelete).toHaveBeenCalledWith({ name: 'files/abc' });
    });

    it('🔴 files_api 経路ではバッファ全量を Base64 文字列化しない（~384MiB 超で Node の最大文字列長を超え ERR_STRING_TOO_LONG になる回帰を防ぐ）', async () => {
        doubles.filesUpload.mockResolvedValue({ name: 'files/big', state: 'ACTIVE', uri: 'https://files/big', mimeType: 'audio/mpeg' });
        doubles.filesDelete.mockResolvedValue(undefined);
        // 🔴 経路判定は Base64 の「長さ」だけで行い、実際の toString('base64') は inline のときだけ。
        //    旧実装は判定前に全量を toString('base64') しており、上限を 500MB に上げると ~384MiB 超で
        //    Base64 文字列が Node の最大文字列長 (536,870,888) を超え ERR_STRING_TOO_LONG で 502 になっていた。
        const toStringSpy = vi.spyOn(bigBytes, 'toString');
        const client = new GeminiServerClient({ pollIntervalMs: 0 });
        const result = await client.generate({ bytes: bigBytes, mimeType: 'audio/mpeg', fileName: 'big.mp3', prompt });
        expect(result.transport).toBe('files_api');
        // 🔴 files_api 経路ではバッファを Base64 化していない（これがあると巨大ファイルで例外になる）
        expect(toStringSpy).not.toHaveBeenCalledWith('base64');
        toStringSpy.mockRestore();
    });

    it('境界: base64+prompt が予算ちょうど以下は inline、1 バイト超で files_api', async () => {
        // prompt 'p' は 1 バイト。bytes = (budget-4)/4*3 → base64 = budget-4 → 合計 budget-3 (inline)
        const inlineBytes = ((INLINE_REQUEST_BUDGET_BYTES - 4) / 4) * 3;
        const client = new GeminiServerClient({ pollIntervalMs: 0 });
        const onBudget = await client.generate({
            bytes: Buffer.alloc(inlineBytes, 1), mimeType: 'audio/mpeg', fileName: 'a.mp3', prompt: { ...prompt, content: 'p' },
        });
        expect(onBudget.transport).toBe('inline');
        expect(doubles.filesUpload).not.toHaveBeenCalled();

        // +3 バイト → base64 = budget → 合計 budget+1 → files_api
        doubles.filesUpload.mockResolvedValue({ name: 'files/edge', state: 'ACTIVE', uri: 'https://files/edge' });
        doubles.filesDelete.mockResolvedValue(undefined);
        const overBudget = await client.generate({
            bytes: Buffer.alloc(inlineBytes + 3, 1), mimeType: 'audio/mpeg', fileName: 'a.mp3', prompt: { ...prompt, content: 'p' },
        });
        expect(overBudget.transport).toBe('files_api');
        expect(doubles.filesUpload).toHaveBeenCalledTimes(1);
    });

    it('生成が失敗しても Files API のファイルは削除する (best-effort) — 削除失敗は warn 止まり', async () => {
        doubles.filesUpload.mockResolvedValue({ name: 'files/abc', state: 'ACTIVE', uri: 'https://files/abc' });
        doubles.generateContent.mockRejectedValue(new Error('500 Internal error'));
        doubles.filesDelete.mockRejectedValue(new Error('delete failed'));

        const client = new GeminiServerClient();
        await expect(client.generate({ bytes: bigBytes, mimeType: 'audio/mpeg', fileName: 'big.mp3', prompt }))
            .rejects.toMatchObject({ code: 'upstream_error', status: 502 });
        expect(doubles.filesDelete).toHaveBeenCalledWith({ name: 'files/abc' });
        expect(doubles.logger.warn).toHaveBeenCalledWith(
            'Files API のファイル削除に失敗（48時間で自動削除される）', expect.objectContaining({ name: 'files/abc' }),
        );
    });

    it('ACTIVE 待ちが時間超過なら 504 upstream_timeout', async () => {
        doubles.filesUpload.mockResolvedValue({ name: 'files/abc', state: 'PROCESSING' });
        doubles.filesGet.mockResolvedValue({ name: 'files/abc', state: 'PROCESSING' });
        let t = 0;
        const client = new GeminiServerClient({ pollIntervalMs: 0, activationTimeoutMs: 10, now: () => (t += 6) });
        await expect(client.generate({ bytes: bigBytes, mimeType: 'audio/mpeg', fileName: 'big.mp3', prompt }))
            .rejects.toMatchObject({ code: 'upstream_timeout', status: 504 });
        expect(doubles.generateContent).not.toHaveBeenCalled();
    });

    it('FAILED は 502 (生英文は logger だけ)', async () => {
        doubles.filesUpload.mockResolvedValue({ name: 'files/abc', state: 'FAILED', error: { message: 'unsupported codec' } });
        const client = new GeminiServerClient();
        const error = await client.generate({ bytes: bigBytes, mimeType: 'audio/mpeg', fileName: 'big.mp3', prompt }).catch(e => e);
        expect(error).toBeInstanceOf(GenerateApiError);
        expect(error.code).toBe('upstream_error');
        expect(error.message).not.toContain('unsupported codec');
        expect(doubles.logger.error).toHaveBeenCalled();
    });
});

describe('uploadMedia — Blob へ渡すバイト列', () => {
    /**
     * 🔴 Buffer → Blob のコピーを 1 段外した (旧: `new Blob([new Uint8Array(bytes)])`)。
     *    旧実装は Buffer の全量コピー + Blob 自身のコピーでピーク常駐がサイズの 3 倍になっていた
     *    (200MB のファイルで実測 600MB → 400MB)。
     *    錠は 2 種類ある: (a) 送るバイト列が変わっていないこと、(b) コピーが復活していないこと。
     *    (a) だけだと旧実装も緑のまま通る (バイト列は同じなので) ＝ 改修でコピーが黙って戻る。
     *    (b) は Blob へ渡した BlobPart が元 Buffer と **同じ backing buffer** を指しているかで見る。
     */
    const uploadedBlob = (): Blob => doubles.filesUpload.mock.calls[0][0].file as Blob;

    /** Blob の構築を捕まえる。本物へ委譲するので Blob の振る舞いは変わらない */
    const captureBlobParts = async (run: () => Promise<unknown>): Promise<BlobPart[]> => {
        const RealBlob = globalThis.Blob;
        const parts: BlobPart[] = [];
        class RecordingBlob extends RealBlob {
            constructor(blobParts: BlobPart[] = [], options?: BlobPropertyBag) {
                parts.push(...blobParts);
                super(blobParts, options);
            }
        }
        globalThis.Blob = RecordingBlob as unknown as typeof Blob;
        try {
            await run();
        } finally {
            globalThis.Blob = RealBlob;
        }
        return parts;
    };

    beforeEach(() => {
        doubles.filesUpload.mockResolvedValue({
            name: 'files/x', state: 'ACTIVE', uri: 'https://files/x', mimeType: 'audio/mpeg',
        });
    });

    it('元の Buffer と同一のバイト列・MIME を渡す', async () => {
        const bytes = Buffer.from('audio-bytes-0123456789');
        await new GeminiServerClient().uploadMedia(bytes, 'audio/mpeg', 'a.mp3');
        const blob = uploadedBlob();
        expect(blob.type).toBe('audio/mpeg');
        expect(blob.size).toBe(bytes.length);
        expect(Buffer.from(await blob.arrayBuffer()).equals(bytes)).toBe(true);
    });

    it('🔴 Blob には元 Buffer と同じ backing buffer のビューを渡す (全量コピーを復活させない)', async () => {
        // Buffer.from は共有プール上に載るので byteOffset != 0 になり、buffer 同一性と範囲の両方を見られる
        const bytes = Buffer.from('audio-bytes-0123456789');
        const parts = await captureBlobParts(
            () => new GeminiServerClient().uploadMedia(bytes, 'audio/mpeg', 'a.mp3'),
        );

        expect(parts).toHaveLength(1);
        const view = parts[0] as Uint8Array;
        expect(ArrayBuffer.isView(view)).toBe(true);
        // 🔴 ここが本題: コピー (`new Uint8Array(bytes)`) は別の ArrayBuffer になるので、同一性で落ちる
        expect(view.buffer).toBe(bytes.buffer);
        expect(view.byteOffset).toBe(bytes.byteOffset);
        expect(view.byteLength).toBe(bytes.byteLength);
        // 委譲しているので Blob 自体は本物のまま
        expect(uploadedBlob().size).toBe(bytes.length);
    });

    it('🔴 byteOffset != 0 の Buffer (共有プール上のビュー) でも同一 — 周囲のバイトを含めない', async () => {
        const backing = Buffer.alloc(64, 0x9);
        const bytes = backing.subarray(8, 24);
        bytes.write('sliced-payload!!');
        expect(bytes.byteOffset).toBeGreaterThan(0);

        await new GeminiServerClient().uploadMedia(bytes, 'audio/mpeg', 'a.mp3');
        const got = Buffer.from(await uploadedBlob().arrayBuffer());
        expect(got.length).toBe(bytes.length);
        expect(got.equals(bytes)).toBe(true);
    });
});

describe('classifyGeminiError', () => {
    it.each([
        ['API_KEY_INVALID: x', 'not_configured', 503],
        ['API key not valid. Please pass a valid API key.', 'not_configured', 503],
        ['[429 Too Many Requests] RESOURCE_EXHAUSTED', 'upstream_error', 502],
        ['[404 Not Found] models/gemini-x is not found', 'upstream_error', 502],
        ['PERMISSION_DENIED', 'upstream_error', 502],
        ['Request payload size exceeds the limit', 'upstream_error', 502],
        ['fetch failed', 'upstream_error', 502],
        ['DEADLINE_EXCEEDED', 'upstream_timeout', 504],
        ['The operation timed out', 'upstream_timeout', 504],
        ['something else', 'upstream_error', 502],
    ])('%s → %s (%s)', (raw, code, status) => {
        const e = classifyGeminiError(new Error(raw), 'gemini-x');
        expect(e.code).toBe(code);
        expect(e.status).toBe(status);
        expect(e.message).not.toBe(raw);
        expect(e.message).toMatch(/してください/);
    });
    it('404 の文言にはモデル名を含める', () => {
        expect(classifyGeminiError(new Error('404 not found'), 'gemini-x').message).toContain('gemini-x');
    });
    it('GenerateApiError はそのまま', () => {
        const original = new GenerateApiError('rate_limited', 'x', { retryAfterSec: 5 });
        expect(classifyGeminiError(original, 'm')).toBe(original);
    });
});

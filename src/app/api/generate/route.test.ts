/**
 * POST /api/generate を Request → Response の関数として呼ぶ統合寄りのテスト。
 * モックは SDK の縁 (firebase-admin/*, @google/genai) だけに置き、src/server/** は実物を通す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GEMINI_MODEL } from '@/constants/geminiModels';
import { GENERATE_MAX_MEDIA_BYTES, type GenerateRequestBody } from '@/lib/generateApiContract';
import { INLINE_REQUEST_BUDGET_BYTES } from '@/lib/inlineMediaBudget';

const doubles = vi.hoisted(() => ({
    verifyIdToken: vi.fn(),
    files: new Map<string, { bytes: Buffer; size?: string; contentType?: string }>(),
    configData: undefined as Record<string, unknown> | undefined,
    rateDocs: new Map<string, Record<string, unknown>>(),
    generateContent: vi.fn(),
    filesUpload: vi.fn(),
    filesGet: vi.fn(),
    filesDelete: vi.fn(),
    initializeApp: vi.fn(),
}));

vi.mock('firebase-admin/app', () => ({
    getApps: () => [],
    initializeApp: doubles.initializeApp,
    cert: vi.fn(() => 'CERT'),
    applicationDefault: vi.fn(() => 'ADC'),
}));
vi.mock('firebase-admin/auth', () => ({
    getAuth: () => ({ verifyIdToken: doubles.verifyIdToken }),
}));
vi.mock('firebase-admin/firestore', () => ({
    FieldValue: { serverTimestamp: () => 'SERVER_TS' },
    getFirestore: () => ({
        doc: () => ({
            get: async () => ({ exists: doubles.configData !== undefined, data: () => doubles.configData }),
        }),
        collection: (name: string) => ({ doc: (id: string) => ({ id: `${name}/${id}` }) }),
        runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
            get: async (ref: { id: string }) => {
                const d = doubles.rateDocs.get(ref.id);
                return { exists: d !== undefined, data: () => d };
            },
            set: (ref: { id: string }, data: Record<string, unknown>) => { doubles.rateDocs.set(ref.id, data); },
        }),
    }),
}));
vi.mock('firebase-admin/storage', () => ({
    getStorage: () => ({
        bucket: () => ({
            file: (path: string) => ({
                exists: async () => [doubles.files.has(path)],
                getMetadata: async () => {
                    const f = doubles.files.get(path)!;
                    return [{ size: f.size ?? String(f.bytes.length), contentType: f.contentType }];
                },
                download: async () => [doubles.files.get(path)!.bytes],
            }),
        }),
    }),
}));
vi.mock('@google/genai', () => ({
    ThinkingLevel: { LOW: 'SDK_LOW', MEDIUM: 'SDK_MEDIUM', HIGH: 'SDK_HIGH' },
    GoogleGenAI: class {
        models = { generateContent: doubles.generateContent };
        files = { upload: doubles.filesUpload, get: doubles.filesGet, delete: doubles.filesDelete };
    },
}));

import { GET, POST, validateRequestBody } from './route';
import { resetAdminAppForTests } from '@/server/firebaseAdmin';

const BYTES_OVER_BUDGET = Math.floor((INLINE_REQUEST_BUDGET_BYTES * 3) / 4) + 4;

const baseBody = (): GenerateRequestBody => ({
    storagePath: 'audio/GUEST/rec.mp3',
    fileName: 'rec.mp3',
    mimeType: 'audio/mpeg',
    prompt: { name: '議事録', content: 'まとめて', model: 'default', thinkingLevel: 'default' },
});

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    POST(new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    }));

const env = { ...process.env };
let consoleLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.clearAllMocks();
    resetAdminAppForTests();
    doubles.files.clear();
    doubles.rateDocs.clear();
    doubles.configData = { rateLimit: { documentsPerHour: 3 } };
    doubles.initializeApp.mockImplementation((_o: unknown, name: string) => ({ name }));
    doubles.generateContent.mockResolvedValue({ text: '# 生成文書', usageMetadata: { totalTokenCount: 42 } });
    doubles.files.set('audio/GUEST/rec.mp3', { bytes: Buffer.from('guest-audio'), contentType: 'audio/mpeg' });
    doubles.files.set('audio/uid-1/mine.mp3', { bytes: Buffer.from('my-audio'), contentType: 'audio/mpeg' });
    process.env.GEMINI_API_KEY = 'server-key';
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'proj';
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'proj.appspot.com';
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
});

describe('GET', () => {
    it('405', () => {
        const res = GET();
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
    });
});

describe('POST 200', () => {
    it('GUEST: inline で生成し、契約どおりの本文と計器ログを出す', async () => {
        const res = await post(baseBody());
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toMatchObject({
            text: '# 生成文書',
            usedModel: DEFAULT_GEMINI_MODEL,
            thinkingLevel: 'MEDIUM',
            transport: 'inline',
            usage: { totalTokenCount: 42 },
        });
        expect(typeof json.elapsedMs).toBe('number');
        expect(doubles.verifyIdToken).not.toHaveBeenCalled();
        // 上限カウントが GUEST subject に 1 件
        const keys = [...doubles.rateDocs.keys()];
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^rateLimits\/guest:[0-9a-f]{16}$/);
        // 計器: JSON 1 行
        const line = consoleLog.mock.calls.map(c => String(c[0])).find(s => s.includes('generate.success'));
        expect(line).toBeDefined();
        expect(JSON.parse(line!)).toMatchObject({ usedModel: DEFAULT_GEMINI_MODEL, transport: 'inline', subjectKind: 'guest' });
    });

    it('ログイン: ID トークンを検証し、自分のディレクトリを uid subject で数える', async () => {
        doubles.verifyIdToken.mockResolvedValue({ uid: 'uid-1' });
        const res = await post({ ...baseBody(), storagePath: 'audio/uid-1/mine.mp3' }, { authorization: 'Bearer good' });
        expect(res.status).toBe(200);
        expect(doubles.verifyIdToken).toHaveBeenCalledWith('good');
        expect(doubles.rateDocs.has('rateLimits/uid-1')).toBe(true);
        expect(doubles.generateContent.mock.calls[0][0].contents[0].parts[1].inlineData.data)
            .toBe(Buffer.from('my-audio').toString('base64'));
    });

    it('動画: Storage 上は audio/mpeg でも要求の mimeType (video/mp4) で Gemini へ渡す', async () => {
        const res = await post({ ...baseBody(), mimeType: 'video/mp4' });
        expect(res.status).toBe(200);
        expect(doubles.generateContent.mock.calls[0][0].contents[0].parts[1].inlineData.mimeType).toBe('video/mp4');
    });

    it('予算超は files_api 経路 (upload → generate → delete)', async () => {
        doubles.files.set('audio/GUEST/big.mp3', { bytes: Buffer.alloc(BYTES_OVER_BUDGET, 1) });
        doubles.filesUpload.mockResolvedValue({ name: 'files/x', state: 'ACTIVE', uri: 'https://files/x', mimeType: 'audio/mpeg' });
        doubles.filesDelete.mockResolvedValue(undefined);
        const res = await post({ ...baseBody(), storagePath: 'audio/GUEST/big.mp3' });
        expect(res.status).toBe(200);
        expect((await res.json()).transport).toBe('files_api');
        expect(doubles.filesUpload).toHaveBeenCalledTimes(1);
        expect(doubles.filesDelete).toHaveBeenCalledWith({ name: 'files/x' });
    });

    it('files_api で生成失敗 → 502 でも削除は呼ぶ (best-effort)', async () => {
        doubles.files.set('audio/GUEST/big.mp3', { bytes: Buffer.alloc(BYTES_OVER_BUDGET, 1) });
        doubles.filesUpload.mockResolvedValue({ name: 'files/x', state: 'ACTIVE', uri: 'https://files/x' });
        doubles.filesDelete.mockRejectedValue(new Error('nope'));
        doubles.generateContent.mockRejectedValue(new Error('500 internal'));
        const res = await post({ ...baseBody(), storagePath: 'audio/GUEST/big.mp3' });
        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('upstream_error');
        expect(doubles.filesDelete).toHaveBeenCalledWith({ name: 'files/x' });
    });
});

describe('POST エラー分岐', () => {
    it('400: JSON でない本文', async () => {
        const res = await post('{not json');
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_request');
    });

    it.each([
        ['storagePath 欠落', { storagePath: undefined }],
        ['mimeType が image/*', { mimeType: 'image/png' }],
        ['prompt 欠落', { prompt: undefined }],
        ['thinkingLevel 不正', { prompt: { ...baseBody().prompt, thinkingLevel: 'ultra' } }],
        ['パス形式外', { storagePath: 'audio/GUEST/../x.mp3' }],
        ['パス段数違い', { storagePath: 'audio/x.mp3' }],
    ])('400: %s', async (_label, patch) => {
        const res = await post({ ...baseBody(), ...patch });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_request');
        expect(doubles.generateContent).not.toHaveBeenCalled();
    });

    it('401: トークンがあって無効 (GUEST に落とさない)', async () => {
        doubles.verifyIdToken.mockRejectedValue(new Error('expired'));
        const res = await post(baseBody(), { authorization: 'Bearer bad' });
        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('unauthorized');
        expect(doubles.generateContent).not.toHaveBeenCalled();
    });

    it('403: GUEST が他人の uid ディレクトリ', async () => {
        const res = await post({ ...baseBody(), storagePath: 'audio/uid-1/mine.mp3' });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('forbidden');
    });

    it('403: ログインユーザーが GUEST ディレクトリ', async () => {
        doubles.verifyIdToken.mockResolvedValue({ uid: 'uid-1' });
        const res = await post(baseBody(), { authorization: 'Bearer good' });
        expect(res.status).toBe(403);
    });

    it('403: ログインユーザーが他人の uid ディレクトリ', async () => {
        doubles.verifyIdToken.mockResolvedValue({ uid: 'uid-2' });
        const res = await post({ ...baseBody(), storagePath: 'audio/uid-1/mine.mp3' }, { authorization: 'Bearer good' });
        expect(res.status).toBe(403);
        expect(doubles.rateDocs.size).toBe(0);
    });

    it('404: Storage に無い (上限カウントは消費しない)', async () => {
        const res = await post({ ...baseBody(), storagePath: 'audio/GUEST/missing.mp3' });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('media_not_found');
        expect(doubles.rateDocs.size).toBe(0);
    });

    it('413: 100MB 超', async () => {
        doubles.files.set('audio/GUEST/huge.mp3', { bytes: Buffer.from('x'), size: String(GENERATE_MAX_MEDIA_BYTES + 1) });
        const res = await post({ ...baseBody(), storagePath: 'audio/GUEST/huge.mp3' });
        expect(res.status).toBe(413);
        expect((await res.json()).error).toBe('media_too_large');
        expect(doubles.rateDocs.size).toBe(0);
    });

    it('429: 設定上限 (3) を超えた 4 件目。retryAfterSec と Retry-After ヘッダ、Gemini は呼ばない', async () => {
        for (let i = 0; i < 3; i += 1) {
            expect((await post(baseBody(), { 'x-forwarded-for': '203.0.113.9' })).status).toBe(200);
        }
        expect(doubles.generateContent).toHaveBeenCalledTimes(3);
        const res = await post(baseBody(), { 'x-forwarded-for': '203.0.113.9' });
        expect(res.status).toBe(429);
        const json = await res.json();
        expect(json.error).toBe('rate_limited');
        expect(json.retryAfterSec).toBeGreaterThan(0);
        expect(json.retryAfterSec).toBeLessThanOrEqual(3600);
        expect(res.headers.get('retry-after')).toBe(String(json.retryAfterSec));
        expect(doubles.generateContent).toHaveBeenCalledTimes(3);
        // 別 IP の GUEST は別 subject
        expect((await post(baseBody(), { 'x-forwarded-for': '203.0.113.10' })).status).toBe(200);
    });

    it('429 の既定値: 設定が読めなければ 50 件目まで通す', async () => {
        doubles.configData = undefined;
        doubles.rateDocs.set('rateLimits/guest:' + 'f'.repeat(16), {}); // 無関係な doc
        for (let i = 0; i < 50; i += 1) {
            expect((await post(baseBody())).status).toBe(200);
        }
        expect((await post(baseBody())).status).toBe(429);
    });

    it('503: GEMINI_API_KEY 無し (上限カウントも Storage も触らない)', async () => {
        delete process.env.GEMINI_API_KEY;
        const res = await post(baseBody());
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('not_configured');
        expect(doubles.rateDocs.size).toBe(0);
        expect(doubles.generateContent).not.toHaveBeenCalled();
    });

    it('503: 管理資格情報が壊れている', async () => {
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{broken';
        const res = await post(baseBody());
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe('not_configured');
    });

    it('502: Gemini エラー (生英文は本文に出さない)', async () => {
        doubles.generateContent.mockRejectedValue(new Error('[503 Service Unavailable] The model is overloaded'));
        const res = await post(baseBody());
        expect(res.status).toBe(502);
        const json = await res.json();
        expect(json.error).toBe('upstream_error');
        expect(json.message).not.toContain('overloaded');
        expect(json.message).toMatch(/してください/);
    });

    it('502: 429 相当の Gemini エラーも 502 (自前の 429 と混同しない)', async () => {
        doubles.generateContent.mockRejectedValue(new Error('[429 Too Many Requests] RESOURCE_EXHAUSTED'));
        const res = await post(baseBody());
        expect(res.status).toBe(502);
        expect((await res.json()).retryAfterSec).toBeUndefined();
    });

    it('504: Gemini の deadline', async () => {
        doubles.generateContent.mockRejectedValue(new Error('DEADLINE_EXCEEDED'));
        const res = await post(baseBody());
        expect(res.status).toBe(504);
        expect((await res.json()).error).toBe('upstream_timeout');
    });

    it('想定外の例外も 502 の契約形で返す', async () => {
        doubles.verifyIdToken.mockImplementation(() => { throw new TypeError('boom'); });
        // verifyIdToken の例外は auth 層で 401 に写る。想定外を作るには Storage 層を壊す
        doubles.verifyIdToken.mockResolvedValue({ uid: 'uid-1' });
        doubles.files.set('audio/uid-1/mine.mp3', { bytes: null as unknown as Buffer });
        const res = await post({ ...baseBody(), storagePath: 'audio/uid-1/mine.mp3' }, { authorization: 'Bearer good' });
        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('upstream_error');
    });
});

describe('validateRequestBody', () => {
    it('契約の形をそのまま返す', () => {
        expect(validateRequestBody(baseBody())).toEqual(baseBody());
    });
    it('長すぎるプロンプトは 400', () => {
        expect(() => validateRequestBody({ ...baseBody(), prompt: { ...baseBody().prompt, content: 'a'.repeat(200_001) } }))
            .toThrow(expect.objectContaining({ code: 'invalid_request' }));
    });
});

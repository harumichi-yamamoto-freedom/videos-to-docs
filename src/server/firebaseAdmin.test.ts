import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
    apps: [] as Array<{ name: string }>,
    initializeApp: vi.fn(),
    cert: vi.fn(),
    applicationDefault: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => doubles.logger }));
vi.mock('firebase-admin/app', () => ({
    getApps: () => doubles.apps,
    initializeApp: doubles.initializeApp,
    cert: doubles.cert,
    applicationDefault: doubles.applicationDefault,
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: vi.fn(() => ({ kind: 'auth' })) }));
vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn(() => ({ kind: 'firestore' })) }));
vi.mock('firebase-admin/storage', () => ({
    getStorage: vi.fn(() => ({ bucket: (name: string) => ({ name }) })),
}));

import { ADMIN_APP_NAME, getAdminApp, getAdminBucket, parseServiceAccountJson, resetAdminAppForTests } from './firebaseAdmin';

const SA = { type: 'service_account', project_id: 'p', client_email: 'e@p', private_key: 'k' };

describe('parseServiceAccountJson', () => {
    it('JSON 1 行と base64 の両方を受け付ける', () => {
        expect(parseServiceAccountJson(JSON.stringify(SA))).toEqual(SA);
        expect(parseServiceAccountJson(Buffer.from(JSON.stringify(SA)).toString('base64'))).toEqual(SA);
        expect(parseServiceAccountJson(`  ${JSON.stringify(SA)}\n`)).toEqual(SA);
    });
    it('判別は先頭の `{`: `{` 始まりは JSON としてのみ解釈 (base64 へは落ちない)', () => {
        expect(() => parseServiceAccountJson('{broken')).toThrow(/JSON として解釈できません/);
        expect(() => parseServiceAccountJson('not base64 json')).toThrow(/base64/);
        expect(() => parseServiceAccountJson('')).toThrow();
        expect(() => parseServiceAccountJson('[1,2]')).toThrow();
    });
});

describe('getAdminApp', () => {
    const env = { ...process.env };
    beforeEach(() => {
        resetAdminAppForTests();
        doubles.apps = [];
        vi.clearAllMocks();
        doubles.initializeApp.mockImplementation((_opts: unknown, name: string) => ({ name }));
        doubles.cert.mockReturnValue('CERT');
        doubles.applicationDefault.mockReturnValue('ADC');
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'proj';
        process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'proj.appspot.com';
        delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    });
    afterEach(() => {
        process.env = { ...env };
    });

    it('SA JSON があれば cert で、1 回だけ初期化する', () => {
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(SA);
        const a = getAdminApp();
        const b = getAdminApp();
        expect(a).toBe(b);
        expect(doubles.initializeApp).toHaveBeenCalledTimes(1);
        expect(doubles.cert).toHaveBeenCalledWith(SA);
        expect(doubles.applicationDefault).not.toHaveBeenCalled();
        expect(doubles.initializeApp).toHaveBeenCalledWith(
            { credential: 'CERT', projectId: 'proj', storageBucket: 'proj.appspot.com' },
            ADMIN_APP_NAME,
        );
    });

    it('SA JSON が無ければ ADC', () => {
        getAdminApp();
        expect(doubles.applicationDefault).toHaveBeenCalledTimes(1);
        expect(doubles.cert).not.toHaveBeenCalled();
    });

    it('同名 app が既にあれば再利用する (HMR 等で module が再評価された場合)', () => {
        doubles.apps = [{ name: ADMIN_APP_NAME }];
        expect(getAdminApp()).toBe(doubles.apps[0]);
        expect(doubles.initializeApp).not.toHaveBeenCalled();
    });

    it('SA JSON が壊れていれば 503 not_configured', () => {
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{broken';
        expect(() => getAdminApp()).toThrow(expect.objectContaining({ code: 'not_configured', status: 503 }));
    });

    it('bucket 名が無ければ 503 not_configured', () => {
        delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
        expect(() => getAdminBucket()).toThrow(expect.objectContaining({ code: 'not_configured' }));
    });

    it('bucket 名があればその bucket', () => {
        expect(getAdminBucket()).toEqual({ name: 'proj.appspot.com' });
    });
});

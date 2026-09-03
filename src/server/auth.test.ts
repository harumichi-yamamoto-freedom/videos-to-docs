import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
    verifyIdToken: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => doubles.logger }));
vi.mock('./firebaseAdmin', () => ({
    getAdminAuth: () => ({ verifyIdToken: doubles.verifyIdToken }),
}));

import { extractBearerToken, resolveRequestSubject } from './auth';

describe('extractBearerToken', () => {
    it('ヘッダ無しは null、Bearer はトークン、形式外は空文字', () => {
        expect(extractBearerToken(null)).toBeNull();
        expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
        expect(extractBearerToken('bearer abc')).toBe('abc');
        expect(extractBearerToken('Basic abc')).toBe('');
        expect(extractBearerToken('Bearer')).toBe('');
        expect(extractBearerToken('')).toBe('');
    });
});

describe('resolveRequestSubject', () => {
    beforeEach(() => vi.clearAllMocks());

    it('Authorization 無しは guest (verifyIdToken を呼ばない)', async () => {
        await expect(resolveRequestSubject(new Headers())).resolves.toEqual({ kind: 'guest' });
        expect(doubles.verifyIdToken).not.toHaveBeenCalled();
    });

    it('有効なトークンは uid', async () => {
        doubles.verifyIdToken.mockResolvedValue({ uid: 'uid-1' });
        await expect(resolveRequestSubject(new Headers({ authorization: 'Bearer tok' }))).resolves.toEqual({ kind: 'user', uid: 'uid-1' });
        expect(doubles.verifyIdToken).toHaveBeenCalledWith('tok');
    });

    it('無効なトークンは 401 unauthorized (guest に落とさない)', async () => {
        doubles.verifyIdToken.mockRejectedValue(new Error('auth/id-token-expired'));
        await expect(resolveRequestSubject(new Headers({ authorization: 'Bearer bad' })))
            .rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    });

    it('Bearer 形式でないヘッダは 401', async () => {
        await expect(resolveRequestSubject(new Headers({ authorization: 'Basic xyz' })))
            .rejects.toMatchObject({ code: 'unauthorized', status: 401 });
        expect(doubles.verifyIdToken).not.toHaveBeenCalled();
    });
});

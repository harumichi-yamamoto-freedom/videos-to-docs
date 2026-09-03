import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATE_MAX_MEDIA_BYTES } from '@/lib/generateApiContract';

const doubles = vi.hoisted(() => ({
    files: new Map<string, { bytes: Buffer; size?: string; contentType?: string }>(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => doubles.logger }));
vi.mock('./firebaseAdmin', () => ({
    getAdminBucket: () => ({
        file: (path: string) => ({
            exists: async () => [doubles.files.has(path)],
            getMetadata: async () => {
                const f = doubles.files.get(path)!;
                return [{ size: f.size ?? String(f.bytes.length), contentType: f.contentType }];
            },
            download: async () => [doubles.files.get(path)!.bytes],
        }),
    }),
}));

import { downloadMedia, isOwnedBySubject, parseStoragePath, statMedia } from './mediaSource';
import { GenerateApiError } from './errors';

describe('parseStoragePath', () => {
    it('audio/{ownerId}/{name} を分解する', () => {
        expect(parseStoragePath('audio/uid-1/rec.mp3')).toEqual({ ownerId: 'uid-1', name: 'rec.mp3' });
        expect(parseStoragePath('audio/GUEST/1700000000-会議.mp3')).toEqual({ ownerId: 'GUEST', name: '1700000000-会議.mp3' });
    });

    it.each([
        ['', '空'],
        ['audio/uid-1', '段数不足'],
        ['audio/uid-1/a/b', '段数超過'],
        ['video/uid-1/a.mp3', 'prefix 違い'],
        ['audio//a.mp3', '空 ownerId'],
        ['audio/uid-1/', '空 name'],
        ['audio/../a.mp3', 'ownerId が ..'],
        ['audio/uid-1/..', 'name が ..'],
        ['audio/./a.mp3', 'ownerId が .'],
        ['audio/uid-1/a\\b.mp3', 'バックスラッシュ'],
        ['audio/uid-1/a\u0000.mp3', 'NUL'],
        ['audio/uid-1/a\n.mp3', '改行'],
        ['/audio/uid-1/a.mp3', '先頭スラッシュ'],
        ['audio/uid-1/a.mp3/', '末尾スラッシュ'],
    ])('拒否: %s (%s)', path => {
        expect(parseStoragePath(path)).toBeNull();
    });

    it('文字列以外は拒否する', () => {
        expect(parseStoragePath(undefined as unknown as string)).toBeNull();
        expect(parseStoragePath(123 as unknown as string)).toBeNull();
    });
});

describe('isOwnedBySubject', () => {
    it('ログインは自分の uid だけ', () => {
        expect(isOwnedBySubject('uid-1', { kind: 'user', uid: 'uid-1' })).toBe(true);
        expect(isOwnedBySubject('uid-2', { kind: 'user', uid: 'uid-1' })).toBe(false);
        expect(isOwnedBySubject('GUEST', { kind: 'user', uid: 'uid-1' })).toBe(false);
    });
    it('未ログインは GUEST だけ', () => {
        expect(isOwnedBySubject('GUEST', { kind: 'guest' })).toBe(true);
        expect(isOwnedBySubject('uid-1', { kind: 'guest' })).toBe(false);
        expect(isOwnedBySubject('guest', { kind: 'guest' })).toBe(false);
    });
});

describe('statMedia / downloadMedia', () => {
    beforeEach(() => {
        doubles.files.clear();
        vi.clearAllMocks();
    });

    it('存在しなければ 404 media_not_found', async () => {
        await expect(statMedia('audio/GUEST/x.mp3')).rejects.toMatchObject({ code: 'media_not_found', status: 404 });
    });

    it('メタのサイズが上限超なら 413 (本文は取らない)', async () => {
        doubles.files.set('audio/GUEST/big.mp3', { bytes: Buffer.from('tiny'), size: String(GENERATE_MAX_MEDIA_BYTES + 1) });
        await expect(statMedia('audio/GUEST/big.mp3')).rejects.toMatchObject({ code: 'media_too_large', status: 413 });
    });

    it('上限ちょうどは通る', async () => {
        doubles.files.set('audio/GUEST/edge.mp3', { bytes: Buffer.from('x'), size: String(GENERATE_MAX_MEDIA_BYTES) });
        await expect(statMedia('audio/GUEST/edge.mp3')).resolves.toMatchObject({ sizeBytes: GENERATE_MAX_MEDIA_BYTES });
    });

    it('存在すればサイズと contentType を返し、download で本文を取る', async () => {
        doubles.files.set('audio/uid-1/a.mp3', { bytes: Buffer.from('hello'), contentType: 'audio/mpeg' });
        const info = await statMedia('audio/uid-1/a.mp3');
        expect(info).toEqual({ storagePath: 'audio/uid-1/a.mp3', sizeBytes: 5, contentType: 'audio/mpeg' });
        const media = await downloadMedia(info);
        expect(media.bytes.toString()).toBe('hello');
        expect(media.sizeBytes).toBe(5);
    });

    it('メタが小さくても実体が上限超なら 413', async () => {
        doubles.files.set('audio/uid-1/lie.mp3', { bytes: Buffer.alloc(GENERATE_MAX_MEDIA_BYTES + 1), size: '10' });
        const info = await statMedia('audio/uid-1/lie.mp3');
        await expect(downloadMedia(info)).rejects.toBeInstanceOf(GenerateApiError);
    });
});

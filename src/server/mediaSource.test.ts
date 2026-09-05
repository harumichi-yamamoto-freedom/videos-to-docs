import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATE_MAX_MEDIA_BYTES, GENERATE_SYNC_MAX_MEDIA_BYTES } from '@/lib/generateApiContract';

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

import {
    downloadMedia, isOwnedBySubject, parseStoragePath, statMedia, syncGenerateTooLargeMessage,
} from './mediaSource';
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

    it('🔴 同期の文書生成の上限 (200MB) を渡すと、Storage 上限 (500MB) 内でも 413', async () => {
        doubles.files.set('audio/GUEST/300mb.mp3', {
            bytes: Buffer.from('tiny'), size: String(GENERATE_SYNC_MAX_MEDIA_BYTES + 1),
        });
        const error = await statMedia(
            'audio/GUEST/300mb.mp3', GENERATE_SYNC_MAX_MEDIA_BYTES, syncGenerateTooLargeMessage,
        ).catch(e => e);
        expect(error).toMatchObject({ code: 'media_too_large', status: 413 });
        // 🔴 「アップロードできない」と読ませない: 全文文字起こしは使えることを文言に含める
        expect(error.message).toContain('全文文字起こしはこのままご利用いただけます');
        expect(error.message).toContain('200MB');
        expect(error.message).not.toContain('アップロード');
    });

    it('🔴 同期の上限ちょうどは通る (境界は「超えたら拒否」)', async () => {
        doubles.files.set('audio/GUEST/sync-edge.mp3', {
            bytes: Buffer.from('x'), size: String(GENERATE_SYNC_MAX_MEDIA_BYTES),
        });
        await expect(statMedia('audio/GUEST/sync-edge.mp3', GENERATE_SYNC_MAX_MEDIA_BYTES, syncGenerateTooLargeMessage))
            .resolves.toMatchObject({ sizeBytes: GENERATE_SYNC_MAX_MEDIA_BYTES });
    });

    it('存在すればサイズと contentType を返し、download で本文を取る', async () => {
        doubles.files.set('audio/uid-1/a.mp3', { bytes: Buffer.from('hello'), contentType: 'audio/mpeg' });
        const info = await statMedia('audio/uid-1/a.mp3');
        expect(info).toEqual({ storagePath: 'audio/uid-1/a.mp3', sizeBytes: 5, contentType: 'audio/mpeg' });
        const media = await downloadMedia(info);
        expect(media.bytes.toString()).toBe('hello');
        expect(media.sizeBytes).toBe(5);
    });

    // 🔴 既定を GENERATE_MAX_MEDIA_BYTES (500MB) から同期経路の 200MB に下げたので、期待値も下げる。
    //    500MB のままだと「200MB〜500MB の実体」が素通りして、この経路が丸ごとメモリに載せてしまう。
    it('メタが小さくても実体が同期の上限超なら 413 (既定の上限は同期経路のもの)', async () => {
        doubles.files.set('audio/uid-1/lie.mp3', {
            bytes: Buffer.alloc(GENERATE_SYNC_MAX_MEDIA_BYTES + 1), size: '10',
        });
        const info = await statMedia('audio/uid-1/lie.mp3');
        const error = await downloadMedia(info).catch(e => e);
        expect(error).toBeInstanceOf(GenerateApiError);
        expect(error.code).toBe('media_too_large');
        expect(error.message).toContain('全文文字起こしはこのままご利用いただけます');
    });

    it('渡した上限で再検査する (メタは通っても実体が超えていれば 413)', async () => {
        doubles.files.set('audio/uid-1/small.mp3', { bytes: Buffer.alloc(100), size: '10' });
        const info = await statMedia('audio/uid-1/small.mp3');
        await expect(downloadMedia(info, 99)).rejects.toMatchObject({ code: 'media_too_large', status: 413 });
        await expect(downloadMedia(info, 100)).resolves.toMatchObject({ sizeBytes: 100 });
    });

    it('文言はサイズを切り上げて出す (上限ちょうどに丸めて矛盾させない)', () => {
        const justOver = GENERATE_SYNC_MAX_MEDIA_BYTES + 1;
        expect(syncGenerateTooLargeMessage(justOver, GENERATE_SYNC_MAX_MEDIA_BYTES))
            .toContain('約201MB');
        expect(syncGenerateTooLargeMessage(justOver, GENERATE_SYNC_MAX_MEDIA_BYTES))
            .toContain('上限 200MB');
    });
});

/**
 * `deleteAudioFromStorage` の錠。
 *
 * 文字起こしの分割で作ったチャンク音声を、ジョブ完了後に片付けるための口。
 * 🔴 ここが「既に無い」を失敗として扱うと、再試行や二重実行のたびにジョブが失敗になる。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const deleteObject = vi.fn();
vi.mock('firebase/storage', () => ({
    ref: (_s: unknown, path: string) => ({ path }),
    deleteObject: (...args: unknown[]) => deleteObject(...args),
    uploadBytes: vi.fn(),
    getDownloadURL: vi.fn(),
    getBlob: vi.fn(),
    getMetadata: vi.fn(),
}));
vi.mock('./firebase', () => ({ storage: { name: 'mock-storage' } }));
vi.mock('./auth', () => ({ getCurrentUserId: () => 'u1', getOwnerType: () => 'user' }));
vi.mock('./logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

const { deleteAudioFromStorage } = await import('./storage');

describe('deleteAudioFromStorage', () => {
    beforeEach(() => { deleteObject.mockReset(); });

    it('渡されたパスを削除する', async () => {
        deleteObject.mockResolvedValueOnce(undefined);
        await deleteAudioFromStorage('audio/user-1/chunk-000.mp3');
        expect(deleteObject).toHaveBeenCalledWith({ path: 'audio/user-1/chunk-000.mp3' });
    });

    it('🔴 既に無い (object-not-found) は成功として扱う', async () => {
        // 再試行・二重実行でここが例外になると、片付けのたびにジョブが失敗になる。
        deleteObject.mockRejectedValueOnce({ code: 'storage/object-not-found' });
        await expect(deleteAudioFromStorage('audio/user-1/gone.mp3')).resolves.toBeUndefined();
    });

    it.each([
        ['権限なし', { code: 'storage/unauthorized' }],
        ['コード無しのエラー', new Error('boom')],
    ])('%s は握り潰さず投げる', async (_label, err) => {
        deleteObject.mockRejectedValueOnce(err);
        await expect(deleteAudioFromStorage('audio/user-1/x.mp3')).rejects.toBeTruthy();
    });
});

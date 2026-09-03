import { storage } from './firebase';
import { ref, uploadBytes, getDownloadURL, getBlob, getMetadata, deleteObject } from 'firebase/storage';
import { getCurrentUserId, getOwnerType } from './auth';
import { createLogger } from './logger';

const storageLogger = createLogger('storage');

/**
 * ファイル名から安全でない文字を除去
 */
function sanitizeFileName(fileName: string): string {
    return fileName
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_{2,}/g, '_')
        .substring(0, 100);
}

export interface AudioUploadMetadata {
    originalFileName: string;
    originalFileType: 'video' | 'audio';
    bitrate?: string;
    sampleRate?: string;
}

/**
 * 音声ファイルを Firebase Storage にアップロードし、Storage 上のパスを返す。
 * #4: 文書生成はサーバがこのパスから読むので、アップロード失敗は文書生成の失敗でもある。
 * 以前の「失敗しても null で続行 (ベストエフォート)」はやめ、失敗はそのまま投げる。
 */
export async function uploadAudioToStorage(
    audioBlob: Blob,
    fileName: string,
    metadata: AudioUploadMetadata
): Promise<string> {
    try {
        const ownerId = getCurrentUserId();
        const ownerType = getOwnerType();
        const timestamp = Date.now();
        const sanitizedName = sanitizeFileName(fileName);
        const storagePath = `audio/${ownerId}/${timestamp}_${sanitizedName}.mp3`;

        storageLogger.info('音声ファイルのアップロードを開始', {
            storagePath,
            blobSize: audioBlob.size,
            ownerId,
        });

        const storageRef = ref(storage, storagePath);
        await uploadBytes(storageRef, audioBlob, {
            contentType: 'audio/mpeg',
            customMetadata: {
                ownerId,
                ownerType,
                originalFileName: metadata.originalFileName,
                originalFileType: metadata.originalFileType,
                ...(metadata.bitrate && { bitrate: metadata.bitrate }),
                ...(metadata.sampleRate && { sampleRate: metadata.sampleRate }),
            },
        });

        storageLogger.info('音声ファイルのアップロードが完了', { storagePath });
        return storagePath;
    } catch (error) {
        storageLogger.error('音声ファイルのアップロードに失敗（文書生成は行えない）', error, { fileName });
        throw error;
    }
}

/**
 * Firebase Storage のパスからダウンロード URL を取得
 */
/**
 * Storage 上の音声を削除する。
 *
 * 文字起こしの分割で作ったチャンク音声を、ジョブ完了後に片付けるために使う。
 * チャンクは元音声より本数が増えるので、残すと容量と露出の両方を増やす (設計 §7.2)。
 *
 * 🔴 **既に無い場合は成功として扱う。** 再試行や二重実行で `object-not-found` になっても、
 * 「消えている」という目的は達しているため。それ以外のエラーは呼び出し側へ投げる。
 */
export async function deleteAudioFromStorage(storagePath: string): Promise<void> {
    try {
        await deleteObject(ref(storage, storagePath));
    } catch (error) {
        if ((error as { code?: string } | null)?.code === 'storage/object-not-found') return;
        throw error;
    }
}

export async function getAudioDownloadURL(storagePath: string): Promise<string> {
    const storageRef = ref(storage, storagePath);
    return getDownloadURL(storageRef);
}

/**
 * Firebase Storage にファイルが存在するか確認
 */
export async function audioExists(storagePath: string): Promise<boolean> {
    try {
        const storageRef = ref(storage, storagePath);
        await getMetadata(storageRef);
        return true;
    } catch {
        return false;
    }
}

/**
 * Firebase Storage のパスから直接 Blob を取得（CORS 不要）
 */
export async function getAudioBlob(storagePath: string): Promise<Blob> {
    storageLogger.info('音声ファイルの Blob 取得を開始', { storagePath });
    const storageRef = ref(storage, storagePath);
    const blob = await getBlob(storageRef);
    storageLogger.info('音声ファイルの Blob 取得が完了', { storagePath, size: blob.size });
    return blob;
}

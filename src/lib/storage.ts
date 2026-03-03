import { storage } from './firebase';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
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
 * 音声ファイルを Firebase Storage にアップロード
 * エラー時は null を返し、ログのみ記録（ベストエフォート）
 */
export async function uploadAudioToStorage(
    audioBlob: Blob,
    fileName: string,
    metadata: AudioUploadMetadata
): Promise<string | null> {
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
        storageLogger.error('音声ファイルのアップロードに失敗（文書生成は続行）', error, { fileName });
        return null;
    }
}

/**
 * Firebase Storage のパスからダウンロード URL を取得
 */
export async function getAudioDownloadURL(storagePath: string): Promise<string> {
    const storageRef = ref(storage, storagePath);
    return getDownloadURL(storageRef);
}

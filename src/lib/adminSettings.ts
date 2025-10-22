/**
 * 管理者設定
 */

import { db } from './firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

export interface AdminSettings {
    maxPromptSize: number; // バイト単位
    maxDocumentSize: number; // バイト単位
    rateLimit: {
        promptsPerHour: number;
        documentsPerHour: number;
    };
    updatedAt?: Date;
    updatedBy?: string;
}

const DEFAULT_SETTINGS: AdminSettings = {
    maxPromptSize: 50000, // 50KB
    maxDocumentSize: 500000, // 500KB
    rateLimit: {
        promptsPerHour: 100,
        documentsPerHour: 50,
    },
};

/**
 * 管理者設定を取得
 */
export async function getAdminSettings(): Promise<AdminSettings> {
    try {
        const docRef = doc(db, 'adminSettings', 'config');
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            return docSnap.data() as AdminSettings;
        }

        // 設定が存在しない場合、デフォルトを返す
        return DEFAULT_SETTINGS;
    } catch (error) {
        console.error('管理者設定取得エラー:', error);
        return DEFAULT_SETTINGS;
    }
}

/**
 * 管理者設定を更新（管理者のみ）
 */
export async function updateAdminSettings(
    settings: Partial<AdminSettings>,
    updatedBy: string
): Promise<void> {
    try {
        const docRef = doc(db, 'adminSettings', 'config');
        await setDoc(
            docRef,
            {
                ...settings,
                updatedAt: serverTimestamp(),
                updatedBy,
            },
            { merge: true }
        );
    } catch (error) {
        console.error('管理者設定更新エラー:', error);
        throw new Error('管理者設定の更新に失敗しました');
    }
}

/**
 * プロンプトのサイズをチェック
 */
export async function validatePromptSize(content: string): Promise<{ valid: boolean; size: number; maxSize: number }> {
    const size = new Blob([content]).size;
    const settings = await getAdminSettings();

    return {
        valid: size <= settings.maxPromptSize,
        size,
        maxSize: settings.maxPromptSize,
    };
}

/**
 * 文書のサイズをチェック
 */
export async function validateDocumentSize(content: string): Promise<{ valid: boolean; size: number; maxSize: number }> {
    const size = new Blob([content]).size;
    const settings = await getAdminSettings();

    return {
        valid: size <= settings.maxDocumentSize,
        size,
        maxSize: settings.maxDocumentSize,
    };
}


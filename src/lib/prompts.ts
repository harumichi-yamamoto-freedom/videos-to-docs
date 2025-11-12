import { db } from './firebase';
import {
    collection,
    addDoc,
    getDocs,
    query,
    orderBy,
    deleteDoc,
    doc,
    updateDoc,
    where,
    serverTimestamp,
} from 'firebase/firestore';
import { getCurrentUserId, getOwnerType } from './auth';
import { logAudit } from './auditLog';
import { validatePromptSize, getDefaultPrompts } from './adminSettings';
import { updateUserStats } from './userManagement';

export interface Prompt {
    id?: string;
    name: string;
    content: string;
    isDefault: boolean;
    ownerType: 'guest' | 'user';
    ownerId: string; // "GUEST" または Auth uid
    createdBy: string; // "GUEST" または Auth uid
    createdAt: Date;
    updatedAt: Date;
}

// デフォルトプロンプトは adminSettings から取得するようになりました

/**
 * デフォルトプロンプトを初期化
 * ユーザーが所有しているプロンプトが0個の場合、そのユーザー専有のデフォルトプロンプトを作成
 * ゲストの場合もゲスト共有のデフォルトプロンプトを作成
 */
export async function initializeDefaultPrompts(): Promise<void> {
    try {
        const existingPrompts = await getPrompts();

        // 現在のユーザーが所有しているプロンプトが0個の場合のみ、デフォルトプロンプトを作成
        if (existingPrompts.length === 0) {
            const userId = getCurrentUserId();
            const ownerType = getOwnerType();

            // DBからデフォルトプロンプトテンプレートを取得
            const defaultPromptTemplates = await getDefaultPrompts();

            for (const template of defaultPromptTemplates) {
                await addDoc(collection(db, 'prompts'), {
                    name: template.name,
                    content: template.content,
                    isDefault: true,
                    ownerType,
                    ownerId: userId,
                    createdBy: userId,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
            }
        }
    } catch (error) {
        console.error('デフォルトプロンプト初期化エラー:', error);
    }
}

/**
 * 特定のユーザー用のデフォルトプロンプトを作成
 * アカウント作成時に1回だけ呼ばれる
 */
export async function createDefaultPromptsForUser(userId: string, ownerType: 'user' | 'guest'): Promise<void> {
    try {
        // 既にプロンプトが存在するかチェック
        const q = query(
            collection(db, 'prompts'),
            where('ownerId', '==', userId)
        );
        const existingPrompts = await getDocs(q);

        if (existingPrompts.empty) {
            console.log(`ユーザー ${userId} のデフォルトプロンプトを作成中...`);

            // DBからデフォルトプロンプトテンプレートを取得
            const defaultPromptTemplates = await getDefaultPrompts();

            for (const template of defaultPromptTemplates) {
                await addDoc(collection(db, 'prompts'), {
                    name: template.name,
                    content: template.content,
                    isDefault: true,
                    ownerType,
                    ownerId: userId,
                    createdBy: userId,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
            }

            console.log(`✅ ユーザー ${userId} のデフォルトプロンプト作成完了`);
        }
    } catch (error) {
        console.error('デフォルトプロンプト作成エラー:', error);
        // エラーが発生してもアカウント作成は続行
    }
}

/**
 * プロンプトを作成
 */
export async function createPrompt(
    name: string,
    content: string,
    isDefault: boolean = false
): Promise<string> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        // サイズチェック
        const sizeValidation = await validatePromptSize(content);
        if (!sizeValidation.valid) {
            throw new Error(
                `プロンプトのサイズが上限を超えています。` +
                `（現在: ${(sizeValidation.size / 1024).toFixed(2)}KB / ` +
                `上限: ${(sizeValidation.maxSize / 1024).toFixed(2)}KB）`
            );
        }

        const docRef = await addDoc(collection(db, 'prompts'), {
            name,
            content,
            isDefault,
            ownerType,
            ownerId: userId,
            createdBy: userId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });

        // 監査ログを記録
        await logAudit('prompt_create', 'prompt', docRef.id, { name, ownerType });

        // ユーザー統計を更新
        if (ownerType === 'user') {
            await updateUserStats(userId, 1, 0);
        }

        return docRef.id;
    } catch (error) {
        console.error('プロンプト作成エラー:', error);
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('プロンプトの作成に失敗しました');
    }
}

/**
 * プロンプト一覧を取得（現在のユーザーが所有しているプロンプトのみ）
 * ゲストの場合: ownerType == "guest" のプロンプトを取得
 * ログイン済みの場合: ownerId == auth.uid のプロンプトを取得
 */
export async function getPrompts(): Promise<Prompt[]> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        let q;
        if (ownerType === 'guest') {
            // ゲストの場合: ゲスト共有のプロンプトを取得
            q = query(
                collection(db, 'prompts'),
                where('ownerType', '==', 'guest'),
                orderBy('createdAt', 'desc')
            );
        } else {
            // ログイン済みの場合: 自分のプロンプトのみ取得
            q = query(
                collection(db, 'prompts'),
                where('ownerId', '==', userId),
                orderBy('createdAt', 'desc')
            );
        }

        const querySnapshot = await getDocs(q);
        const prompts: Prompt[] = [];

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();

            // 移行期間中: フィールドがない場合はゲスト扱い
            const ownerType = data.ownerType || 'guest';
            const ownerId = data.ownerId || 'GUEST';
            const createdBy = data.createdBy || 'GUEST';

            // ログインユーザーの場合、ゲストデータを除外
            if (getOwnerType() === 'user' && ownerType === 'guest') {
                return; // スキップ
            }

            // タイムスタンプがnullの場合のフォールバック
            const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();
            const updatedAt = data.updatedAt ? data.updatedAt.toDate() : new Date();

            prompts.push({
                id: docSnapshot.id,
                name: data.name,
                content: data.content,
                isDefault: data.isDefault || false,
                ownerType: ownerType as 'guest' | 'user',
                ownerId: ownerId,
                createdBy: createdBy,
                createdAt,
                updatedAt,
            });
        });

        return prompts;
    } catch (error) {
        console.error('プロンプト取得エラー:', error);
        throw new Error('プロンプトの取得に失敗しました');
    }
}

/**
 * プロンプトを更新
 * 注意: ownerType と ownerId は変更不可（Firestore Rules で保護）
 */
export async function updatePrompt(
    promptId: string,
    updates: { name?: string; content?: string }
): Promise<void> {
    try {
        // コンテンツが更新される場合、サイズチェック
        if (updates.content) {
            const sizeValidation = await validatePromptSize(updates.content);
            if (!sizeValidation.valid) {
                throw new Error(
                    `プロンプトのサイズが上限を超えています。` +
                    `（現在: ${(sizeValidation.size / 1024).toFixed(2)}KB / ` +
                    `上限: ${(sizeValidation.maxSize / 1024).toFixed(2)}KB）`
                );
            }
        }

        await updateDoc(doc(db, 'prompts', promptId), {
            ...updates,
            updatedAt: serverTimestamp(),
        });

        // 監査ログを記録
        await logAudit('prompt_update', 'prompt', promptId, updates);
    } catch (error) {
        console.error('プロンプト更新エラー:', error);
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('プロンプトの更新に失敗しました');
    }
}

/**
 * プロンプトを削除
 */
export async function deletePrompt(promptId: string): Promise<void> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        await deleteDoc(doc(db, 'prompts', promptId));

        // 監査ログを記録
        await logAudit('prompt_delete', 'prompt', promptId);

        // ユーザー統計を更新
        if (ownerType === 'user') {
            await updateUserStats(userId, -1, 0);
        }
    } catch (error) {
        console.error('プロンプト削除エラー:', error);
        throw new Error('プロンプトの削除に失敗しました');
    }
}


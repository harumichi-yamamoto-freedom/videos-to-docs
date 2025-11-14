import { db } from './firebase';
import {
    collection,
    addDoc,
    getDocs,
    getDoc,
    query,
    orderBy,
    deleteDoc,
    doc,
    setDoc,
    updateDoc,
    where,
    serverTimestamp,
    limit,
} from 'firebase/firestore';
import { getCurrentUserId, getOwnerType } from './auth';
import { logAudit } from './auditLog';
import { validatePromptSize, getDefaultPrompts } from './adminSettings';
import { updateUserStats } from './userManagement';
import { DEFAULT_GEMINI_MODEL } from '../constants/geminiModels';
import { createLogger } from './logger';

const promptsLogger = createLogger('prompts');

function createDeterministicHash(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash << 5) - hash + value.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
}

function generateDefaultPromptId(ownerId: string, templateName: string): string {
    const hash = createDeterministicHash(`${ownerId}:${templateName}`);
    return `default_${ownerId}_${hash}`;
}

async function ensureDefaultPromptExists(
    template: { name: string; content: string; model?: string },
    ownerId: string,
    ownerType: 'guest' | 'user',
    createdBy: string
): Promise<void> {
    const docId = generateDefaultPromptId(ownerId, template.name);
    const promptRef = doc(db, 'prompts', docId);
    const existingDoc = await getDoc(promptRef);

    if (existingDoc.exists()) {
        return;
    }

    await setDoc(promptRef, {
        name: template.name,
        content: template.content,
        model: template.model || DEFAULT_GEMINI_MODEL,
        isDefault: true,
        ownerType,
        ownerId,
        createdBy,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
}

async function ensureDefaultPromptsForOwner(
    ownerId: string,
    ownerType: 'guest' | 'user',
    createdBy: string,
    templates?: { name: string; content: string; model?: string }[]
): Promise<void> {
    const defaultPromptTemplates = templates ?? (await getDefaultPrompts());
    await Promise.all(
        defaultPromptTemplates.map((template) =>
            ensureDefaultPromptExists(template, ownerId, ownerType, createdBy)
        )
    );
}

export interface Prompt {
    id?: string;
    name: string;
    content: string;
    model: string;
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

            await ensureDefaultPromptsForOwner(userId, ownerType, userId);
        }
    } catch (error) {
        promptsLogger.error('デフォルトプロンプトの初期化に失敗', error);
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
            promptsLogger.info('ユーザー固有のデフォルトプロンプト作成を開始', { userId });

            await ensureDefaultPromptsForOwner(userId, ownerType, userId);

            promptsLogger.info('ユーザー固有のデフォルトプロンプト作成が完了', { userId });
        }
    } catch (error) {
        promptsLogger.error('デフォルトプロンプトの作成に失敗', error, { userId, ownerType });
        // エラーが発生してもアカウント作成は続行
    }
}

/**
 * プロンプトを作成
 */
export async function createPrompt(
    name: string,
    content: string,
    isDefault: boolean = false,
    model: string = DEFAULT_GEMINI_MODEL
): Promise<string> {
    const userId = getCurrentUserId();
    const ownerType = getOwnerType();

    try {

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
            model,
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
        promptsLogger.error('プロンプトの作成に失敗', error, { name, ownerType });
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
                model: data.model || DEFAULT_GEMINI_MODEL,
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
        promptsLogger.error('プロンプト一覧の取得に失敗', error);
        throw new Error('プロンプトの取得に失敗しました');
    }
}

export async function getPromptsByOwnerId(ownerId: string, limitCount: number = 100): Promise<Prompt[]> {
    try {
        const q = query(
            collection(db, 'prompts'),
            where('ownerId', '==', ownerId),
            orderBy('createdAt', 'desc'),
            limit(limitCount)
        );

        const querySnapshot = await getDocs(q);
        const prompts: Prompt[] = [];

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();
            const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();
            const updatedAt = data.updatedAt ? data.updatedAt.toDate() : new Date();

            prompts.push({
                id: docSnapshot.id,
                name: data.name,
                content: data.content,
                model: data.model || DEFAULT_GEMINI_MODEL,
                isDefault: data.isDefault || false,
                ownerType: data.ownerType || 'user',
                ownerId: data.ownerId || ownerId,
                createdBy: data.createdBy || ownerId,
                createdAt,
                updatedAt,
            });
        });

        return prompts;
    } catch (error) {
        promptsLogger.error('指定ユーザーのプロンプト取得に失敗', error, { ownerId, limitCount });
        throw new Error('指定したユーザーのプロンプト取得に失敗しました');
    }
}

/**
 * プロンプトを更新
 * 注意: ownerType と ownerId は変更不可（Firestore Rules で保護）
 */
export async function updatePrompt(
    promptId: string,
    updates: { name?: string; content?: string; model?: string }
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
        promptsLogger.error('プロンプトの更新に失敗', error, { promptId });
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
        promptsLogger.error('プロンプトの削除に失敗', error, { promptId });
        throw new Error('プロンプトの削除に失敗しました');
    }
}

/**
 * ゲストユーザーのデフォルトプロンプトを管理者設定と同期
 * 管理者がデフォルトプロンプトを更新したときに呼ばれる
 * 既存のゲストデフォルトプロンプトをすべて削除して、管理者設定から再作成する
 * これにより、複数のプロンプト、個数の変化、順序の変更、名前変更などすべてに対応
 */
export async function syncGuestDefaultPrompts(): Promise<void> {
    try {
        // 管理者設定のデフォルトプロンプトを取得
        const defaultPromptTemplates = await getDefaultPrompts();

        // ゲストユーザーの既存のデフォルトプロンプトをすべて取得
        const q = query(
            collection(db, 'prompts'),
            where('ownerType', '==', 'guest'),
            where('isDefault', '==', true)
        );
        const existingGuestDefaults = await getDocs(q);

        // 既存のゲストデフォルトプロンプトをすべて削除
        const deletePromises = existingGuestDefaults.docs.map((docSnapshot) => {
            return deleteDoc(doc(db, 'prompts', docSnapshot.id));
        });
        await Promise.all(deletePromises);

        if (existingGuestDefaults.docs.length > 0) {
            promptsLogger.info('ゲストデフォルトプロンプトを削除', {
                deletedCount: existingGuestDefaults.docs.length,
            });
        }

        // 管理者設定のデフォルトプロンプトから新規作成
        await ensureDefaultPromptsForOwner('GUEST', 'guest', 'GUEST', defaultPromptTemplates);

        if (defaultPromptTemplates.length > 0) {
            promptsLogger.info('ゲストデフォルトプロンプトを再作成', {
                createdCount: defaultPromptTemplates.length,
            });
        }
    } catch (error) {
        promptsLogger.error('ゲストデフォルトプロンプトの同期に失敗', error);
        throw new Error('ゲストデフォルトプロンプトの同期に失敗しました');
    }
}


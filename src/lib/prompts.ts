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
    writeBatch,
} from 'firebase/firestore';
import { getCurrentUserId, getOwnerType } from './auth';
import { logAudit } from './auditLog';
import {
    validatePromptSize,
    getDefaultPrompts,
    isEquivalentDefaultPrompt,
    type DefaultPromptTemplate,
} from './adminSettings';
import { updateUserStats } from './userManagement';
import {
    canonicalizeGeminiModel,
    GEMINI_DEFAULT_MODEL_SENTINEL,
} from '../constants/geminiModels';
import {
    canonicalizeThinkingLevel,
    type GeminiThinkingLevel,
} from '../constants/geminiThinking';
import { createLogger } from './logger';

const promptsLogger = createLogger('prompts');

/**
 * 正規表現用の文字列をエスケープ
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    template: DefaultPromptTemplate,
    ownerId: string,
    ownerType: 'guest' | 'user',
    createdBy: string,
    requireCurrentOwner: boolean = false,
): Promise<void> {
    const docId = generateDefaultPromptId(ownerId, template.name);
    const promptRef = doc(db, 'prompts', docId);
    const existingDoc = await getDoc(promptRef);

    if (existingDoc.exists()) {
        return;
    }

    // 初期化の待機中に認証主体が変わっていた場合、旧世代の処理からは書き込まない。
    // getDoc より後、setDoc の直前で確認することで、待機中の認証変更も検知する。
    if (requireCurrentOwner) {
        const currentOwnerType = getOwnerType();
        const currentOwnerId = getCurrentUserId();
        if (currentOwnerType !== ownerType || currentOwnerId !== ownerId) {
            promptsLogger.info('認証主体が変わったためデフォルトプロンプトの初期化を中断', {
                expectedOwnerType: ownerType,
                expectedOwnerId: ownerId,
                currentOwnerType,
                currentOwnerId,
            });
            return;
        }
    }

    await setDoc(promptRef, {
        name: template.name,
        content: template.content,
        model: canonicalizeGeminiModel(template.model),
        thinkingLevel: canonicalizeThinkingLevel(template.thinkingLevel),
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
    templates?: DefaultPromptTemplate[],
    requireCurrentOwner: boolean = false,
): Promise<void> {
    const defaultPromptTemplates = templates ?? (await getDefaultPrompts());
    await Promise.all(
        defaultPromptTemplates.map((template) =>
            ensureDefaultPromptExists(
                template,
                ownerId,
                ownerType,
                createdBy,
                requireCurrentOwner,
            )
        )
    );
}

export interface Prompt {
    id?: string;
    name: string;
    content: string;
    model: string;
    thinkingLevel?: GeminiThinkingLevel;
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
export async function initializeDefaultPrompts(
    ownerType: 'guest' | 'user',
    ownerId: string,
): Promise<void> {
    try {
        const ownerPromptsQuery = query(
            collection(db, 'prompts'),
            where('ownerType', '==', ownerType),
            where('ownerId', '==', ownerId),
            limit(1),
        );
        const existingPrompts = await getDocs(ownerPromptsQuery);

        // 現在のユーザーが所有しているプロンプトが0個の場合のみ、デフォルトプロンプトを作成
        if (existingPrompts.empty) {
            await ensureDefaultPromptsForOwner(
                ownerId,
                ownerType,
                ownerId,
                undefined,
                true,
            );
        }
    } catch (error) {
        promptsLogger.error('デフォルトプロンプトの初期化に失敗', error, {
            ownerType,
            ownerId,
        });
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
 * ベース名に基づいて既存のプロンプトを検索
 * 例: "打ち合わせの流れ" で検索すると "打ち合わせの流れ", "打ち合わせの流れ (2)" などが該当
 */
async function findExistingPromptsByBaseName(
    ownerId: string,
    baseName: string
): Promise<Prompt[]> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        let q;
        if (ownerType === 'guest') {
            q = query(
                collection(db, 'prompts'),
                where('ownerType', '==', 'guest'),
                orderBy('createdAt', 'desc')
            );
        } else {
            q = query(
                collection(db, 'prompts'),
                where('ownerId', '==', userId),
                orderBy('createdAt', 'desc')
            );
        }

        const querySnapshot = await getDocs(q);
        const prompts: Prompt[] = [];

        // baseName または "baseName (数字)" にマッチするプロンプトをフィルタ
        const pattern = new RegExp(`^${escapeRegExp(baseName)}(?: \\(\\d+\\))?$`);

        querySnapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();

            if (pattern.test(data.name)) {
                const ownerType = data.ownerType || 'guest';
                const ownerId = data.ownerId || 'GUEST';
                const createdBy = data.createdBy || 'GUEST';
                const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();
                const updatedAt = data.updatedAt ? data.updatedAt.toDate() : new Date();

                prompts.push({
                    id: docSnapshot.id,
                    name: data.name,
                    content: data.content,
                    model: canonicalizeGeminiModel(data.model),
                    thinkingLevel: canonicalizeThinkingLevel(data.thinkingLevel),
                    isDefault: data.isDefault || false,
                    ownerType: ownerType as 'guest' | 'user',
                    ownerId: ownerId,
                    createdBy: createdBy,
                    createdAt,
                    updatedAt,
                });
            }
        });

        return prompts;
    } catch (error) {
        promptsLogger.error('ベース名によるプロンプト検索に失敗', error, { ownerId, baseName });
        return [];
    }
}

/**
 * 次のプロンプト名を決定（最大値+1方式）
 */
function getNextPromptName(existingPrompts: Prompt[], baseName: string): string {
    const pattern = new RegExp(`^${escapeRegExp(baseName)}(?: \\((\\d+)\\))?$`);
    const numbers: number[] = [];

    existingPrompts.forEach(prompt => {
        const match = prompt.name.match(pattern);
        if (match) {
            if (match[1]) {
                // "(2)", "(3)" などの場合
                numbers.push(parseInt(match[1]));
            } else {
                // 連番なし（ベース名そのまま）の場合は1として扱う
                numbers.push(1);
            }
        }
    });

    // 既存プロンプトがない場合は連番なし
    if (numbers.length === 0) {
        return baseName;
    }

    // 最大値を取得
    const maxNumber = Math.max(...numbers);

    // 次の名前を返す
    const nextNumber = maxNumber + 1;
    return `${baseName} (${nextNumber})`;
}

/**
 * デフォルトプロンプトを追加（連番付き、決定論的ID）
 */
async function addDefaultPrompt(
    template: DefaultPromptTemplate,
    ownerId: string,
    ownerType: 'guest' | 'user',
    createdBy: string
): Promise<void> {
    // 1. 既存のプロンプトを検索
    const existingPrompts = await findExistingPromptsByBaseName(ownerId, template.name);

    // 2. 次の名前を決定
    const newName = getNextPromptName(existingPrompts, template.name);

    // 3. 決定論的IDを生成（新しい名前から）
    const docId = generateDefaultPromptId(ownerId, newName);

    // 4. 存在チェック
    const promptRef = doc(db, 'prompts', docId);
    const existingDoc = await getDoc(promptRef);

    if (existingDoc.exists()) {
        promptsLogger.info('デフォルトプロンプトは既に存在するためスキップ', {
            ownerId,
            name: newName,
        });
        return; // 既に存在するのでスキップ
    }

    // 5. setDocで作成（決定論的ID）
    await setDoc(promptRef, {
        name: newName,
        content: template.content,
        model: canonicalizeGeminiModel(template.model),
        thinkingLevel: canonicalizeThinkingLevel(template.thinkingLevel),
        isDefault: true,
        ownerType,
        ownerId,
        createdBy,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });

    promptsLogger.info('デフォルトプロンプトを追加', { ownerId, name: newName });
}

/**
 * デフォルトプロンプトを追加（ユーザーが明示的に追加ボタンを押した場合）
 * 既存のデフォルトプロンプト有無に関係なく、連番を付けて追加する
 * @param selectedTemplateNames 追加するテンプレート名の配列。指定がない場合は全てのテンプレートを追加
 */
export async function addDefaultPrompts(selectedTemplateNames?: string[]): Promise<void> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();
        const allTemplates = await getDefaultPrompts();

        // 選択されたテンプレート名が指定されている場合、それに該当するテンプレートのみをフィルタ
        const templates = selectedTemplateNames
            ? allTemplates.filter(template => selectedTemplateNames.includes(template.name))
            : allTemplates;

        promptsLogger.info('デフォルトプロンプトの追加を開始', {
            userId,
            ownerType,
            templateCount: templates.length,
            selectedCount: selectedTemplateNames?.length,
        });

        // 選択されたテンプレートのみを追加（連番付き）
        await Promise.all(
            templates.map((template) =>
                addDefaultPrompt(template, userId, ownerType, userId)
            )
        );

        promptsLogger.info('デフォルトプロンプトの追加が完了', { userId, ownerType });
    } catch (error) {
        promptsLogger.error('デフォルトプロンプトの追加に失敗', error);
        throw error; // エラーを上位に伝播
    }
}

/**
 * プロンプトを作成
 */
export async function createPrompt(
    name: string,
    content: string,
    isDefault: boolean = false,
    model: string = GEMINI_DEFAULT_MODEL_SENTINEL,
    thinkingLevel: GeminiThinkingLevel = 'default',
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
            thinkingLevel: canonicalizeThinkingLevel(thinkingLevel),
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
                model: canonicalizeGeminiModel(data.model),
                thinkingLevel: canonicalizeThinkingLevel(data.thinkingLevel),
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
                model: canonicalizeGeminiModel(data.model),
                thinkingLevel: canonicalizeThinkingLevel(data.thinkingLevel),
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
    updates: {
        name?: string;
        content?: string;
        model?: string;
        thinkingLevel?: GeminiThinkingLevel;
    }
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

        const canonicalUpdates = 'thinkingLevel' in updates
            ? {
                ...updates,
                thinkingLevel: canonicalizeThinkingLevel(updates.thinkingLevel),
            }
            : updates;

        await updateDoc(doc(db, 'prompts', promptId), {
            ...canonicalUpdates,
            updatedAt: serverTimestamp(),
        });

        // 監査ログを記録
        await logAudit('prompt_update', 'prompt', promptId, canonicalUpdates);
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
 * 決定論的 ID (ownerId + テンプレート名) をキーに差分だけを 1 つの batch で書く:
 * - テンプレートに無い既存 doc は削除
 * - 既存 doc は内容が変わった時だけ上書き (createdAt と所有者は保持)
 * - 無い doc は新規作成
 * 全削除→再作成をしないので、途中で切れてもゲストのプロンプトが 0 件になる窓は無く、
 * 変更の無かった doc の createdAt (一覧の並び) も動かない。
 */
export async function syncGuestDefaultPrompts(): Promise<void> {
    try {
        // adminSettings が直前に渡した保存済み snapshot を最初の await で消費する (順序を変えない)
        const defaultPromptTemplates = await getDefaultPrompts();

        // ゲストユーザーの既存のデフォルトプロンプトをすべて取得
        const q = query(
            collection(db, 'prompts'),
            where('ownerType', '==', 'guest'),
            where('isDefault', '==', true)
        );
        const existingGuestDefaults = await getDocs(q);
        const existingById = new Map(
            existingGuestDefaults.docs.map(docSnapshot => [docSnapshot.id, docSnapshot]),
        );

        const batch = writeBatch(db);
        const desiredIds = new Set<string>();
        const counts = { created: 0, updated: 0, unchanged: 0, deleted: 0 };

        for (const template of defaultPromptTemplates) {
            const docId = generateDefaultPromptId('GUEST', template.name);
            if (desiredIds.has(docId)) {
                // 同名テンプレートは同じ ID に畳まれる。管理画面が保存前に弾くが、二重書きを避けて先勝ちにする
                promptsLogger.info('同名のテンプレートが重複しているためスキップ', { name: template.name });
                continue;
            }
            desiredIds.add(docId);

            const promptRef = doc(db, 'prompts', docId);
            const fields = {
                name: template.name,
                content: template.content,
                model: canonicalizeGeminiModel(template.model),
                thinkingLevel: canonicalizeThinkingLevel(template.thinkingLevel),
            };
            const existing = existingById.get(docId);

            if (!existing) {
                batch.set(promptRef, {
                    ...fields,
                    isDefault: true,
                    ownerType: 'guest',
                    ownerId: 'GUEST',
                    createdBy: 'GUEST',
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
                counts.created += 1;
                continue;
            }

            const data = existing.data();
            const stored: DefaultPromptTemplate = {
                name: data.name,
                content: data.content,
                model: data.model,
                thinkingLevel: data.thinkingLevel,
            };
            if (isEquivalentDefaultPrompt(stored, fields)) {
                counts.unchanged += 1;
                continue;
            }

            // 内容だけ上書きし、createdAt と所有者フィールドは触らない
            batch.set(promptRef, { ...fields, updatedAt: serverTimestamp() }, { merge: true });
            counts.updated += 1;
        }

        for (const docSnapshot of existingGuestDefaults.docs) {
            if (desiredIds.has(docSnapshot.id)) continue;
            batch.delete(doc(db, 'prompts', docSnapshot.id));
            counts.deleted += 1;
        }

        if (counts.created + counts.updated + counts.deleted > 0) {
            await batch.commit();
        }

        promptsLogger.info('ゲストデフォルトプロンプトを同期', counts);
    } catch (error) {
        promptsLogger.error('ゲストデフォルトプロンプトの同期に失敗', error);
        throw new Error('ゲストデフォルトプロンプトの同期に失敗しました');
    }
}

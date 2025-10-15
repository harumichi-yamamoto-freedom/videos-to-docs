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
    Timestamp,
} from 'firebase/firestore';

export interface Prompt {
    id?: string;
    name: string;
    content: string;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * デフォルトプロンプト一覧
 */
export const DEFAULT_PROMPTS = [
    {
        name: '詳細な文字起こし',
        content: `以下の音声ファイルの内容を分析し、以下の形式でMarkdown文書を作成してください：

# タイトル
（音声の主題を簡潔に）

## 要約
（内容の要約を3-5文で）

## 詳細な内容
（話されている内容を詳しく記述）

## キーポイント
- （重要なポイント1）
- （重要なポイント2）
- （重要なポイント3）

音声が日本語の場合は日本語で、英語の場合は英語で文書を作成してください。`,
        isDefault: true,
    },
    {
        name: '議事録形式',
        content: `以下の音声ファイルを議事録形式で書き起こしてください：

# 会議タイトル

## 日時・参加者
（推測できる範囲で記載）

## 議題
（話し合われた主要なトピック）

## 決定事項
- （決まったこと1）
- （決まったこと2）

## アクションアイテム
- [ ] （誰が何をするか1）
- [ ] （誰が何をするか2）

## その他のメモ
（補足情報）`,
        isDefault: true,
    },
    {
        name: '要約のみ',
        content: `以下の音声ファイルの内容を簡潔に要約してください：

## 要約
（3-5文で内容を要約）

## キーワード
（重要なキーワードを5個まで列挙）`,
        isDefault: true,
    },
    {
        name: '学習ノート形式',
        content: `以下の音声ファイルを学習ノート形式でまとめてください：

# タイトル

## 学んだこと
（主要な学習内容）

## 重要な概念
1. **概念1**: 説明
2. **概念2**: 説明

## 例・具体例
（説明されている例）

## 質問・疑問点
（理解を深めるための質問）

## まとめ
（全体のまとめ）`,
        isDefault: true,
    },
];

/**
 * デフォルトプロンプトを初期化
 * プロンプトが一つも保存されていない場合のみ作成
 */
export async function initializeDefaultPrompts(): Promise<void> {
    try {
        const existingPrompts = await getPrompts();

        // プロンプトが一つも存在しない場合のみ、デフォルトプロンプトを作成
        if (existingPrompts.length === 0) {
            for (const defaultPrompt of DEFAULT_PROMPTS) {
                await addDoc(collection(db, 'prompts'), {
                    ...defaultPrompt,
                    createdAt: Timestamp.now(),
                    updatedAt: Timestamp.now(),
                });
            }
        }
    } catch (error) {
        console.error('デフォルトプロンプト初期化エラー:', error);
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
        const docRef = await addDoc(collection(db, 'prompts'), {
            name,
            content,
            isDefault,
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        });
        return docRef.id;
    } catch (error) {
        console.error('プロンプト作成エラー:', error);
        throw new Error('プロンプトの作成に失敗しました');
    }
}

/**
 * プロンプト一覧を取得
 */
export async function getPrompts(): Promise<Prompt[]> {
    try {
        const q = query(
            collection(db, 'prompts'),
            orderBy('createdAt', 'desc')
        );

        const querySnapshot = await getDocs(q);
        const prompts: Prompt[] = [];

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            prompts.push({
                id: doc.id,
                name: data.name,
                content: data.content,
                isDefault: data.isDefault || false,
                createdAt: data.createdAt.toDate(),
                updatedAt: data.updatedAt.toDate(),
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
 */
export async function updatePrompt(
    promptId: string,
    updates: { name?: string; content?: string }
): Promise<void> {
    try {
        await updateDoc(doc(db, 'prompts', promptId), {
            ...updates,
            updatedAt: Timestamp.now(),
        });
    } catch (error) {
        console.error('プロンプト更新エラー:', error);
        throw new Error('プロンプトの更新に失敗しました');
    }
}

/**
 * プロンプトを削除
 */
export async function deletePrompt(promptId: string): Promise<void> {
    try {
        await deleteDoc(doc(db, 'prompts', promptId));
    } catch (error) {
        console.error('プロンプト削除エラー:', error);
        throw new Error('プロンプトの削除に失敗しました');
    }
}


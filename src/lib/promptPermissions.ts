/**
 * プロンプト利用権限チェック
 */

import { Prompt } from './prompts';
import { getCurrentUserId, getOwnerType } from './auth';
import { isTranscriptPrompt } from './transcriptPrompt';

/**
 * プロンプトの利用権限があるかチェック
 * @param prompt チェック対象のプロンプト
 * @returns 権限がある場合true、ない場合false
 */
export function hasPromptPermission(prompt: Prompt): boolean {
    // 組み込みの「全文文字起こし」プロンプトは所有権チェックの対象外。
    // 実体は ownerType 'guest' / ownerId 'BUILTIN'（src/lib/transcriptPrompt.ts）で
    // Firestore には保存されず、全利用者に一覧の先頭で共通提供される。所有権で判定すると
    // ログインユーザー（ownerType 'user' を要求）が常に弾かれてしまう。
    // 判定は名前ではなく予約 ID（TRANSCRIPT_PROMPT_ID）で行う（isTranscriptPrompt）。
    if (isTranscriptPrompt(prompt)) {
        return true;
    }

    const currentUserId = getCurrentUserId();
    const currentOwnerType = getOwnerType();

    // ゲストの場合
    if (currentOwnerType === 'guest') {
        // ゲスト共有のプロンプトのみ利用可能
        return prompt.ownerType === 'guest';
    }

    // ログインユーザーの場合
    // 自分が所有しているプロンプトのみ利用可能
    return prompt.ownerType === 'user' && prompt.ownerId === currentUserId;
}

/**
 * プロンプトの利用権限をチェックし、権限がない場合はエラーを投げる
 * @param prompt チェック対象のプロンプト
 * @throws Error 権限がない場合
 */
export function validatePromptPermission(prompt: Prompt): void {
    if (!hasPromptPermission(prompt)) {
        const currentOwnerType = getOwnerType();
        const errorMessage = currentOwnerType === 'guest'
            ? `プロンプト「${prompt.name}」を利用する権限がありません。このプロンプトはログインユーザー専用です。`
            : `プロンプト「${prompt.name}」を利用する権限がありません。このプロンプトは他のユーザーが所有しています。`;

        throw new Error(errorMessage);
    }
}

/**
 * 複数のプロンプトの利用権限をまとめてチェック
 * @param prompts チェック対象のプロンプト配列
 * @returns { valid: boolean, invalidPrompts: Prompt[] }
 */
export function validateMultiplePrompts(prompts: Prompt[]): {
    valid: boolean;
    invalidPrompts: Prompt[];
} {
    const invalidPrompts = prompts.filter(p => !hasPromptPermission(p));

    return {
        valid: invalidPrompts.length === 0,
        invalidPrompts,
    };
}


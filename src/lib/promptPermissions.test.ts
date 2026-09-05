/**
 * プロンプト利用権限チェックの錠。
 *
 * 🔴 本番事故（2026-09-05）: ログインユーザーが組み込みの「全文文字起こし」プロンプトで
 * 生成すると「他のユーザーが所有しています」と弾かれた。組み込みプロンプトは
 * ownerType 'guest' / ownerId 'BUILTIN' なので、ログインユーザー（ownerType 'user' を
 * 要求）では所有権チェックを通れなかった。
 *
 * ここが崩れると、①組み込みプロンプトがログインユーザーで使えなくなる（本番事故の再発）、
 * あるいは逆に②他人の所有プロンプトを使えてしまう（権限の穴）ことになる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    hasPromptPermission,
    validateMultiplePrompts,
    validatePromptPermission,
} from './promptPermissions';
import { TRANSCRIPT_PROMPT } from './transcriptPrompt';
import { getCurrentUserId, getOwnerType } from './auth';
import type { Prompt } from './prompts';

// getCurrentUserId / getOwnerType は呼び出し時に評価されるので、テストごとに差し替える
vi.mock('./auth', () => ({
    getCurrentUserId: vi.fn(),
    getOwnerType: vi.fn(),
}));

const asLoggedIn = (uid: string) => {
    vi.mocked(getOwnerType).mockReturnValue('user');
    vi.mocked(getCurrentUserId).mockReturnValue(uid);
};

const asGuest = () => {
    vi.mocked(getOwnerType).mockReturnValue('guest');
    vi.mocked(getCurrentUserId).mockReturnValue('GUEST');
};

const userPrompt = (over: Partial<Prompt> = {}): Prompt => ({
    id: 'p-user-1',
    name: '議事録',
    content: '…',
    model: 'gemini-3.8-flash',
    isDefault: false,
    ownerType: 'user',
    ownerId: 'u1',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
});

const guestPrompt = (over: Partial<Prompt> = {}): Prompt =>
    userPrompt({ id: 'p-guest-1', ownerType: 'guest', ownerId: 'GUEST', createdBy: 'GUEST', ...over });

beforeEach(() => {
    vi.clearAllMocks();
});

describe('組み込み「全文文字起こし」プロンプトは所有権チェックの対象外', () => {
    it('🔴 ログインユーザーでも利用できる（本番事故の再発防止）', () => {
        asLoggedIn('u1');
        expect(hasPromptPermission(TRANSCRIPT_PROMPT)).toBe(true);
        expect(() => validatePromptPermission(TRANSCRIPT_PROMPT)).not.toThrow();
    });

    it('別のログインユーザーでも利用できる（所有者に縛られない）', () => {
        asLoggedIn('someone-else');
        expect(hasPromptPermission(TRANSCRIPT_PROMPT)).toBe(true);
        expect(() => validatePromptPermission(TRANSCRIPT_PROMPT)).not.toThrow();
    });

    it('ゲストでも利用できる（従来どおり）', () => {
        asGuest();
        expect(hasPromptPermission(TRANSCRIPT_PROMPT)).toBe(true);
        expect(() => validatePromptPermission(TRANSCRIPT_PROMPT)).not.toThrow();
    });

    it('判定は ID であって ownerType/ownerId ではない', () => {
        // 組み込みは ownerType 'guest'/ownerId 'BUILTIN' のまま。ID で素通ししている。
        asLoggedIn('u1');
        expect(TRANSCRIPT_PROMPT.ownerType).toBe('guest');
        expect(TRANSCRIPT_PROMPT.ownerId).toBe('BUILTIN');
        expect(hasPromptPermission(TRANSCRIPT_PROMPT)).toBe(true);
    });
});

describe('通常のユーザー所有プロンプト — 所有者だけが使える（正しいガードは維持）', () => {
    it('所有者本人は true', () => {
        asLoggedIn('u1');
        expect(hasPromptPermission(userPrompt({ ownerId: 'u1' }))).toBe(true);
    });

    it('🔴 他人が所有するプロンプトは false（権限の穴を開けない）', () => {
        asLoggedIn('u1');
        expect(hasPromptPermission(userPrompt({ ownerId: 'someone-else' }))).toBe(false);
    });

    it('他人所有プロンプトは validatePromptPermission が「他のユーザーが所有」で投げる', () => {
        asLoggedIn('u1');
        expect(() => validatePromptPermission(userPrompt({ ownerId: 'someone-else' }))).toThrow(
            /他のユーザーが所有/
        );
    });

    it('ゲストはユーザー所有プロンプトを使えない（従来どおり）', () => {
        asGuest();
        expect(hasPromptPermission(userPrompt({ ownerId: 'u1' }))).toBe(false);
        expect(() => validatePromptPermission(userPrompt({ ownerId: 'u1' }))).toThrow(
            /ログインユーザー専用/
        );
    });
});

describe('ゲスト共有プロンプト — 既存挙動を維持', () => {
    it('ゲストは利用できる', () => {
        asGuest();
        expect(hasPromptPermission(guestPrompt())).toBe(true);
    });

    it('ログインユーザーは（組み込みでない）ゲスト共有プロンプトは使えない（従来どおり）', () => {
        asLoggedIn('u1');
        expect(hasPromptPermission(guestPrompt())).toBe(false);
    });
});

describe('validateMultiplePrompts — まとめてチェック', () => {
    it('組み込み＋自分のプロンプトの混在はすべて valid（ログインユーザー）', () => {
        asLoggedIn('u1');
        const result = validateMultiplePrompts([TRANSCRIPT_PROMPT, userPrompt({ ownerId: 'u1' })]);
        expect(result.valid).toBe(true);
        expect(result.invalidPrompts).toHaveLength(0);
    });

    it('他人所有プロンプトだけが invalid として返る（組み込みは通す）', () => {
        asLoggedIn('u1');
        const foreign = userPrompt({ id: 'p-foreign', ownerId: 'someone-else' });
        const result = validateMultiplePrompts([TRANSCRIPT_PROMPT, foreign]);
        expect(result.valid).toBe(false);
        expect(result.invalidPrompts.map(p => p.id)).toEqual(['p-foreign']);
    });
});

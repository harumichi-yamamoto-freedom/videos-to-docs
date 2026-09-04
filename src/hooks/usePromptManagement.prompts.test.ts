/**
 * 組み込みプロンプトを一覧へ差し込む条件の錠。
 *
 * 既存の usePromptManagement.test.ts は「未取得＝空」の場合しか見ていないため、
 * 差し込みが効く側をここで固定する。
 */
import { describe, expect, it, vi } from 'vitest';

// usePromptManagement は firebase を引くので SDK 初期化だけ差し替える
vi.mock('@/lib/firebase', () => ({
    db: { name: 'mock' }, auth: { currentUser: null }, storage: { name: 'mock' },
}));
import { resolveAvailablePrompts } from './usePromptManagement';
import { TRANSCRIPT_PROMPT_ID } from '@/lib/transcriptPrompt';
import type { Prompt } from '@/lib/prompts';

const p = (id: string): Prompt => ({
    id, name: id, content: '', model: 'gemini-3.8-flash', isDefault: false,
    ownerType: 'user', ownerId: 'u', createdBy: 'u', createdAt: new Date(), updatedAt: new Date(),
});

describe('resolveAvailablePrompts', () => {
    it('取得成功なら組み込みが先頭に入る', () => {
        const list = resolveAvailablePrompts([p('a'), p('b')], 'success');
        expect(list[0].id).toBe(TRANSCRIPT_PROMPT_ID);
        expect(list.map(x => x.id).slice(1)).toEqual(['a', 'b']);
    });

    it('🔴 利用者のプロンプトが0件でも、成功なら組み込みは出る', () => {
        expect(resolveAvailablePrompts([], 'success').map(x => x.id)).toEqual([TRANSCRIPT_PROMPT_ID]);
    });

    it.each([
        ['読み込み中', 'loading'],
        ['未取得', 'idle'],
        ['失敗', 'error'],
    ])('🔴 %s のときは差し込まない（一覧が空なのに1件だけある状態を作らない）', (_l, status) => {
        expect(resolveAvailablePrompts([], status as 'loading')).toEqual([]);
        expect(resolveAvailablePrompts([p('a')], status as 'loading').map(x => x.id)).toEqual(['a']);
    });

    it('元の配列を書き換えない', () => {
        const src = [p('a')];
        resolveAvailablePrompts(src, 'success');
        expect(src).toHaveLength(1);
    });
});

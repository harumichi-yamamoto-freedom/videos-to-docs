/**
 * 組み込みプロンプトの錠。
 *
 * ここが崩れると「利用者の作った同名プロンプトが分割パイプラインへ流れる」
 * あるいは「文字起こしを選んだのに通常生成へ流れる」という取り違えが起きる。
 */
import { describe, expect, it } from 'vitest';
import {
    TRANSCRIPT_PREVIEW_NOTICE,
    TRANSCRIPT_PROMPT,
    TRANSCRIPT_PROMPT_ID,
    TRANSCRIPT_PROMPT_NAME,
    isTranscriptPrompt,
    withTranscriptPrompt,
} from './transcriptPrompt';
import type { Prompt } from '@/lib/prompts';

const userPrompt = (over: Partial<Prompt> = {}): Prompt => ({
    id: 'user-1', name: '議事録', content: '…', model: 'gemini-3.8-flash',
    isDefault: false, ownerType: 'user', ownerId: 'u1', createdBy: 'u1',
    createdAt: new Date(), updatedAt: new Date(), ...over,
});

describe('isTranscriptPrompt — 判定は ID であって名前ではない', () => {
    it('組み込みプロンプトは true', () => {
        expect(isTranscriptPrompt(TRANSCRIPT_PROMPT)).toBe(true);
    });

    it('🔴 同じ名前でも、利用者が作ったプロンプトは false', () => {
        // 名前で判定すると、利用者が「全文文字起こし」という名前のプロンプトを作った瞬間に
        // それが分割パイプラインへ流れてしまう。
        expect(isTranscriptPrompt(userPrompt({ name: TRANSCRIPT_PROMPT_NAME }))).toBe(false);
    });

    it.each([
        ['通常のプロンプト', userPrompt()],
        ['null', null],
        ['undefined', undefined],
        ['id なし', { name: TRANSCRIPT_PROMPT_NAME }],
    ])('%s は false', (_label, p) => {
        expect(isTranscriptPrompt(p as Prompt | null)).toBe(false);
    });
});

describe('withTranscriptPrompt — 一覧への差し込み', () => {
    it('先頭に差し込む', () => {
        const list = withTranscriptPrompt([userPrompt()]);
        expect(list[0].id).toBe(TRANSCRIPT_PROMPT_ID);
    });

    it('🔴 利用者のプロンプトを1件も落とさない', () => {
        const users = [userPrompt({ id: 'a' }), userPrompt({ id: 'b' }), userPrompt({ id: 'c' })];
        const list = withTranscriptPrompt(users);
        expect(list).toHaveLength(4);
        expect(list.slice(1).map(p => p.id)).toEqual(['a', 'b', 'c']);
    });

    it('🔴 二度呼んでも二重に出ない', () => {
        const once = withTranscriptPrompt([userPrompt()]);
        const twice = withTranscriptPrompt(once);
        expect(twice.filter(p => p.id === TRANSCRIPT_PROMPT_ID)).toHaveLength(1);
        expect(twice).toHaveLength(once.length);
    });

    it('空の一覧でも組み込みだけは出る', () => {
        expect(withTranscriptPrompt([]).map(p => p.id)).toEqual([TRANSCRIPT_PROMPT_ID]);
    });

    it('元の配列を書き換えない', () => {
        const users = [userPrompt()];
        withTranscriptPrompt(users);
        expect(users).toHaveLength(1);
    });
});

describe('組み込みプロンプトの素性', () => {
    it('文字起こし専用モデルを指す（主エンジン）', () => {
        // 🔴 これは表示用の名前でしかない。実際に起こしたエンジンはチャンクごとに変わり
        //    (MAI が落ちたら Gemini・設計 §3.7)、その正は応答の `engine` である。
        expect(TRANSCRIPT_PROMPT.model).toBe('MAI-Transcribe-2');
    });

    it('🔴 プレビュー版の断りが、起きうることと利用者の打つ手まで書いてある', () => {
        // 「不安定です」だけだと、利用者は何をすればよいか分からない (§6.5)
        expect(TRANSCRIPT_PREVIEW_NOTICE).toContain('プレビュー版');
        expect(TRANSCRIPT_PREVIEW_NOTICE).toContain('時間がかかったり');
        expect(TRANSCRIPT_PREVIEW_NOTICE).toContain('もう一度お試しください');
    });

    it('利用者のものと混ざらない所有者を持つ', () => {
        expect(TRANSCRIPT_PROMPT.ownerId).toBe('BUILTIN');
    });
});

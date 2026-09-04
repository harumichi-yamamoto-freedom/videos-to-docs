/**
 * 🔴 MAI (主) → Gemini (フォールバック) の切り替えの錠（設計 §3.7）。
 *
 * ここで守りたいのは3つ:
 *  - MAI が落ちても**本文が出る**こと
 *  - **落ちた事実が記録に残る**こと（用語集は MAI でしか効かないので、
 *    どの区間で用語が効いていないかが後から追えなくなる）
 *  - 「試して落ちた」と「設定が無くて試していない」を**混同しない**こと
 */
import { describe, expect, it, vi } from 'vitest';
import { transcribeWithFallback } from './transcribeWithFallback';
import type { TranscribeChunkResult } from '@/lib/transcribeApiContract';

const INPUT = {
    bytes: Buffer.from('audio'),
    mimeType: 'audio/mpeg',
    fileName: 'chunk0.mp3',
    audioSec: 600,
};

const result = (text: string, transport: TranscribeChunkResult['transport']): TranscribeChunkResult => ({
    status: 'completed', text, annotations: [], audioSec: 600, transport,
});

const CREDS = { endpoint: 'https://x.cognitiveservices.azure.com', apiKey: 'k' };

describe('MAI が成功するとき', () => {
    it('MAI の結果をそのまま返し、Gemini を呼ばない', async () => {
        const gemini = vi.fn();
        const outcome = await transcribeWithFallback(INPUT, {
            credentials: CREDS,
            makeMai: () => ({ transcribe: async () => result('MAIの本文', 'mai_multipart') }),
            makeGemini: () => ({ transcribe: gemini }),
        });
        expect(outcome.engine).toBe('mai');
        expect(outcome.result.text).toBe('MAIの本文');
        expect(outcome.maiAttempted).toBe(true);
        expect(outcome.fallbackReason).toBeUndefined();
        expect(gemini).not.toHaveBeenCalled();
    });
});

describe('🔴 MAI が落ちたとき', () => {
    it.each([
        ['408 タイムアウト', 'MAI が 115 秒以内に応答しませんでした。'],
        ['503 話者分離が使えない', 'MAI がエラーを返しました (503)。'],
        ['500', 'MAI がエラーを返しました (500)。'],
        ['接続断', 'MAI へ接続できませんでした。'],
    ])('%s → Gemini で本文が出る', async (_label, message) => {
        const outcome = await transcribeWithFallback(INPUT, {
            credentials: CREDS,
            makeMai: () => ({ transcribe: async () => { throw new Error(message); } }),
            makeGemini: () => ({ transcribe: async () => result('Geminiの本文', 'files_api') }),
        });
        expect(outcome.result.text).toBe('Geminiの本文');
        expect(outcome.engine).toBe('gemini');
    });

    it('🔴 落ちた理由を残す — 用語集が効いていない区間を後から追えるように', async () => {
        const outcome = await transcribeWithFallback(INPUT, {
            credentials: CREDS,
            makeMai: () => ({ transcribe: async () => { throw new Error('MAI がエラーを返しました (503)。'); } }),
            makeGemini: () => ({ transcribe: async () => result('本文', 'files_api') }),
        });
        expect(outcome.fallbackReason).toContain('503');
        expect(outcome.maiAttempted).toBe(true);
    });

    it('Gemini も落ちたら、その例外を投げる（黙って空を返さない）', async () => {
        await expect(transcribeWithFallback(INPUT, {
            credentials: CREDS,
            makeMai: () => ({ transcribe: async () => { throw new Error('MAI 失敗'); } }),
            makeGemini: () => ({ transcribe: async () => { throw new Error('Gemini も失敗'); } }),
        })).rejects.toThrow('Gemini も失敗');
    });
});

describe('🔴 「試して落ちた」と「試していない」を混同しない', () => {
    it('資格情報が無ければ Gemini だけで動き、maiAttempted は false', async () => {
        const mai = vi.fn();
        const outcome = await transcribeWithFallback(INPUT, {
            credentials: null,
            makeMai: () => ({ transcribe: mai }),
            makeGemini: () => ({ transcribe: async () => result('本文', 'files_api') }),
        });
        expect(outcome.engine).toBe('gemini');
        // 落ちたのではなく、そもそも投げていない。打つ手が違う（設定漏れ vs preview の不安定さ）
        expect(outcome.maiAttempted).toBe(false);
        expect(outcome.fallbackReason).toBeUndefined();
        expect(mai).not.toHaveBeenCalled();
    });
});

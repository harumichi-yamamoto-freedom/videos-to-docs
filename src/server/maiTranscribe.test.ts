/**
 * 🔴 MAI の出力を**共通形へ正規化**することの錠（設計 §3.7）。
 *
 * 品質ゲートは両エンジンの出力に同じものを当てる決まりなので、ここの写像がずれると
 * 「片方のエンジンだけ検査が緩い」という事故になる。
 */
import { describe, expect, it } from 'vitest';
import { buildMaiDefinition, extractMaiText, normalizeMaiPhrases } from './maiTranscribe';

describe('normalizeMaiPhrases', () => {
    it('ミリ秒を秒へ、句の話者を語へ配る', () => {
        const { annotations, speakers } = normalizeMaiPhrases([
            { speaker: 0, words: [{ text: 'こんにちは', offsetMilliseconds: 160, durationMilliseconds: 840 }] },
            { speaker: 1, words: [{ text: 'はい', offsetMilliseconds: 2000, durationMilliseconds: 500 }] },
        ]);
        expect(annotations).toEqual([
            { text: 'こんにちは', startSec: 0.16, endSec: 1, speaker: 'spk:0' },
            { text: 'はい', startSec: 2, endSec: 2.5, speaker: 'spk:1' },
        ]);
        expect(speakers).toBe(2);
    });

    it('🔴 時刻が読めない語は落とす — 0 で埋めない', () => {
        // 0 で埋めると G6 (最長穴) が「冒頭に注釈がある」と誤認して穴を短く見積もる
        const { annotations, droppedWords } = normalizeMaiPhrases([
            { speaker: 0, words: [
                { text: 'ok', offsetMilliseconds: 100, durationMilliseconds: 100 },
                { text: 'ng', offsetMilliseconds: null, durationMilliseconds: 100 },
                { text: 'ng2', durationMilliseconds: 100 },
            ] },
        ]);
        expect(annotations).toHaveLength(1);
        expect(droppedWords).toBe(2);
        expect(annotations[0]!.startSec).toBeGreaterThan(0);
    });

    it('話者分離が無効なら speaker は null（空文字を話者にしない）', () => {
        const { annotations, speakers } = normalizeMaiPhrases([
            { words: [{ text: 'a', offsetMilliseconds: 0, durationMilliseconds: 10 }] },
            { speaker: '', words: [{ text: 'b', offsetMilliseconds: 20, durationMilliseconds: 10 }] },
        ]);
        expect(annotations.map(a => a.speaker)).toEqual([null, null]);
        expect(speakers).toBe(0);
    });

    it.each([
        ['null', null], ['undefined', undefined], ['配列でない', { phrases: 1 }], ['空配列', []],
    ])('%s は 0 件（例外にしない）', (_label, input) => {
        expect(normalizeMaiPhrases(input).annotations).toEqual([]);
    });
});

describe('extractMaiText', () => {
    it('combinedPhrases を優先する', () => {
        expect(extractMaiText({
            combinedPhrases: [{ text: 'まとめ' }],
            phrases: [{ text: '句1' }, { text: '句2' }],
        })).toBe('まとめ');
    });

    it('combinedPhrases が無ければ phrases から組む', () => {
        expect(extractMaiText({ phrases: [{ text: '句1' }, { text: '句2' }] })).toBe('句1 句2');
    });

    it('どちらも無ければ空文字（例外にしない）', () => {
        expect(extractMaiText({})).toBe('');
    });
});

describe('buildMaiDefinition', () => {
    it('3 機能を同時に指定する — Gemini では 400 になる組み合わせ（設計 §1.5 / §3.7）', () => {
        const d = buildMaiDefinition(['アオイ建設']) as Record<string, never>;
        const enhanced = d.enhancedMode as unknown as Record<string, unknown>;
        expect(enhanced.model).toBe('MAI-Transcribe-2');
        expect((enhanced.modelOptions as Record<string, unknown>).timestamps).toBe('word');
        expect((d.diarization as unknown as Record<string, unknown>).enabled).toBe(true);
        expect((d.phraseList as unknown as Record<string, unknown>).phrases).toEqual(['アオイ建設']);
    });

    it('🔴 用語集が空なら phraseList ごと送らない（「空の用語集」と区別できなくなる）', () => {
        expect(buildMaiDefinition([])).not.toHaveProperty('phraseList');
    });

    it('相槌を落とさない verbatim を指定する（Gemini 側と揃える）', () => {
        const enhanced = buildMaiDefinition().enhancedMode as Record<string, unknown>;
        expect((enhanced.modelOptions as Record<string, unknown>).transcribeStyle).toBe('verbatim');
    });
});

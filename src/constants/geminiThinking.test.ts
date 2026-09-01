import { describe, expect, it } from 'vitest';
import {
    THINKING_LEVELS,
    canonicalizeThinkingLevel,
    resolveThinkingLevelForModel,
} from './geminiThinking';

describe('geminiThinking', () => {
    describe('THINKING_LEVELS', () => {
        it('各レベルの保存値・ラベル・説明を定義する', () => {
            expect(THINKING_LEVELS).toEqual([
                {
                    id: 'default',
                    label: '自動',
                    description: '標準・推奨',
                },
                {
                    id: 'low',
                    label: '低',
                    description: '高速・単純抽出向け',
                },
                {
                    id: 'medium',
                    label: '標準',
                    description: '',
                },
                {
                    id: 'high',
                    label: '高',
                    description: '多段推論向け・低速高コスト',
                },
            ]);
        });
    });

    describe('canonicalizeThinkingLevel', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
            ['空文字', ''],
            ['空白のみの文字列', ' \t\n'],
            ['未知の値', 'minimal'],
            ['大文字の値', 'HIGH'],
        ])('%s は default に揃える', (_name, level) => {
            expect(canonicalizeThinkingLevel(level)).toBe('default');
        });

        it.each([
            ['default', 'default'],
            ['low', 'low'],
            ['medium', 'medium'],
            ['high', 'high'],
        ])('%s はそのまま返す', (_name, level) => {
            expect(canonicalizeThinkingLevel(level)).toBe(level);
        });

        it.each([
            [' default ', 'default'],
            ['\tlow\n', 'low'],
            [' medium ', 'medium'],
            [' high ', 'high'],
        ])('前後空白のある %s は canonical 値 %s に揃える', (level, expected) => {
            expect(canonicalizeThinkingLevel(level)).toBe(expected);
        });
    });

    describe('resolveThinkingLevelForModel', () => {
        it.each([
            ['default', 'MEDIUM'],
            ['low', 'LOW'],
            ['medium', 'MEDIUM'],
            ['high', 'HIGH'],
        ])('Gemini 3.7 系では %s を %s に解決する', (level, expected) => {
            expect(resolveThinkingLevelForModel(level, 'gemini-3.7-flash')).toBe(
                expected,
            );
        });

        it('前方一致により将来の Gemini 3.7 系モデルにも適用する', () => {
            expect(
                resolveThinkingLevelForModel('high', 'gemini-3.7-future-preview'),
            ).toBe('HIGH');
        });

        it.each([
            ['undefined', undefined],
            ['null', null],
            ['空文字', ''],
            ['不正値', 'minimal'],
        ])('Gemini 3.7 系では %s を MEDIUM にフォールバックする', (_name, level) => {
            expect(resolveThinkingLevelForModel(level, 'gemini-3.7-flash')).toBe(
                'MEDIUM',
            );
        });

        it.each([
            'gemini-2.5-flash',
            'gemini-3.5-flash',
            'gemini-3.7',
            'gemini-3.70-flash',
            'future-gemini-model',
        ])('非対応モデル %s では undefined を返す', model => {
            expect(resolveThinkingLevelForModel('high', model)).toBeUndefined();
        });
    });
});

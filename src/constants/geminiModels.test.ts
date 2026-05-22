import { describe, it, expect } from 'vitest';
import {
    DEFAULT_GEMINI_MODEL,
    GEMINI_MODEL_OPTIONS,
    getGeminiModelLabel,
    getGeminiPricingLabelShort,
} from './geminiModels';

describe('geminiModels', () => {
    describe('getGeminiModelLabel', () => {
        it('既知のモデル ID から表示用ラベルを返す', () => {
            expect(getGeminiModelLabel('gemini-2.5-flash')).toBe('Gemini 2.5 Flash');
            expect(getGeminiModelLabel('gemini-3.5-flash')).toBe('Gemini 3.5 Flash');
        });

        it('未知のモデル ID は入力をそのまま返す', () => {
            expect(getGeminiModelLabel('unknown-model')).toBe('unknown-model');
        });
    });

    describe('getGeminiPricingLabelShort', () => {
        it('入力/出力価格を USD 表記で返す', () => {
            expect(getGeminiPricingLabelShort('gemini-2.5-flash')).toBe(
                '入力 $0.30 / 出力 $2.50',
            );
        });

        it('未知のモデルでは undefined を返す', () => {
            expect(getGeminiPricingLabelShort('unknown-model')).toBeUndefined();
        });
    });

    describe('GEMINI_MODEL_OPTIONS', () => {
        it('DEFAULT_GEMINI_MODEL が選択肢に含まれる', () => {
            expect(
                GEMINI_MODEL_OPTIONS.some(o => o.value === DEFAULT_GEMINI_MODEL),
            ).toBe(true);
        });

        it('全モデルに benchmark と pricing が定義されている', () => {
            for (const option of GEMINI_MODEL_OPTIONS) {
                expect(option.pricing, `${option.value} に pricing が必要`).toBeDefined();
                expect(option.benchmark, `${option.value} に benchmark が必要`).toBeDefined();
            }
        });
    });
});

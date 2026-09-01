import { describe, it, expect, vi } from 'vitest';
import {
    DEFAULT_GEMINI_MODEL,
    GEMINI_DEFAULT_MODEL_SENTINEL,
    GEMINI_MODEL_OPTIONS,
    canonicalizeGeminiModel,
    getGeminiModelLabel,
    getGeminiPricingLabelShort,
    resolveGeminiModel,
} from './geminiModels';

vi.mock('@/constants/geminiModels', async () => import('./geminiModels'));
vi.mock('@/constants/geminiThinking', async () => import('./geminiThinking'));

vi.mock('@/lib/prompts', () => ({
    updatePrompt: vi.fn(),
    deletePrompt: vi.fn(),
}));

vi.mock('../components/ContentEditModal', () => ({
    ContentEditModal: () => null,
}));

import { getModelComboboxKeyTransition } from '../components/ModelComboboxSelect';
import {
    PromptModelEditSessionState,
    hasPromptModelChanges,
    reducePromptModelEditSession,
} from '../components/PromptEditModal';

describe('geminiModels', () => {
    it('デフォルト選択を保存するセンチネル値は default で固定する', () => {
        expect(GEMINI_DEFAULT_MODEL_SENTINEL).toBe('default');
    });

    describe('canonicalizeGeminiModel', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
            ['空文字', ''],
            ['空白のみの文字列', ' \t\n'],
            ['前後に空白のあるセンチネル', ' default '],
        ])('%s は canonical なセンチネルに揃える', (_name, model) => {
            expect(canonicalizeGeminiModel(model)).toBe(
                GEMINI_DEFAULT_MODEL_SENTINEL,
            );
        });

        it.each([
            ['既知の具体的なモデル ID', 'gemini-2.5-flash'],
            ['未知の具体的なモデル ID', 'future-gemini-model'],
            ['前後に空白のある未知の具体的なモデル ID', '  future-gemini-model  '],
        ])('%s は加工しない', (_name, model) => {
            expect(canonicalizeGeminiModel(model)).toBe(model);
        });
    });

    describe('resolveGeminiModel', () => {
        it('デフォルトのセンチネルを現在の既定モデルに解決する', () => {
            expect(resolveGeminiModel(GEMINI_DEFAULT_MODEL_SENTINEL)).toBe(
                DEFAULT_GEMINI_MODEL,
            );
        });

        it.each([
            ['undefined', undefined],
            ['null', null],
            ['空文字', ''],
            ['空白のみの文字列', ' \t\n'],
            ['前後に空白のあるセンチネル', ' default '],
        ])('%s は現在の既定モデルに解決する', (_name, model) => {
            expect(resolveGeminiModel(model)).toBe(DEFAULT_GEMINI_MODEL);
        });

        it('既知の具体的なモデル ID はそのまま返す', () => {
            expect(resolveGeminiModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
        });

        it('未知の具体的なモデル ID は加工せずそのまま返す', () => {
            expect(resolveGeminiModel('  future-gemini-model  ')).toBe(
                '  future-gemini-model  ',
            );
        });
    });

    describe('getGeminiModelLabel', () => {
        it('既知のモデル ID から表示用ラベルを返す', () => {
            expect(getGeminiModelLabel('gemini-2.5-flash')).toBe('Gemini 2.5 Flash');
            expect(getGeminiModelLabel('gemini-3.5-flash')).toBe('Gemini 3.5 Flash');
            expect(getGeminiModelLabel('gemini-3.7-flash')).toBe('Gemini 3.7 Flash');
        });

        it('未知のモデル ID は入力をそのまま返す', () => {
            expect(getGeminiModelLabel('unknown-model')).toBe('unknown-model');
        });

        it('デフォルトのセンチネルは現在の既定モデルのラベルを含めて返す', () => {
            const defaultOption = GEMINI_MODEL_OPTIONS.find(
                option => option.value === DEFAULT_GEMINI_MODEL,
            );
            expect(defaultOption).toBeDefined();
            expect(getGeminiModelLabel(GEMINI_DEFAULT_MODEL_SENTINEL)).toBe(
                `デフォルト（${defaultOption?.label}）`,
            );
        });

        it.each([
            ['undefined', undefined],
            ['null', null],
            ['空文字', ''],
            ['空白のみの文字列', ' \t\n'],
            ['前後に空白のあるセンチネル', ' default '],
        ])('%s はセンチネルと同じラベルを返す', (_name, model) => {
            expect(getGeminiModelLabel(model)).toBe(
                getGeminiModelLabel(GEMINI_DEFAULT_MODEL_SENTINEL),
            );
        });
    });

    describe('getGeminiPricingLabelShort', () => {
        it('入力/出力価格を USD 表記で返す', () => {
            expect(getGeminiPricingLabelShort('gemini-2.5-flash')).toBe(
                '入力 $0.30 / 出力 $2.50',
            );
            expect(getGeminiPricingLabelShort('gemini-3.7-flash')).toBe(
                '入力 $0.75 / 出力 $3.75',
            );
        });

        it('未知のモデルでは undefined を返す', () => {
            expect(getGeminiPricingLabelShort('unknown-model')).toBeUndefined();
        });

        it('デフォルトのセンチネルには現在の既定モデルの価格を返す', () => {
            const defaultPricingLabel = getGeminiPricingLabelShort(DEFAULT_GEMINI_MODEL);
            expect(defaultPricingLabel).toBeDefined();
            expect(getGeminiPricingLabelShort(GEMINI_DEFAULT_MODEL_SENTINEL)).toBe(
                defaultPricingLabel,
            );
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

describe('getModelComboboxKeyTransition', () => {
    it('開いているときのEscはcomboboxだけで消費して閉じる', () => {
        expect(getModelComboboxKeyTransition(true, 'Escape')).toEqual({
            isOpen: false,
            shouldConsume: true,
        });
    });

    it('開いていてもEsc以外のキーは消費せず状態を維持する', () => {
        expect(getModelComboboxKeyTransition(true, 'Enter')).toEqual({
            isOpen: true,
            shouldConsume: false,
        });
    });

    it('閉じているときのEscは親へ伝播できる', () => {
        expect(getModelComboboxKeyTransition(false, 'Escape')).toEqual({
            isOpen: false,
            shouldConsume: false,
        });
    });
});

const FIXED_MODEL = 'gemini-2.5-pro';
const FIXED_THINKING_LEVEL = 'high';

function createPromptModelSession(): PromptModelEditSessionState {
    return {
        selectedModel: GEMINI_DEFAULT_MODEL_SENTINEL,
        savedModel: GEMINI_DEFAULT_MODEL_SENTINEL,
        selectedThinkingLevel: 'default',
        savedThinkingLevel: 'default',
        isViewMode: true,
    };
}

describe('reducePromptModelEditSession', () => {
    it('モデル選択をdirtyとして扱う', () => {
        const state = reducePromptModelEditSession(createPromptModelSession(), {
            type: 'select',
            model: FIXED_MODEL,
        });

        expect(state.selectedModel).toBe(FIXED_MODEL);
        expect(hasPromptModelChanges(state)).toBe(true);
    });

    it('思考レベル選択をdirtyとして扱う', () => {
        const state = reducePromptModelEditSession(createPromptModelSession(), {
            type: 'selectThinkingLevel',
            thinkingLevel: FIXED_THINKING_LEVEL,
        });

        expect(state.selectedThinkingLevel).toBe(FIXED_THINKING_LEVEL);
        expect(hasPromptModelChanges(state)).toBe(true);
    });

    it('未保存の編集から表示へ戻ると保存値へリセットする', () => {
        const editing = reducePromptModelEditSession(createPromptModelSession(), {
            type: 'viewModeChanged',
            isViewMode: false,
        });
        const changed = reducePromptModelEditSession(editing, {
            type: 'select',
            model: FIXED_MODEL,
        });
        const thinkingChanged = reducePromptModelEditSession(changed, {
            type: 'selectThinkingLevel',
            thinkingLevel: FIXED_THINKING_LEVEL,
        });

        const returnedToView = reducePromptModelEditSession(thinkingChanged, {
            type: 'viewModeChanged',
            isViewMode: true,
        });

        expect(returnedToView.selectedModel).toBe(GEMINI_DEFAULT_MODEL_SENTINEL);
        expect(returnedToView.selectedThinkingLevel).toBe('default');
        expect(hasPromptModelChanges(returnedToView)).toBe(false);
    });

    it('保存成功後の編集から表示への遷移は新しい保存値を維持する', () => {
        const editing = reducePromptModelEditSession(createPromptModelSession(), {
            type: 'viewModeChanged',
            isViewMode: false,
        });
        const changed = reducePromptModelEditSession(editing, {
            type: 'select',
            model: FIXED_MODEL,
        });
        const thinkingChanged = reducePromptModelEditSession(changed, {
            type: 'selectThinkingLevel',
            thinkingLevel: FIXED_THINKING_LEVEL,
        });
        const saved = reducePromptModelEditSession(thinkingChanged, {
            type: 'saveSucceeded',
        });

        const returnedToView = reducePromptModelEditSession(saved, {
            type: 'viewModeChanged',
            isViewMode: true,
        });

        expect(returnedToView.selectedModel).toBe(FIXED_MODEL);
        expect(returnedToView.savedModel).toBe(FIXED_MODEL);
        expect(returnedToView.selectedThinkingLevel).toBe(FIXED_THINKING_LEVEL);
        expect(returnedToView.savedThinkingLevel).toBe(FIXED_THINKING_LEVEL);
        expect(hasPromptModelChanges(returnedToView)).toBe(false);
    });

    it('表示から編集への遷移と同一モード通知では選択値を変えない', () => {
        const state: PromptModelEditSessionState = {
            selectedModel: FIXED_MODEL,
            savedModel: GEMINI_DEFAULT_MODEL_SENTINEL,
            selectedThinkingLevel: FIXED_THINKING_LEVEL,
            savedThinkingLevel: 'default',
            isViewMode: true,
        };

        const editing = reducePromptModelEditSession(state, {
            type: 'viewModeChanged',
            isViewMode: false,
        });
        const duplicate = reducePromptModelEditSession(editing, {
            type: 'viewModeChanged',
            isViewMode: false,
        });

        expect(editing.selectedModel).toBe(FIXED_MODEL);
        expect(editing.selectedThinkingLevel).toBe(FIXED_THINKING_LEVEL);
        expect(duplicate).toBe(editing);
    });

    it('resetはモデルと思考レベルのdefault相当値をcanonical値へ揃える', () => {
        const state = reducePromptModelEditSession(createPromptModelSession(), {
            type: 'reset',
            savedModel: ' default ',
            savedThinkingLevel: ' unknown ',
        });

        expect(state).toEqual(createPromptModelSession());
    });
});

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
    createPrompt: vi.fn(),
    updatePrompt: vi.fn(),
    deletePrompt: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn() }),
}));

vi.mock('../components/ContentEditModal', () => ({
    ContentEditModal: () => null,
}));

import {
    effectiveThinkingLevel,
    getModelComboboxKeyTransition,
    getThinkingLevelOptionLabel,
    supportsThinkingLevel,
} from '../components/ModelComboboxSelect';
import {
    type PromptCreateDraft,
    hasPromptCreateDraft,
    reducePromptCreateDraft,
} from '../components/PromptCreateModal';
import {
    type PromptEditSessionState,
    type PromptEditValues,
    createPromptEditValues,
    createPromptEditSession,
    hasPromptEditChanges,
    reducePromptEditSession,
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
                `標準（${defaultOption?.label}）`,
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

describe('思考レベルのモデル対応', () => {
    it('現在の既定モデルと3.7系だけを対応として扱う', () => {
        expect(supportsThinkingLevel(GEMINI_DEFAULT_MODEL_SENTINEL)).toBe(true);
        expect(supportsThinkingLevel('gemini-3.7-flash')).toBe(true);
        expect(supportsThinkingLevel('gemini-3.5-flash')).toBe(false);
        expect(supportsThinkingLevel('gemini-2.5-pro')).toBe(false);
    });

    it('defaultを実際の挙動に合わせて標準（推奨）と表示する', () => {
        expect(getThinkingLevelOptionLabel({
            id: 'default',
            label: '自動',
            description: '標準・推奨',
        })).toBe('標準（推奨）');
    });
});

function createEmptyPromptDraft(): PromptCreateDraft {
    return {
        name: '',
        content: '',
        model: GEMINI_DEFAULT_MODEL_SENTINEL,
        thinkingLevel: 'default',
    };
}

describe('reducePromptCreateDraft', () => {
    it.each([
        ['名前', { type: 'nameChanged', name: '議事録' } as const],
        ['内容', { type: 'contentChanged', content: '要約してください。' } as const],
        ['モデル', { type: 'modelChanged', model: 'gemini-3.7-flash' } as const],
        ['思考レベル', { type: 'thinkingLevelChanged', thinkingLevel: 'high' } as const],
    ])('%sの変更をドラフトとして扱う', (_name, action) => {
        const state = reducePromptCreateDraft(createEmptyPromptDraft(), action);
        expect(hasPromptCreateDraft(state)).toBe(true);
    });

    it('非対応モデル選択中は実効の思考レベルをdefaultへ落とす', () => {
        const high = reducePromptCreateDraft(createEmptyPromptDraft(), {
            type: 'thinkingLevelChanged',
            thinkingLevel: 'high',
        });
        const unsupported = reducePromptCreateDraft(high, {
            type: 'modelChanged',
            model: 'gemini-2.5-pro',
        });

        expect(
            effectiveThinkingLevel(unsupported.model, unsupported.thinkingLevel),
        ).toBe('default');

        const attemptedChange = reducePromptCreateDraft(unsupported, {
            type: 'thinkingLevelChanged',
            thinkingLevel: 'low',
        });
        expect(
            effectiveThinkingLevel(attemptedChange.model, attemptedChange.thinkingLevel),
        ).toBe('default');
    });

    it('非対応モデルを経由して戻ると選択済みの思考レベルを復元する', () => {
        const high = reducePromptCreateDraft(createEmptyPromptDraft(), {
            type: 'thinkingLevelChanged',
            thinkingLevel: 'high',
        });
        const unsupported = reducePromptCreateDraft(high, {
            type: 'modelChanged',
            model: 'gemini-2.5-pro',
        });
        const backToSupported = reducePromptCreateDraft(unsupported, {
            type: 'modelChanged',
            model: high.model,
        });

        expect(backToSupported.thinkingLevel).toBe('high');
        expect(
            effectiveThinkingLevel(backToSupported.model, backToSupported.thinkingLevel),
        ).toBe('high');
        expect(backToSupported).toEqual(high);
    });
});

const SAVED_VALUES: PromptEditValues = {
    title: '保存済みタイトル',
    content: '保存済み内容',
    model: GEMINI_DEFAULT_MODEL_SENTINEL,
    thinkingLevel: 'default',
};

function createEditSession(): PromptEditSessionState {
    return createPromptEditSession(SAVED_VALUES);
}

describe('reducePromptEditSession', () => {
    it('非対応モデルの保存済み思考レベルを初期化時にdefaultへ正規化する', () => {
        const values = createPromptEditValues({
            id: 'prompt-id',
            name: SAVED_VALUES.title,
            content: SAVED_VALUES.content,
            model: 'gemini-2.5-pro',
            thinkingLevel: 'high',
            isDefault: false,
            ownerType: 'user',
            ownerId: 'owner-id',
            createdBy: 'owner-id',
            createdAt: new Date(0),
            updatedAt: new Date(0),
        });

        expect(values.thinkingLevel).toBe('default');
    });

    it.each([
        [
            'タイトル',
            { type: 'textChanged', title: '変更後', content: SAVED_VALUES.content } as const,
        ],
        [
            '本文',
            { type: 'textChanged', title: SAVED_VALUES.title, content: '変更後' } as const,
        ],
        [
            'モデル',
            { type: 'modelChanged', model: 'gemini-3.7-flash' } as const,
        ],
        [
            '思考レベル',
            { type: 'thinkingLevelChanged', thinkingLevel: 'high' } as const,
        ],
    ])('%sを単一セッションのdirty判定へ含める', (_name, action) => {
        const state = reducePromptEditSession(createEditSession(), action);

        expect(hasPromptEditChanges(state)).toBe(true);
    });

    it('破棄確定時に全フィールドを保存値へ一度に戻す', () => {
        const textChanged = reducePromptEditSession(createEditSession(), {
            type: 'textChanged',
            title: '変更後タイトル',
            content: '変更後本文',
        });
        const modelChanged = reducePromptEditSession(textChanged, {
            type: 'modelChanged',
            model: 'gemini-3.7-flash',
        });
        const thinkingChanged = reducePromptEditSession(modelChanged, {
            type: 'thinkingLevelChanged',
            thinkingLevel: 'high',
        });
        const discarded = reducePromptEditSession(thinkingChanged, {
            type: 'discardChanges',
        });

        expect(discarded.draft).toEqual(SAVED_VALUES);
        expect(hasPromptEditChanges(discarded)).toBe(false);
    });

    it('保存成功時に全フィールドをsavedとdraftへ確定する', () => {
        const values: PromptEditValues = {
            title: '変更後タイトル',
            content: '変更後本文',
            model: 'gemini-3.7-flash',
            thinkingLevel: 'high',
        };
        const saved = reducePromptEditSession(createEditSession(), {
            type: 'saveSucceeded',
            values,
        });

        expect(saved).toEqual({ saved: values, draft: values });
        expect(hasPromptEditChanges(saved)).toBe(false);
    });

    it('非対応モデル選択中は実効の思考レベルをdefaultへ落とす', () => {
        const high = reducePromptEditSession(createEditSession(), {
            type: 'thinkingLevelChanged',
            thinkingLevel: 'high',
        });
        const unsupported = reducePromptEditSession(high, {
            type: 'modelChanged',
            model: 'gemini-2.5-pro',
        });

        expect(
            effectiveThinkingLevel(
                unsupported.draft.model,
                unsupported.draft.thinkingLevel,
            ),
        ).toBe('default');
        expect(hasPromptEditChanges(unsupported)).toBe(true);

        const attemptedChange = reducePromptEditSession(unsupported, {
            type: 'thinkingLevelChanged',
            thinkingLevel: 'low',
        });
        expect(
            effectiveThinkingLevel(
                attemptedChange.draft.model,
                attemptedChange.draft.thinkingLevel,
            ),
        ).toBe('default');
    });

    it('非対応モデルの保存値へ戻ると画面に出ない思考レベルの差でdirtyにしない', () => {
        // Saved on a model which cannot use a level at all.
        const savedUnsupported = createPromptEditSession({
            ...SAVED_VALUES,
            model: 'gemini-2.5-pro',
            thinkingLevel: 'default',
        });
        const onSupportedModel = reducePromptEditSession(savedUnsupported, {
            type: 'modelChanged',
            model: 'gemini-3.7-flash',
        });
        const picked = reducePromptEditSession(onSupportedModel, {
            type: 'thinkingLevelChanged',
            thinkingLevel: 'high',
        });
        const backToSaved = reducePromptEditSession(picked, {
            type: 'modelChanged',
            model: 'gemini-2.5-pro',
        });

        // The retained 'high' is not shown and would not be saved, so the
        // screen is identical to the saved prompt.
        expect(backToSaved.draft.thinkingLevel).toBe('high');
        expect(
            effectiveThinkingLevel(backToSaved.draft.model, backToSaved.draft.thinkingLevel),
        ).toBe('default');
        expect(hasPromptEditChanges(backToSaved)).toBe(false);
    });

    it('非対応モデルを経由して戻すと保存済みの思考レベルへ戻りdirtyも解消する', () => {
        const savedHigh = createPromptEditSession({
            ...SAVED_VALUES,
            model: 'gemini-3.7-flash',
            thinkingLevel: 'high',
        });
        const unsupported = reducePromptEditSession(savedHigh, {
            type: 'modelChanged',
            model: 'gemini-2.5-pro',
        });
        expect(hasPromptEditChanges(unsupported)).toBe(true);

        const backToSupported = reducePromptEditSession(unsupported, {
            type: 'modelChanged',
            model: 'gemini-3.7-flash',
        });

        expect(backToSupported.draft.thinkingLevel).toBe('high');
        expect(hasPromptEditChanges(backToSupported)).toBe(false);
    });
});

export interface GeminiModelOption {
    value: string;
    label: string;
    description: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const GEMINI_MODEL_OPTIONS: GeminiModelOption[] = [
    {
        value: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        description: '複雑な推論・コーディング・マルチモーダルタスク向けフラッグシップ。最高精度だがコスト高',
    },
    {
        value: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        description: '速度・コスト・精度のバランスに優れた標準モデル。ほとんどのタスクに対応',
    },
    {
        value: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash Lite',
        description: '超低コスト・超高速の軽量モデル。大量処理やドラフト生成に最適',
    },
    {
        value: 'gemini-3-pro-preview',
        label: 'Gemini 3 Pro (Preview)',
        description: '強力な推論・エージェント機能を持つGemini 3世代フラッグシップ（プレビュー版）',
    },
    {
        value: 'gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro (Preview)',
        description: '3 Proから推論力を大幅強化（ARC-AGI-2スコア2.5倍）。Deep Think Mini相当の高思考モード搭載（プレビュー版）',
    }
];

const GEMINI_MODEL_MAP = new Map(GEMINI_MODEL_OPTIONS.map(option => [option.value, option]));

export function getGeminiModelLabel(model: string): string {
    return GEMINI_MODEL_MAP.get(model)?.label || model;
}

export function getGeminiModelDescription(model: string): string | undefined {
    return GEMINI_MODEL_MAP.get(model)?.description;
}





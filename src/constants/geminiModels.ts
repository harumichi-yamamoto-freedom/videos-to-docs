export interface GeminiModelOption {
    value: string;
    label: string;
    description: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const GEMINI_MODEL_OPTIONS: GeminiModelOption[] = [
    {
        value: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        description: 'マルチモーダル対応・高速/低コストの標準モデル',
    },
    {
        value: 'gemini-2.0-flash-lite',
        label: 'Gemini 2.0 Flash Lite',
        description: '軽量・超高速でドラフト生成や大量処理向け',
    },
    {
        value: 'gemini-1.5-flash',
        label: 'Gemini 1.5 Flash',
        description: '長尺音声の要約などバランス型モデル',
    },
    {
        value: 'gemini-1.5-pro',
        label: 'Gemini 1.5 Pro',
        description: '最高精度・推論力重視のモデル（コスト高）',
    },
];

const GEMINI_MODEL_MAP = new Map(GEMINI_MODEL_OPTIONS.map(option => [option.value, option]));

export function getGeminiModelLabel(model: string): string {
    return GEMINI_MODEL_MAP.get(model)?.label || model;
}

export function getGeminiModelDescription(model: string): string | undefined {
    return GEMINI_MODEL_MAP.get(model)?.description;
}



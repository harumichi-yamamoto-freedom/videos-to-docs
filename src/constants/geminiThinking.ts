export type GeminiThinkingLevel = 'default' | 'low' | 'medium' | 'high';

export interface GeminiThinkingLevelOption {
    id: GeminiThinkingLevel;
    label: string;
    description: string;
}

export const THINKING_LEVELS: GeminiThinkingLevelOption[] = [
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
];

const DEFAULT_THINKING_LEVEL: GeminiThinkingLevel = 'default';
const THINKING_LEVEL_IDS = new Set<string>(THINKING_LEVELS.map(level => level.id));

// 思考レベル指定に対応するモデル世代。対応モデルが増えたら prefix を追加する。
const THINKING_LEVEL_MODEL_PREFIXES = ['gemini-3.7-', 'gemini-3.8-'] as const;

/**
 * Firestore/UI で扱う思考レベルを canonical な保存表現へ揃える。
 * 空値や未知の値はデフォルト選択へフォールバックする。
 */
export function canonicalizeThinkingLevel(level?: string | null): GeminiThinkingLevel {
    if (level == null) {
        return DEFAULT_THINKING_LEVEL;
    }

    const normalizedLevel = level.trim();
    if (!THINKING_LEVEL_IDS.has(normalizedLevel)) {
        return DEFAULT_THINKING_LEVEL;
    }

    return normalizedLevel as GeminiThinkingLevel;
}

/**
 * 対応モデルに渡す API 用の思考レベルを返す。
 * 非対応モデルでは thinkingConfig 自体を設定しないため undefined を返す。
 */
export function resolveThinkingLevelForModel(
    level: string | null | undefined,
    resolvedModelId: string,
): 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
    const supportsThinkingLevel = THINKING_LEVEL_MODEL_PREFIXES.some(prefix =>
        resolvedModelId.startsWith(prefix),
    );
    if (!supportsThinkingLevel) {
        return undefined;
    }

    const canonicalLevel = canonicalizeThinkingLevel(level);
    switch (canonicalLevel) {
        case 'low':
            return 'LOW';
        case 'high':
            return 'HIGH';
        case 'default':
        case 'medium':
            return 'MEDIUM';
    }
}

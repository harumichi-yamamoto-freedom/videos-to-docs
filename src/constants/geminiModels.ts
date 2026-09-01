export interface GeminiModelPricing {
    inputPerMTok: number;
    outputPerMTok: number;
    longContext?: {
        inputPerMTok: number;
        outputPerMTok: number;
        thresholdTokens: number;
    };
}

// 各モデルのベンチマーク評価。当サービス（音声/動画 → 文書）で重要な軸に絞っている。
//
// recognitionQuality（動画・音声の認識力）: ★1〜5
//   公式ベンチマークから相対順位を決定。
//   - FLEURS WER（多言語音声書き起こし精度）
//   - Video-MME（動画理解の総合スコア）
//   - MMMU-Pro（マルチモーダル理解の補完指標）
//   出典: Gemini 2.5 技術レポート (arxiv:2507.06261)、各モデル公式モデルカード。
//
// analysisQuality（分析・出力品質）: ★1〜5
//   プロンプト指示への追従と推論能力を相対評価。
//   - IFEval（指示追従の遵守度）
//   - MMMU-Pro（マルチモーダル推論）
//   - GPQA Diamond（難問理解）
//   出典: Artificial Analysis、各モデル公式モデルカード。
//
// estimatedSeconds（速度の素データ）: 「2時間音声 → A4 1〜2枚」の体感処理時間（秒）
//   計算式: 入力処理時間 + 思考時間（推論モデルのみ） + 出力tokens ÷ 出力tok/s
//   - 入力: 音声 32 tokens/sec × 7,200秒 = 230,400 tokens（Gemini API 公式レート）
//   - 出力: 約 3,000 tokens 想定（A4 1〜2枚相当）
//   - 出力 tok/s: Artificial Analysis 実測（Flash 系 ≈199 / Pro 系 ≈120-150）
//   - 思考時間: 推論モデルは TTFT 実測（3.5 Flash ≈22.8s）から逆算
//   表示時は ModelComparisonTable 内の speedRatingFromSeconds で★に変換。
export interface GeminiModelBenchmark {
    recognitionQuality: 1 | 2 | 3 | 4 | 5;
    analysisQuality: 1 | 2 | 3 | 4 | 5;
    estimatedSeconds: number;
    recommendedFor: string;
}

export interface GeminiModelOption {
    value: string;
    label: string;
    description: string;
    pricing?: GeminiModelPricing;
    benchmark?: GeminiModelBenchmark;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash';

// 配列順 = ドロップダウン・比較表での表示順。新しい世代のモデルを上に並べる。
export const GEMINI_MODEL_OPTIONS: GeminiModelOption[] = [
    {
        value: 'gemini-3.7-flash',
        label: 'Gemini 3.7 Flash',
        description: 'Google推奨の現行フラッグシップFlash（2026-08 GA）。動画・音声・PDF入力対応、1Mコンテキスト。3.5 Flashより高速・低価格',
        // ⚠️ プロモ価格: 2026-12-31まで。2027-01-01から入力$1.50/出力$7.50に倍額（公式料金表に明記）。
        pricing: {
            inputPerMTok: 0.75,
            outputPerMTok: 3.75,
        },
        benchmark: {
            recognitionQuality: 5,
            analysisQuality: 5,
            // 出力 ≈315-340 tok/s（Artificial Analysis実測）・思考は既定OFFのため 3.5 Flash より短い見積もり
            estimatedSeconds: 40,
            recommendedFor: '動画・音声→文書の総合おすすめ。現行の既定モデル',
        },
    },
    {
        value: 'gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        description: '3.1 Proを超えるコーディング・エージェント性能を実現しつつ高速・低コスト化した前世代Flash。1Mコンテキスト対応',
        pricing: {
            inputPerMTok: 1.5,
            outputPerMTok: 9.0,
        },
        benchmark: {
            recognitionQuality: 5,
            analysisQuality: 5,
            estimatedSeconds: 60,
            recommendedFor: '動画・音声→文書の総合おすすめ。品質最高クラス',
        },
    },
    {
        value: 'gemini-3.5-flash-lite',
        label: 'Gemini 3.5 Flash Lite',
        description: '3.5世代の軽量モデル。テキスト・画像・動画・音声とも同一単価で、大量処理を低コストに実行',
        pricing: {
            inputPerMTok: 0.3,
            outputPerMTok: 2.5,
        },
        benchmark: {
            recognitionQuality: 3,
            analysisQuality: 3,
            estimatedSeconds: 30,
            recommendedFor: '大量バッチ処理・コスト重視の運用',
        },
    },
    {
        value: 'gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro (Preview)',
        description: '3 Proから推論力を大幅強化（ARC-AGI-2スコア2.5倍）。Deep Think Mini相当の高思考モード搭載（プレビュー版）',
        pricing: {
            inputPerMTok: 2.0,
            outputPerMTok: 12.0,
            longContext: {
                inputPerMTok: 4.0,
                outputPerMTok: 18.0,
                thresholdTokens: 200_000,
            },
        },
        benchmark: {
            recognitionQuality: 4,
            analysisQuality: 5,
            estimatedSeconds: 95,
            recommendedFor: '最高難度の推論・専門的な解析',
        },
    },
    {
        value: 'gemini-3-pro-preview',
        label: 'Gemini 3 Pro (Preview)',
        description: '強力な推論・エージェント機能を持つGemini 3世代フラッグシップ（プレビュー版）',
        pricing: {
            inputPerMTok: 2.0,
            outputPerMTok: 12.0,
            longContext: {
                inputPerMTok: 4.0,
                outputPerMTok: 18.0,
                thresholdTokens: 200_000,
            },
        },
        benchmark: {
            recognitionQuality: 4,
            analysisQuality: 5,
            estimatedSeconds: 85,
            recommendedFor: '複雑な構造化文書・難しい要約',
        },
    },
    {
        value: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash Lite',
        description: '超低コスト・超高速の軽量モデル。大量処理やドラフト生成に最適',
        pricing: {
            inputPerMTok: 0.1,
            outputPerMTok: 0.4,
        },
        benchmark: {
            recognitionQuality: 2,
            analysisQuality: 2,
            estimatedSeconds: 30,
            recommendedFor: '大量バッチ処理・最安運用',
        },
    },
    {
        value: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        description: '速度・コスト・精度のバランスに優れた標準モデル。ほとんどのタスクに対応',
        pricing: {
            inputPerMTok: 0.3,
            outputPerMTok: 2.5,
        },
        benchmark: {
            recognitionQuality: 3,
            analysisQuality: 3,
            estimatedSeconds: 35,
            recommendedFor: '日常的な変換・標準利用',
        },
    },
    {
        value: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
        description: '複雑な推論・コーディング・マルチモーダルタスク向けフラッグシップ。最高精度だがコスト高',
        pricing: {
            inputPerMTok: 1.25,
            outputPerMTok: 10.0,
            longContext: {
                inputPerMTok: 2.5,
                outputPerMTok: 15.0,
                thresholdTokens: 200_000,
            },
        },
        benchmark: {
            recognitionQuality: 4,
            analysisQuality: 4,
            estimatedSeconds: 55,
            recommendedFor: '安定運用したい高品質な文書生成',
        },
    },
];

const GEMINI_MODEL_MAP = new Map(GEMINI_MODEL_OPTIONS.map(option => [option.value, option]));

export function getGeminiModelLabel(model: string): string {
    return GEMINI_MODEL_MAP.get(model)?.label || model;
}

const PRICE_FORMATTER = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

export function getGeminiPricingLabelShort(model: string): string | undefined {
    const pricing = GEMINI_MODEL_MAP.get(model)?.pricing;
    if (!pricing) return undefined;
    return `入力 ${PRICE_FORMATTER.format(pricing.inputPerMTok)} / 出力 ${PRICE_FORMATTER.format(pricing.outputPerMTok)}`;
}

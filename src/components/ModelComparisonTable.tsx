'use client';

import React from 'react';
import { GEMINI_MODEL_OPTIONS, getGeminiPricingLabelShort } from '@/constants/geminiModels';

interface ModelComparisonTableProps {
    selectedModel?: string;
    onSelect?: (value: string) => void;
}

const RatingBar: React.FC<{ rating: number; max?: number; label: string }> = ({
    rating,
    max = 5,
    label,
}) => (
    <div className="flex items-center justify-center" aria-label={`${label}: ${rating}/${max}`}>
        <span className="text-amber-500 tracking-tight">{'★'.repeat(rating)}</span>
        <span className="text-gray-300 tracking-tight">{'★'.repeat(max - rating)}</span>
    </div>
);

// 体感時間（estimatedSeconds）を★1〜5にマッピング。
// 区間は「2時間音声→A4 1〜2枚」想定での Flash 系 30〜35秒を★5、Pro 系 80秒以上を★2以下に振り分け。
function speedRatingFromSeconds(seconds: number): 1 | 2 | 3 | 4 | 5 {
    if (seconds <= 35) return 5;
    if (seconds <= 55) return 4;
    if (seconds <= 75) return 3;
    if (seconds <= 95) return 2;
    return 1;
}

export const ModelComparisonTable: React.FC<ModelComparisonTableProps> = ({ selectedModel, onSelect }) => {
    // onSelect が渡されていれば行を選択可能にする。
    // selectable と onSelectFn を一緒に確定させることで、後段の非null断言を避ける。
    const onSelectFn = onSelect;
    const selectable = typeof onSelectFn === 'function';
    return (
        <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
            <table className="w-full text-xs" role={selectable ? 'listbox' : undefined} aria-label={selectable ? 'モデルを選択' : undefined}>
                <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                        <th className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap">モデル</th>
                        <th
                            className="px-3 py-2 text-center font-semibold text-gray-700 whitespace-nowrap"
                            title="動画・音声を聞き取り、視覚的内容を理解する力。FLEURS (音声書き起こし) / Video-MME / MMMU-Pro を相対評価。"
                        >
                            動画・音声の認識力
                        </th>
                        <th
                            className="px-3 py-2 text-center font-semibold text-gray-700 whitespace-nowrap"
                            title="プロンプトに従って内容を分析・構造化して文書を生成する力。IFEval (指示追従) / MMMU-Pro / GPQA Diamond を相対評価。"
                        >
                            分析・出力品質
                        </th>
                        <th
                            className="px-3 py-2 text-center font-semibold text-gray-700 whitespace-nowrap"
                            title="2時間の音声入力 → A4 1〜2枚相当の文書出力、を想定した推定処理時間を★1〜5に変換。"
                        >
                            速度
                        </th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap">料金（1Mトークン）</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-700 min-w-[20rem]">おすすめ用途</th>
                    </tr>
                </thead>
                <tbody>
                    {GEMINI_MODEL_OPTIONS.map(option => {
                        const isSelected = option.value === selectedModel;
                        const b = option.benchmark;
                        const priceLabel = getGeminiPricingLabelShort(option.value);
                        return (
                            <tr
                                key={option.value}
                                role={selectable ? 'option' : undefined}
                                aria-selected={selectable ? isSelected : undefined}
                                tabIndex={selectable ? 0 : undefined}
                                onClick={onSelectFn ? () => onSelectFn(option.value) : undefined}
                                onKeyDown={onSelectFn ? (e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        onSelectFn(option.value);
                                    }
                                } : undefined}
                                className={`border-b border-gray-100 last:border-b-0 ${isSelected ? 'bg-blue-50' : 'bg-white hover:bg-gray-50'} ${selectable ? 'cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-400' : ''}`}
                            >
                                <td className="px-3 py-4 font-medium text-gray-900 whitespace-nowrap">
                                    <div className="flex items-center gap-1.5">
                                        {isSelected && (
                                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" aria-label="選択中" />
                                        )}
                                        <span>{option.label}</span>
                                    </div>
                                </td>
                                <td className="px-3 py-4">
                                    {b ? <RatingBar rating={b.recognitionQuality} label="動画・音声の認識力" /> : <span className="text-gray-400">-</span>}
                                </td>
                                <td className="px-3 py-4">
                                    {b ? <RatingBar rating={b.analysisQuality} label="分析・出力品質" /> : <span className="text-gray-400">-</span>}
                                </td>
                                <td className="px-3 py-4 text-center whitespace-nowrap">
                                    {b ? (
                                        <RatingBar rating={speedRatingFromSeconds(b.estimatedSeconds)} label="速度" />
                                    ) : (
                                        <span className="text-gray-400">-</span>
                                    )}
                                </td>
                                <td className="px-3 py-4 text-gray-700 whitespace-nowrap">
                                    {priceLabel || <span className="text-gray-400">-</span>}
                                </td>
                                <td className="px-3 py-4 text-gray-700 min-w-[20rem]">
                                    {b?.recommendedFor || <span className="text-gray-400">-</span>}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <div className="px-3 py-2 text-[10px] text-gray-500 bg-gray-50 border-t border-gray-200 leading-relaxed">
                <div>★は当サービス（音声・動画 → 文書化）での相対評価。料金は標準階層・1Mトークンあたり。</div>
                <div>体感時間は「2時間の音声入力（≒230Kトークン）→ A4 1〜2枚（≒3,000トークン）」を想定した推定値。実測ではネットワークやサーバー状況で変動します。Pro 系は 200K超のロングコンテキスト料金が適用されます。</div>
            </div>
        </div>
    );
};

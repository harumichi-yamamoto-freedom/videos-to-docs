'use client';

import React, { useId } from 'react';
import {
    GEMINI_DEFAULT_MODEL_SENTINEL,
    GEMINI_MODEL_OPTIONS,
    getGeminiModelLabel,
    getGeminiPricingLabelShort,
    hasIntroductoryPricing,
    resolveGeminiModel,
} from '../constants/geminiModels';

interface ModelComparisonTableProps {
    selectedModel?: string;
    onSelect?: (value: string) => void;
}

interface RatingBarProps {
    rating: number;
    max?: number;
    label: string;
}

const RatingBar: React.FC<RatingBarProps> = ({ rating, max = 5, label }) => (
    <div
        role="img"
        className="flex items-center justify-center"
        aria-label={`${label}: ${rating}/${max}`}
    >
        <span aria-hidden="true" className="text-amber-500 tracking-tight">
            {'★'.repeat(rating)}
        </span>
        <span aria-hidden="true" className="text-gray-300 tracking-tight">
            {'★'.repeat(max - rating)}
        </span>
    </div>
);

function speedRatingFromSeconds(seconds: number): 1 | 2 | 3 | 4 | 5 {
    if (seconds <= 35) return 5;
    if (seconds <= 55) return 4;
    if (seconds <= 75) return 3;
    if (seconds <= 95) return 2;
    return 1;
}

export const ModelComparisonTable: React.FC<ModelComparisonTableProps> = ({
    selectedModel,
    onSelect,
}) => {
    const radioGroupId = useId();
    const resolvedDefaultModel = resolveGeminiModel(GEMINI_DEFAULT_MODEL_SENTINEL);
    const defaultOption = {
        value: GEMINI_DEFAULT_MODEL_SENTINEL,
        label: `おまかせ（現在: ${getGeminiModelLabel(resolvedDefaultModel)}）`,
        description: 'アプリの推奨モデルに自動追従します',
    };
    const comparisonOptions = [defaultOption, ...GEMINI_MODEL_OPTIONS];

    const renderPrice = (model: string) => {
        const priceLabel = getGeminiPricingLabelShort(model);
        if (!priceLabel) return <span className="text-gray-400">-</span>;

        return (
            <span>
                {priceLabel}
                {hasIntroductoryPricing(model) && (
                    <span className="mt-1 block text-[10px] font-medium text-amber-700">
                        プロモ価格（期限2026/12/31）
                    </span>
                )}
            </span>
        );
    };

    const renderMobileCards = () => (
        <div className="space-y-3 p-3 md:hidden">
            {comparisonOptions.map((option, optionIndex) => {
                const isSelected = option.value === selectedModel;
                const isDefaultOption = option.value === GEMINI_DEFAULT_MODEL_SENTINEL;
                const metadataModel = resolveGeminiModel(option.value);
                const metadata = GEMINI_MODEL_OPTIONS.find(
                    candidate => candidate.value === metadataModel,
                );
                const benchmark = metadata?.benchmark;
                const mobileRadioId = `${radioGroupId}-mobile-${optionIndex}`;

                return (
                    <article
                        key={option.value}
                        className={`rounded-lg border p-4 ${
                            isSelected
                                ? 'border-blue-400 bg-blue-50'
                                : 'border-gray-200 bg-white'
                        }`}
                    >
                        <div className="flex min-w-0 items-start gap-3">
                            {onSelect ? (
                                <label
                                    htmlFor={mobileRadioId}
                                    className="flex min-h-11 min-w-11 flex-1 cursor-pointer items-start gap-3 py-2"
                                >
                                    <input
                                        id={mobileRadioId}
                                        type="radio"
                                        name={`mobile-${radioGroupId}`}
                                        value={option.value}
                                        checked={isSelected}
                                        onChange={() => onSelect(option.value)}
                                        className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 focus:ring-blue-500"
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-2">
                                            <span className="font-semibold text-gray-900">
                                                {option.label}
                                            </span>
                                            {isDefaultOption && (
                                                <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                                    現在の既定
                                                </span>
                                            )}
                                        </span>
                                        {isDefaultOption && (
                                            <span className="mt-1 block text-xs text-gray-500">
                                                {option.description}
                                            </span>
                                        )}
                                    </span>
                                </label>
                            ) : (
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-semibold text-gray-900">
                                            {option.label}
                                        </span>
                                        {isDefaultOption && (
                                            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                                現在の既定
                                            </span>
                                        )}
                                    </div>
                                    {isDefaultOption && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            {option.description}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>

                        <dl className="mt-4 grid grid-cols-3 gap-2 border-y border-gray-100 py-3 text-center text-xs">
                            <div>
                                <dt className="mb-1 text-gray-500">認識力</dt>
                                <dd>
                                    {benchmark ? (
                                        <RatingBar
                                            rating={benchmark.recognitionQuality}
                                            label="動画・音声の認識力"
                                        />
                                    ) : (
                                        <span className="text-gray-400">-</span>
                                    )}
                                </dd>
                            </div>
                            <div>
                                <dt className="mb-1 text-gray-500">出力品質</dt>
                                <dd>
                                    {benchmark ? (
                                        <RatingBar
                                            rating={benchmark.analysisQuality}
                                            label="分析・出力品質"
                                        />
                                    ) : (
                                        <span className="text-gray-400">-</span>
                                    )}
                                </dd>
                            </div>
                            <div>
                                <dt className="mb-1 text-gray-500">速度</dt>
                                <dd>
                                    {benchmark ? (
                                        <RatingBar
                                            rating={speedRatingFromSeconds(
                                                benchmark.estimatedSeconds,
                                            )}
                                            label="速度"
                                        />
                                    ) : (
                                        <span className="text-gray-400">-</span>
                                    )}
                                </dd>
                            </div>
                        </dl>

                        <dl className="mt-3 space-y-2 text-xs">
                            <div>
                                <dt className="font-medium text-gray-500">
                                    料金（1Mトークン）
                                </dt>
                                <dd className="mt-0.5 text-gray-700">
                                    {renderPrice(metadataModel)}
                                </dd>
                            </div>
                            <div>
                                <dt className="font-medium text-gray-500">おすすめ用途</dt>
                                <dd className="mt-0.5 text-gray-700">
                                    {benchmark?.recommendedFor ?? '-'}
                                </dd>
                            </div>
                        </dl>
                    </article>
                );
            })}
        </div>
    );

    return (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            {onSelect ? (
                <fieldset className="m-0 min-w-0 border-0 p-0 md:hidden">
                    <legend className="sr-only">モデルを選択</legend>
                    {renderMobileCards()}
                </fieldset>
            ) : renderMobileCards()}

            <div
                className="hidden overflow-x-auto md:block"
                role={onSelect ? 'radiogroup' : undefined}
                aria-label={onSelect ? 'モデルを選択' : undefined}
            >
                <table className="w-full min-w-[48rem] text-xs">
                    <caption className="sr-only">Geminiモデル性能比較</caption>
                    <thead className="border-b border-gray-200 bg-gray-50">
                        <tr>
                            {onSelect && (
                                <th scope="col" className="w-12 px-3 py-2">
                                    <span className="sr-only">選択</span>
                                </th>
                            )}
                            <th scope="col" className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap">
                                モデル
                            </th>
                            <th
                                scope="col"
                                className="px-3 py-2 text-center font-semibold text-gray-700 whitespace-nowrap"
                                title="動画・音声を聞き取り、視覚的内容を理解する力。FLEURS (音声書き起こし) / Video-MME / MMMU-Pro を相対評価。"
                            >
                                動画・音声の認識力
                            </th>
                            <th
                                scope="col"
                                className="px-3 py-2 text-center font-semibold text-gray-700 whitespace-nowrap"
                                title="プロンプトに従って内容を分析・構造化して文書を生成する力。IFEval (指示追従) / MMMU-Pro / GPQA Diamond を相対評価。"
                            >
                                分析・出力品質
                            </th>
                            <th
                                scope="col"
                                className="px-3 py-2 text-center font-semibold text-gray-700 whitespace-nowrap"
                                title="2時間の音声入力 → A4 1〜2枚相当の文書出力、を想定した推定処理時間を★1〜5に変換。"
                            >
                                速度
                            </th>
                            <th scope="col" className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap">
                                料金（1Mトークン）
                            </th>
                            <th scope="col" className="min-w-48 px-3 py-2 text-left font-semibold text-gray-700">
                                おすすめ用途
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {comparisonOptions.map((option, optionIndex) => {
                            const isSelected = option.value === selectedModel;
                            const isDefaultOption = option.value
                                === GEMINI_DEFAULT_MODEL_SENTINEL;
                            const metadataModel = resolveGeminiModel(option.value);
                            const metadata = GEMINI_MODEL_OPTIONS.find(
                                candidate => candidate.value === metadataModel,
                            );
                            const benchmark = metadata?.benchmark;
                            const desktopRadioId = `${radioGroupId}-desktop-${optionIndex}`;

                            return (
                                <tr
                                    key={option.value}
                                    className={`border-b border-gray-100 last:border-b-0 ${
                                        isSelected ? 'bg-blue-50' : 'bg-white'
                                    }`}
                                >
                                    {onSelect && (
                                        <td className="px-1 py-1 text-center">
                                            <label
                                                htmlFor={desktopRadioId}
                                                className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center"
                                            >
                                                <input
                                                    id={desktopRadioId}
                                                    type="radio"
                                                    name={`desktop-${radioGroupId}`}
                                                    value={option.value}
                                                    checked={isSelected}
                                                    onChange={() => onSelect(option.value)}
                                                    className="h-5 w-5 text-blue-600 focus:ring-blue-500"
                                                />
                                                <span className="sr-only">
                                                    {option.label}を選択
                                                </span>
                                            </label>
                                        </td>
                                    )}
                                    <th scope="row" className="min-w-44 px-3 py-4 text-left font-medium text-gray-900">
                                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                            <span>{option.label}</span>
                                            {isDefaultOption && (
                                                <span className="shrink-0 whitespace-nowrap rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                                    現在の既定
                                                </span>
                                            )}
                                        </div>
                                        {isDefaultOption && (
                                            <div className="mt-1 text-[11px] font-normal text-gray-500 whitespace-normal">
                                                {option.description}
                                            </div>
                                        )}
                                    </th>
                                    <td className="px-3 py-4">
                                        {benchmark ? (
                                            <RatingBar
                                                rating={benchmark.recognitionQuality}
                                                label="動画・音声の認識力"
                                            />
                                        ) : (
                                            <span className="text-gray-400">-</span>
                                        )}
                                    </td>
                                    <td className="px-3 py-4">
                                        {benchmark ? (
                                            <RatingBar
                                                rating={benchmark.analysisQuality}
                                                label="分析・出力品質"
                                            />
                                        ) : (
                                            <span className="text-gray-400">-</span>
                                        )}
                                    </td>
                                    <td className="px-3 py-4 text-center whitespace-nowrap">
                                        {benchmark ? (
                                            <RatingBar
                                                rating={speedRatingFromSeconds(
                                                    benchmark.estimatedSeconds,
                                                )}
                                                label="速度"
                                            />
                                        ) : (
                                            <span className="text-gray-400">-</span>
                                        )}
                                    </td>
                                    <td className="px-3 py-4 text-gray-700">
                                        {renderPrice(metadataModel)}
                                    </td>
                                    <td className="min-w-48 px-3 py-4 text-gray-700">
                                        {benchmark?.recommendedFor ?? '-'}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className="border-t border-gray-200 bg-gray-50 px-3 py-2 text-[10px] leading-relaxed text-gray-500">
                <div>
                    ★は当サービス（音声・動画 → 文書化）での相対評価です。料金は標準階層・1Mトークンあたりです。
                </div>
                <div>
                    体感時間は「2時間の音声入力（≒230Kトークン）→ A4 1〜2枚（≒3,000トークン）」を想定した推定値です。実測ではネットワークやサーバー状況で変動します。Pro 系は 200K超のロングコンテキスト料金が適用されます。
                </div>
            </div>
        </div>
    );
};

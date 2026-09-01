'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
    canonicalizeGeminiModel,
    getGeminiModelLabel,
} from '@/constants/geminiModels';
import { ModelComparisonTable } from './ModelComparisonTable';

interface ModelComboboxSelectProps {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    className?: string;
}

export interface ModelComboboxKeyTransition {
    isOpen: boolean;
    shouldConsume: boolean;
}

export function getModelComboboxKeyTransition(
    isOpen: boolean,
    key: string,
): ModelComboboxKeyTransition {
    if (isOpen && key === 'Escape') {
        return { isOpen: false, shouldConsume: true };
    }
    return { isOpen, shouldConsume: false };
}

// 比較表で直接モデルを選べるコンボボックス。
// 折りたたみ時: 現在選択中のモデル名のみ表示。
// 展開時: 比較表が表示され、行クリックで選択 → 自動で閉じる。
export const ModelComboboxSelect: React.FC<ModelComboboxSelectProps> = ({
    value,
    onChange,
    disabled,
    className,
}) => {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;

        const handlePointerDown = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };

        document.addEventListener('mousedown', handlePointerDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
        };
    }, [open]);

    const handleSelect = (model: string) => {
        onChange(model);
        setOpen(false);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const transition = getModelComboboxKeyTransition(open, event.key);
        if (!transition.shouldConsume) return;

        event.preventDefault();
        event.stopPropagation();
        setOpen(transition.isOpen);
    };

    const canonicalValue = canonicalizeGeminiModel(value);
    const selectedModelLabel = getGeminiModelLabel(canonicalValue);

    return (
        <div ref={containerRef} className={className} onKeyDown={handleKeyDown}>
            {disabled ? (
                <div>
                    <p className="text-sm text-gray-800">{selectedModelLabel}</p>
                    <button
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        aria-expanded={open}
                        className="inline-flex items-center gap-1 mt-1 text-xs text-blue-600 hover:text-blue-700 hover:underline focus:outline-none focus:underline"
                    >
                        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : '-rotate-90'}`} />
                        <span>{open ? '比較表を閉じる' : '性能を比較'}</span>
                    </button>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    className="w-full inline-flex items-center justify-between gap-2 px-4 py-2 rounded-lg text-sm font-medium text-gray-800 bg-white border border-gray-300 hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                    <span className="text-left truncate">{selectedModelLabel}</span>
                    <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
                </button>
            )}
            {open && (
                <div className="mt-2">
                    <ModelComparisonTable
                        selectedModel={canonicalValue}
                        onSelect={disabled ? undefined : handleSelect}
                    />
                </div>
            )}
        </div>
    );
};

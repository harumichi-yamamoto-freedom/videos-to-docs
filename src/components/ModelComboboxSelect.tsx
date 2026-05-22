'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { getGeminiModelLabel } from '@/constants/geminiModels';
import { ModelComparisonTable } from './ModelComparisonTable';

interface ModelComboboxSelectProps {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    className?: string;
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
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [open]);

    const handleSelect = (model: string) => {
        onChange(model);
        setOpen(false);
    };

    return (
        <div ref={containerRef} className={className}>
            {disabled ? (
                <div>
                    <p className="text-sm text-gray-800">{getGeminiModelLabel(value)}</p>
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
                    <span className="text-left truncate">{getGeminiModelLabel(value)}</span>
                    <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
                </button>
            )}
            {open && (
                <div className="mt-2">
                    <ModelComparisonTable
                        selectedModel={value}
                        onSelect={disabled ? undefined : handleSelect}
                    />
                </div>
            )}
        </div>
    );
};

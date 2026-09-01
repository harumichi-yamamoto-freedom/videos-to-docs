'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
    canonicalizeGeminiModel,
    getGeminiModelLabel,
    resolveGeminiModel,
} from '../constants/geminiModels';
import {
    resolveThinkingLevelForModel,
    type GeminiThinkingLevel,
    type GeminiThinkingLevelOption,
} from '../constants/geminiThinking';
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

export function supportsThinkingLevel(model: string): boolean {
    return resolveThinkingLevelForModel('default', resolveGeminiModel(model)) !== undefined;
}

/**
 * The level a model actually runs with. Drafts keep the level the user picked
 * even while an unsupported model is selected, so switching models back and
 * forth restores it instead of silently downgrading to 'default'.
 */
export function effectiveThinkingLevel(
    model: string,
    thinkingLevel: GeminiThinkingLevel,
): GeminiThinkingLevel {
    return supportsThinkingLevel(model) ? thinkingLevel : 'default';
}

export function getThinkingLevelOptionLabel(
    level: GeminiThinkingLevelOption,
): string {
    if (level.id === 'default') return '標準（推奨）';
    return level.description
        ? `${level.label}（${level.description}）`
        : level.label;
}

export const ModelComboboxSelect: React.FC<ModelComboboxSelectProps> = ({
    value,
    onChange,
    disabled,
    className,
}) => {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const comparisonPanelId = useId();

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
        triggerRef.current?.focus({ preventScroll: true });
    };

    const handleToggle = () => {
        setOpen(currentOpen => !currentOpen);
        triggerRef.current?.focus({ preventScroll: true });
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const transition = getModelComboboxKeyTransition(open, event.key);
        if (!transition.shouldConsume) return;

        event.preventDefault();
        event.stopPropagation();
        setOpen(transition.isOpen);
        triggerRef.current?.focus({ preventScroll: true });
    };

    const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setOpen(false);
    };

    const canonicalValue = canonicalizeGeminiModel(value);
    const selectedModelLabel = getGeminiModelLabel(canonicalValue);

    return (
        <div
            ref={containerRef}
            className={className}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
        >
            {disabled ? (
                <div>
                    <p className="text-sm text-gray-800">{selectedModelLabel}</p>
                    <button
                        ref={triggerRef}
                        type="button"
                        onClick={handleToggle}
                        aria-expanded={open}
                        aria-controls={comparisonPanelId}
                        className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs text-blue-600 hover:text-blue-700 hover:underline focus:outline-none focus:underline"
                    >
                        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : '-rotate-90'}`} />
                        <span>{open ? '比較表を閉じる' : '性能を比較'}</span>
                    </button>
                </div>
            ) : (
                <button
                    ref={triggerRef}
                    type="button"
                    onClick={handleToggle}
                    aria-expanded={open}
                    aria-controls={comparisonPanelId}
                    className="inline-flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                    <span className="text-left truncate">{selectedModelLabel}</span>
                    <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
                </button>
            )}
            {open && (
                <div id={comparisonPanelId} className="mt-2">
                    <ModelComparisonTable
                        selectedModel={canonicalValue}
                        onSelect={disabled ? undefined : handleSelect}
                    />
                </div>
            )}
        </div>
    );
};

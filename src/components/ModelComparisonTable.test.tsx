import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GEMINI_MODEL_OPTIONS } from '../constants/geminiModels';
import { ModelComboboxSelect } from './ModelComboboxSelect';
import { ModelComparisonTable } from './ModelComparisonTable';

describe('ModelComparisonTable', () => {
    it('table semanticsを保ったままradioで選択できる', () => {
        const markup = renderToStaticMarkup(
            <ModelComparisonTable selectedModel="default" onSelect={vi.fn()} />,
        );

        expect(markup).toContain('<table');
        expect(markup).toContain('type="radio"');
        expect(markup).toContain('role="radiogroup"');
        expect(markup).toContain('<legend class="sr-only">モデルを選択</legend>');
        expect(markup).toContain('role="img"');
        expect(markup).not.toContain('role="listbox"');
        expect(markup).not.toContain('role="option"');
        expect(markup).not.toMatch(/<tr[^>]*tabindex=/);
    });

    it('20pxのradioを維持しつつlabelのヒット領域を44px以上にする', () => {
        const markup = renderToStaticMarkup(
            <ModelComparisonTable selectedModel="default" onSelect={vi.fn()} />,
        );
        const expectedRadioCount = (GEMINI_MODEL_OPTIONS.length + 1) * 2;
        const radioTags = markup.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
        const targetLabels = markup.match(/<label[^>]*class="[^"]*min-h-11[^"]*"[^>]*>/g) ?? [];

        expect(radioTags).toHaveLength(expectedRadioCount);
        radioTags.forEach(tag => {
            expect(tag).toMatch(/class="[^"]*h-5 w-5[^"]*"/);
        });
        expect(targetLabels).toHaveLength(expectedRadioCount);
    });

    it('mobile card表示と3.7 Flashのプロモ期限を示す', () => {
        const markup = renderToStaticMarkup(
            <ModelComparisonTable selectedModel="gemini-3.7-flash" />,
        );

        expect(markup).toContain('md:hidden');
        expect(markup).toContain('hidden overflow-x-auto md:block');
        expect(markup).toContain('期限2026/12/31');
        expect(markup.match(/<article/g)).toHaveLength(
            GEMINI_MODEL_OPTIONS.length + 1,
        );
    });
});

describe('ModelComboboxSelect', () => {
    it.each([
        { disabled: false, label: '選択可能' },
        { disabled: true, label: '閲覧専用' },
    ])('$labelの開閉トリガーに44px以上の高さを確保する', ({ disabled }) => {
        const markup = renderToStaticMarkup(
            <ModelComboboxSelect
                value="default"
                onChange={vi.fn()}
                disabled={disabled}
            />,
        );

        expect(markup).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"/);
    });
});

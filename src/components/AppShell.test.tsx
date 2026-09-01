import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/components/AppHeader', () => ({ AppHeader: () => null }));

const { AppShell } = await import('./AppShell');

const html = renderToStaticMarkup(
    <AppShell>
        <p>本文</p>
    </AppShell>,
);

describe('AppShell (E5)', () => {
    it('スキップリンクが main を指す', () => {
        expect(html).toContain('href="#main-content"');
        expect(html).toContain('メインコンテンツへ移動');
    });

    it('スキップリンクは既定で隠れ、フォーカス時だけ現れる', () => {
        const skipTag = /<a\b[^>]*href="#main-content"[^>]*>/.exec(html)?.[0] ?? '';
        expect(skipTag).toContain('sr-only');
        expect(skipTag).toContain('focus-visible:not-sr-only');
    });

    it('main ランドマークが id と受け皿のフォーカス先を持つ', () => {
        const mainTag = /<main\b[^>]*>/.exec(html)?.[0] ?? '';
        expect(mainTag).toContain('id="main-content"');
        expect(mainTag).toContain('tabindex="-1"');
    });

    it('ページ側が固定高を持たなくてよいよう、シェルが縦フレックスで高さを持つ', () => {
        expect(html).toContain('min-h-dvh');
        expect(/<main\b[^>]*class="[^"]*flex-1/.test(html)).toBe(true);
    });

    it('子要素を main の中へ入れる', () => {
        const mainStart = html.indexOf('<main');
        expect(html.indexOf('<p>本文</p>')).toBeGreaterThan(mainStart);
    });
});

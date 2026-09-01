import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PDF_FONT_ID,
    normalizePdfFontId,
    PDF_FONTS,
    PDF_THEME_RECOMMENDED_FONT,
    resolvePdfFontId,
} from './pdfFonts';
import { PDF_THEMES } from './pdfThemes';

describe('pdfFonts', () => {
    it('全テーマに推奨フォントが定義され、いずれも具象フォント ID を指す', () => {
        const concreteIds = PDF_FONTS.map(font => font.id).filter(
            id => id !== 'auto',
        );

        for (const theme of PDF_THEMES) {
            const recommended = PDF_THEME_RECOMMENDED_FONT[theme.id];
            expect(concreteIds).toContain(recommended);
        }
    });

    it('不正値・null は auto へ正規化する', () => {
        expect(normalizePdfFontId('unknown-font')).toBe(DEFAULT_PDF_FONT_ID);
        expect(normalizePdfFontId(null)).toBe(DEFAULT_PDF_FONT_ID);
        expect(normalizePdfFontId(undefined)).toBe(DEFAULT_PDF_FONT_ID);
        expect(normalizePdfFontId('mincho')).toBe('mincho');
    });

    it('auto はテーマ推奨へ解決し、明示指定はテーマに関わらず維持する', () => {
        expect(resolvePdfFontId('auto', 'sumi')).toBe(
            PDF_THEME_RECOMMENDED_FONT.sumi,
        );
        expect(resolvePdfFontId('auto', 'editorial')).toBe('gothic');
        expect(resolvePdfFontId('biz', 'sumi')).toBe('biz');
    });
});

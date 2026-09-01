import type { PdfThemeId } from './pdfThemes';

export const PDF_FONTS = [
    {
        id: 'auto',
        label: 'テーマおまかせ',
        description: '選択中のデザインに合うフォントを自動で使います',
    },
    {
        id: 'gothic',
        label: 'ゴシック（標準）',
        description: '線の均質な標準ゴシック体。画面と同じ現代的な読み味',
    },
    {
        id: 'mincho',
        label: '明朝',
        description: '格調ある明朝体。報告書・提案書に落ち着きと品位',
    },
    {
        id: 'zen',
        label: '幾何モダン',
        description: '幾何学的な骨格のゴシック体。ミニマル・建築系の紙面に',
    },
    {
        id: 'shippori',
        label: '和明朝',
        description: '伝統的な風合いの明朝体。和の様式の文書に',
    },
    {
        id: 'biz',
        label: 'UDゴシック',
        description: 'ユニバーサルデザインの実務書体。読み間違いにくさ重視',
    },
    {
        id: 'maru',
        label: '丸ゴシック',
        description: '角の丸いゴシック体。柔らかく親しみのある印象',
    },
] as const;

export type PdfFontId = (typeof PDF_FONTS)[number]['id'];

/** 'auto' を除いた、CSS クラスへ直接対応する具象フォント ID。 */
export type ConcretePdfFontId = Exclude<PdfFontId, 'auto'>;

export const DEFAULT_PDF_FONT_ID: PdfFontId = 'auto';

/** 'auto' 選択時に各テーマへ充てる推奨フォント。
 * 2026-09-01 3審実測: 非ゴシック既定は5テーマで中央値が退行(明朝系は小級数で
 * 線が細く読み負け・改ページ位置も移動)したため、architect(zen・+4)以外は
 * gothic 既定。他書体はプルダウンからの明示選択で利用可能。 */
export const PDF_THEME_RECOMMENDED_FONT: Record<PdfThemeId, ConcretePdfFontId> =
    {
        editorial: 'gothic',
        minimal: 'gothic',
        classic: 'gothic',
        rich: 'gothic',
        sumi: 'gothic',
        navy: 'gothic',
        amber: 'gothic',
        sakura: 'gothic',
        consulting: 'gothic',
        architect: 'zen',
        estate: 'gothic',
        genba: 'gothic',
        brand: 'gothic',
    };

export function isPdfFontId(value: unknown): value is PdfFontId {
    return PDF_FONTS.some(font => font.id === value);
}

/** 永続化データなど信頼できない値を、利用可能なフォント ID に揃える。 */
export function normalizePdfFontId(value: unknown): PdfFontId {
    return isPdfFontId(value) ? value : DEFAULT_PDF_FONT_ID;
}

/** 'auto' をテーマ推奨へ解決し、常に具象フォント ID を返す。 */
export function resolvePdfFontId(
    font: PdfFontId,
    theme: PdfThemeId,
): ConcretePdfFontId {
    return font === 'auto' ? PDF_THEME_RECOMMENDED_FONT[theme] : font;
}

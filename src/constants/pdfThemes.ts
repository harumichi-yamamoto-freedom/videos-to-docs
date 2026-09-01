export const PDF_THEMES = [
    {
        id: 'editorial',
        label: 'エディトリアル（標準）',
        description: '紫のアクセントと明確な見出し階層で、読みやすく整えます',
    },
    {
        id: 'minimal',
        label: 'ミニマル',
        description: '装飾を抑え、余白を生かした軽やかな紙面に整えます',
    },
    {
        id: 'classic',
        label: 'シンプル',
        description: '落ち着いた罫線と端正な組版で、簡潔な文書に整えます',
    },
    {
        id: 'rich',
        label: 'リッチ',
        description: '色と装飾を生かし、視覚的なメリハリのある紙面に整えます',
    },
] as const;

export type PdfThemeId = (typeof PDF_THEMES)[number]['id'];

export const DEFAULT_PDF_THEME_ID: PdfThemeId = 'editorial';

export function isPdfThemeId(value: unknown): value is PdfThemeId {
    return PDF_THEMES.some(theme => theme.id === value);
}

/** 永続化データなど信頼できない値を、利用可能な PDF テーマ ID に揃える。 */
export function normalizePdfThemeId(value: unknown): PdfThemeId {
    return isPdfThemeId(value) ? value : DEFAULT_PDF_THEME_ID;
}

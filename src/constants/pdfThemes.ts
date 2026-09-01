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
    {
        id: 'sumi',
        label: '墨朱',
        description: '墨の階調に朱の差し色。和文書の様式美を現代的に整えます',
    },
    {
        id: 'navy',
        label: '紺碧',
        description: '深紺基調のコーポレート調。報告書らしい堅実さと信頼感',
    },
    {
        id: 'amber',
        label: '琥珀',
        description: 'テラコッタとアンバーの暖色系。温かみと親しみのある紙面',
    },
    {
        id: 'sakura',
        label: 'さくら',
        description: '桜色の優しい配色。お客様への提案に合う柔らかな印象',
    },
    {
        id: 'consulting',
        label: 'コンサルタント',
        description: '濃紺と余白の規律。戦略資料にふさわしい明晰さと権威',
    },
    {
        id: 'architect',
        label: '設計士',
        description: '図面のような精密な罫と墨の階調。製図ブルーの基準線',
    },
    {
        id: 'estate',
        label: '邸宅',
        description: '生成りと真鍮の上質な余白。施主への提案にふさわしい格',
    },
    {
        id: 'genba',
        label: '現場',
        description: '決定・宿題・期限が最速で拾える定例議事録の実務仕様',
    },
    {
        id: 'brand',
        label: 'フリーダム',
        description: '深青緑のコーポレート公式。どの文書にも合う信頼の既定',
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

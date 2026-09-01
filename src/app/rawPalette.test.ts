import { describe, expect, it } from 'vitest';
import { missingOwnedFiles, ownedSourceFiles, readOwnedFile } from '@/testUtils/ownedFiles';

/**
 * 意味トークンで配色する規律を、所有ファイル全体で守らせる。
 * 色そのものを書いてしまうと、コントラストの裁定も再テーマも効かなくなる。
 * 対象ファイルは走査で決める(手書き名簿だと新規部品が検査の外に落ちる)。
 */

const PALETTES = [
    'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
    'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
    'purple', 'fuchsia', 'pink', 'rose',
].join('|');

const COLOR_PREFIXES =
    'bg|text|border|ring|from|to|via|divide|outline|shadow|accent|fill|stroke|placeholder|caret|decoration';

/** 番号付きパレット / 無彩色 / 色を含む任意値。text-[10px] のような寸法の任意値は対象外。 */
const RAW_COLOR = new RegExp(
    [
        String.raw`\b(?:${COLOR_PREFIXES})-(?:${PALETTES})-\d{2,3}\b`,
        String.raw`\b(?:${COLOR_PREFIXES})-(?:white|black)\b`,
        String.raw`\b(?:${COLOR_PREFIXES})-\[[^\]]*(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|color-mix\()[^\]]*\]`,
    ].join('|'),
    'g',
);

/**
 * 裁定(Y17/P1): ブランド装飾だけは生の色指定を残す。
 * 役割色ではなく銘柄そのもので、意味トークンにすると 1 箇所でしか使われない
 * トークンが増え、「未参照トークンを残さない」錠(fontWiring.test.ts)と常に衝突する。
 * 追加は理由つきでのみ許す。
 */
const ALLOWED: { file: string; utility: string; reason: string }[] = [
    { file: 'components/AppShell.tsx', utility: 'from-blue-50', reason: 'アプリ地のブランド装飾グラデーション' },
    { file: 'components/AppShell.tsx', utility: 'to-indigo-100', reason: 'アプリ地のブランド装飾グラデーション' },
    { file: 'components/AppHeader.tsx', utility: 'from-blue-600', reason: 'ロゴタイルのブランド装飾グラデーション' },
    { file: 'components/AppHeader.tsx', utility: 'to-indigo-600', reason: 'ロゴタイルのブランド装飾グラデーション' },
    { file: 'components/AppHeader.tsx', utility: 'text-white', reason: 'ロゴタイルのグラデーション上に載るアイコン。地が装飾色なので役割トークンを持たない' },
    // X4 が統合で追加した共有ダイアログ。走査対象が components/ui 全体なので自動で拾われる。
    { file: 'components/ui/Dialog.tsx', utility: 'bg-black', reason: 'モーダルの ::backdrop スクリム(bg-black/50)。背後を覆う遮蔽であって役割色ではない' },
];

function unallowedRawColor(file: string): string[] {
    const allowed = new Set(ALLOWED.filter(entry => entry.file === file).map(entry => entry.utility));
    return [...new Set(readOwnedFile(file).match(RAW_COLOR) ?? [])].filter(utility => !allowed.has(utility));
}

describe('生の色指定の禁止 (Y6 / Y17 / P1)', () => {
    it('所有ファイルの名簿が実在するファイルだけを指している', () => {
        expect(missingOwnedFiles()).toEqual([]);
        expect(ownedSourceFiles().length).toBeGreaterThanOrEqual(9);
    });

    it('ui ディレクトリを走査対象にしている（新規部品が検査から漏れない）', () => {
        const owned = ownedSourceFiles();
        for (const part of ['components/ui/Button.tsx', 'components/ui/IconButton.tsx', 'components/ui/labels.ts']) {
            expect(owned, part).toContain(part);
        }
    });

    it.each(ownedSourceFiles())('%s は意味トークンだけで配色する', file => {
        const found = unallowedRawColor(file);
        expect(found, `許可外の生の色指定: ${found.join(', ')}`).toEqual([]);
    });

    it('許可リストの項目には理由が付いていて、対象がまだ存在する', () => {
        for (const entry of ALLOWED) {
            expect(entry.reason.length, `${entry.file} ${entry.utility}`).toBeGreaterThan(0);
            expect(readOwnedFile(entry.file), `${entry.file} に ${entry.utility} が無い`).toContain(entry.utility);
        }
    });

    it('許可はブランド装飾とスクリムに限る（役割を持つ地色や境界色を紛れ込ませない）', () => {
        // 装飾グラデーション / 装飾上の前景 / 遮蔽スクリム の 3 種だけを許す。
        const ALLOWED_SHAPES = /^(?:from|to|via)-|^text-white$|^bg-black$/;
        for (const entry of ALLOWED) {
            expect(entry.utility, entry.utility).toMatch(ALLOWED_SHAPES);
        }
    });

    it('陰性統制: 番号付き・無彩色・色の任意値をすべて捕まえ、寸法とトークンには反応しない', () => {
        expect('hover:bg-red-100'.match(RAW_COLOR)).toEqual(['bg-red-100']);
        expect('text-white'.match(RAW_COLOR)).toEqual(['text-white']);
        expect('bg-black'.match(RAW_COLOR)).toEqual(['bg-black']);
        expect('bg-[#ff0000]'.match(RAW_COLOR)).toEqual(['bg-[#ff0000]']);
        expect('text-[rgb(1,2,3)]'.match(RAW_COLOR)).toEqual(['text-[rgb(1,2,3)]']);
        expect('bg-[oklch(0.5_0.1_20)]'.match(RAW_COLOR)).toEqual(['bg-[oklch(0.5_0.1_20)]']);
        // 寸法の任意値と意味トークンは通す
        expect('text-[10px]'.match(RAW_COLOR)).toBeNull();
        expect('h-[18px] min-w-[18px]'.match(RAW_COLOR)).toBeNull();
        expect('bg-status-danger-bg text-badge-foreground'.match(RAW_COLOR)).toBeNull();
    });
});

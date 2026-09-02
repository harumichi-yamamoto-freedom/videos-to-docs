import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * モデル選択の「性能を比較」表は 6 列あり、2 列グリッドの左列（約 400px）に置くと
 * 2 列しか見えない。比較表が開いている間（トリガーの aria-expanded="true"）だけ
 * モデル欄を 2 列ぶち抜きにする。状態を持たず :has() で判定するので、
 * 3 つのモーダルすべてで同じクラスが必要。
 */
const SPAN_CLASS = 'md:has-[[aria-expanded=true]]:col-span-2';
const MODAL_FILES = [
    'src/components/PromptEditModal.tsx',
    'src/components/PromptCreateModal.tsx',
    'src/components/admin/DefaultPromptEditModal.tsx',
];

function stripComments(source: string): string {
    return source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/[^\n]*/g, '');
}

describe('モデル選択欄のレイアウト錠', () => {
    it.each(MODAL_FILES)('%s: ModelComboboxSelect を包む欄が比較表を開くと 2 列ぶち抜きになる', file => {
        const source = stripComments(readFileSync(resolve(process.cwd(), file), 'utf8'));
        const mount = source.indexOf('<ModelComboboxSelect');
        expect(mount).toBeGreaterThan(0);
        const before = source.slice(Math.max(0, mount - 700), mount);
        expect(before).toContain('md:grid-cols-2');
        const wrapperOpen = before.lastIndexOf('<div');
        const wrapperTag = before.slice(wrapperOpen);
        expect(wrapperTag).toContain(SPAN_CLASS);
    });

    it('錠の自己検査: クラスを外した断片では落ちる', () => {
        const fragment = '<div className="grid md:grid-cols-2"><div className="space-y-2"><ModelComboboxSelect />';
        const mount = fragment.indexOf('<ModelComboboxSelect');
        const before = fragment.slice(0, mount);
        const wrapperTag = before.slice(before.lastIndexOf('<div'));
        expect(wrapperTag).not.toContain(SPAN_CLASS);
    });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type Rule } from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { beforeAll, describe, expect, it } from 'vitest';
import { iconButtonClassName } from '@/components/ui/IconButton';

/**
 * クラス名の有無ではなく、Tailwind が実際に吐いた CSS を組み立て直して
 * 「効いている値」を見る。ユーティリティ同士の詳細度負けは、クラスが
 * 付いているかどうかを見る錠では原理的に捕まらない。
 */

const GLOBALS = fileURLToPath(new URL('./globals.css', import.meta.url));

type State = 'base' | 'focus-visible';

interface Entry {
    className: string;
    state: State;
    prop: string;
    value: string;
    order: number;
}

const entries: Entry[] = [];

/** `.focus-visible\:px-4` のような単一クラスセレクタだけを拾う（複合セレクタは対象外）。 */
function singleClassName(selector: string): string | null {
    if (!/^\.(?:\\[^]|[A-Za-z0-9_-])+$/.test(selector)) return null;
    return selector.slice(1).replace(/\\([^])/g, '$1');
}

beforeAll(async () => {
    const source = readFileSync(GLOBALS, 'utf8');
    const result = await postcss([tailwind()]).process(source, { from: GLOBALS });

    let order = 0;
    result.root.walkRules(rule => {
        // ネストされた &:focus-visible は親側の走査で扱うため、ここでは飛ばす
        if (rule.parent?.type === 'rule') return;
        const className = singleClassName(rule.selector);
        if (className === null) return;

        rule.each(node => {
            if (node.type === 'decl') {
                entries.push({ className, state: 'base', prop: node.prop, value: node.value, order: order++ });
            } else if (node.type === 'rule' && (node as Rule).selector.includes(':focus-visible')) {
                (node as Rule).walkDecls(decl => {
                    entries.push({ className, state: 'focus-visible', prop: decl.prop, value: decl.value, order: order++ });
                });
            }
        });
    });

    expect(entries.length, 'Tailwind のコンパイル結果を読めていない').toBeGreaterThan(100);
});

const PADDING_SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** padding の一括指定を長形式へ割り開く（padding:0 が px-4 を潰す関係を再現するため）。 */
function expand(prop: string, value: string): [string, string][] {
    if (prop === 'padding') return PADDING_SIDES.map(side => [`padding-${side}`, value]);
    if (prop === 'padding-inline') return [['padding-left', value], ['padding-right', value]];
    if (prop === 'padding-block') return [['padding-top', value], ['padding-bottom', value]];
    return [[prop, value]];
}

/**
 * 素のユーティリティ(0,1,0)より focus-visible 修飾(0,2,0)が強い。
 * 同詳細度どうしはソース順で後勝ち、という CSS の規則をそのまま適用する。
 */
function effectiveStyle(classList: string[], focused: boolean): Map<string, string> {
    const owned = new Set(classList);
    const style = new Map<string, string>();

    const apply = (state: State) => {
        entries
            .filter(entry => entry.state === state && owned.has(entry.className))
            .sort((a, b) => a.order - b.order)
            .forEach(entry => {
                for (const [prop, value] of expand(entry.prop, entry.value)) style.set(prop, value);
            });
    };

    apply('base');
    if (focused) apply('focus-visible');
    return style;
}

const APP_SHELL_SOURCE = readFileSync(
    fileURLToPath(new URL('../components/AppShell.tsx', import.meta.url)),
    'utf8',
);

/** AppShell のスキップリンクが実際に付けているクラスを、実装から読み取る。 */
function skipLinkClassList(): string[] {
    const anchor = /href="#main-content"[\s\S]*?className="([^"]+)"/.exec(APP_SHELL_SOURCE);
    expect(anchor, 'スキップリンクの className を実装から取得できない').not.toBeNull();
    return anchor![1].split(/\s+/).filter(Boolean);
}

const isBlank = (value: string | undefined) => value === undefined || value === '0' || value === '0px';

describe('スキップリンクの実効スタイル (Y3)', () => {
    it('フォーカス時に四辺の余白が残る（not-sr-only の padding:0 に負けない）', () => {
        const style = effectiveStyle(skipLinkClassList(), true);
        for (const side of PADDING_SIDES) {
            expect(isBlank(style.get(`padding-${side}`)), `padding-${side} が潰れている`).toBe(false);
        }
    });

    it('陰性統制: focus-visible の余白指定を外すと潰れを検出できる', () => {
        // Y3 の欠陥そのもの。錠がこれを赤にできなければ、錠は何も守っていない。
        const broken = skipLinkClassList().filter(
            cls => cls !== 'focus-visible:px-4' && cls !== 'focus-visible:py-3',
        );
        const style = effectiveStyle(broken, true);
        expect(isBlank(style.get('padding-left'))).toBe(true);
        expect(isBlank(style.get('padding-top'))).toBe(true);
    });

    it('フォーカス時は隠れ状態が解除され、実際に画面へ出る', () => {
        const style = effectiveStyle(skipLinkClassList(), true);
        expect(style.get('clip-path')).toBe('none');
        expect(style.get('width')).toBe('auto');
        expect(style.get('height')).toBe('auto');
        expect(style.get('position')).toBe('fixed');
    });

    it('非フォーカス時は視覚的に隠れている（読み上げからは消さない）', () => {
        const style = effectiveStyle(skipLinkClassList(), false);
        expect(style.get('clip-path')).toBe('inset(50%)');
        expect(style.get('width')).toBe('1px');
        expect(style.get('height')).toBe('1px');
    });
});

describe('モバイルメニューボタンの開状態 (Y12)', () => {
    const closed = () => effectiveStyle(iconButtonClassName('secondary', '', false).split(' '), false);
    const open = () => effectiveStyle(iconButtonClassName('secondary', '', true).split(' '), false);

    it('開状態で地色と文字色が実際に変わる', () => {
        expect(open().get('background-color')).not.toBe(closed().get('background-color'));
        expect(open().get('color')).not.toBe(closed().get('color'));
    });

    it('開状態は選択トークンの値になっている', () => {
        expect(open().get('background-color')).toBe('#eff6ff');
        expect(closed().get('background-color')).toBe('#ffffff');
    });

    it('陰性統制: className を後ろに足す旧方式は順序負けして地色が変わらない', () => {
        // Y12 の欠陥そのもの。class 属性の順序は勝敗を決めないという実測を固定する。
        // ここが赤くなったら Tailwind の出力順が変わったということなので、変更理由を見直すこと。
        const overridden = effectiveStyle(
            iconButtonClassName('secondary', 'border-brand-border bg-selection text-selection-foreground').split(' '),
            false,
        );
        expect(overridden.get('background-color')).toBe(closed().get('background-color'));
    });
});

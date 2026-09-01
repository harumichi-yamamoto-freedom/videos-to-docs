import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, buttonClassName } from './Button';
import { IconButton, iconButtonClassName } from './IconButton';
import { NavItem, NavItemButton, navItemClassName } from './NavItem';
import { PageHeader } from './PageHeader';

const VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;

describe('Button / IconButton', () => {
    it('全 variant が 44px 下限とフォーカスリングと無効表現を持つ', () => {
        for (const variant of VARIANTS) {
            const cls = buttonClassName(variant);
            expect(cls, variant).toContain('min-h-11');
            expect(cls, variant).toContain('focus-visible:ring-2');
            expect(cls, variant).toContain('disabled:cursor-not-allowed');
            expect(cls, variant).toContain('disabled:opacity-60');
        }
    });

    it('IconButton は縦横とも 44px 下限', () => {
        for (const variant of VARIANTS) {
            const cls = iconButtonClassName(variant);
            expect(cls, variant).toContain('min-h-11');
            expect(cls, variant).toContain('min-w-11');
        }
    });

    it('hover は not-disabled で括られ、無効時に色が動かない', () => {
        for (const variant of VARIANTS) {
            const cls = buttonClassName(variant);
            const bareHover = cls
                .split(' ')
                .filter(token => token.startsWith('hover:'));
            expect(bareHover, variant).toEqual([]);
        }
    });

    it('variant ごとに配色が異なる', () => {
        const seen = new Set(VARIANTS.map(variant => buttonClassName(variant)));
        expect(seen.size).toBe(VARIANTS.length);
    });

    it('button 要素は既定で type=button（フォーム内での暗黙 submit を防ぐ）', () => {
        expect(renderToStaticMarkup(<Button>保存</Button>)).toContain('type="button"');
        expect(
            renderToStaticMarkup(
                <IconButton aria-label="閉じる">
                    <span />
                </IconButton>,
            ),
        ).toContain('type="button"');
    });

    it('IconButton は aria-label をそのまま出す', () => {
        const html = renderToStaticMarkup(
            <IconButton aria-label="お知らせを閉じる（今後表示しません）">
                <span />
            </IconButton>,
        );
        expect(html).toContain('aria-label="お知らせを閉じる（今後表示しません）"');
    });

    it('disabled を渡すと DOM 属性として出る（class 側の disabled: 修飾と取り違えない）', () => {
        expect(renderToStaticMarkup(<Button disabled>保存</Button>)).toContain('disabled=""');
        expect(renderToStaticMarkup(<Button>保存</Button>)).not.toContain('disabled=""');
    });
});

describe('NavItem', () => {
    it('href 付きは実リンクとして描画され、現在地に aria-current="page" が付く', () => {
        const html = renderToStaticMarkup(
            <NavItem href="/documents" active>
                文書
            </NavItem>,
        );
        expect(html).toContain('<a ');
        expect(html).toContain('href="/documents"');
        expect(html).toContain('aria-current="page"');
    });

    it('現在地でないリンクには aria-current を付けない', () => {
        const html = renderToStaticMarkup(<NavItem href="/documents">文書</NavItem>);
        expect(html).not.toContain('aria-current');
    });

    it('遷移しない項目は button で描画され href を持たない', () => {
        const html = renderToStaticMarkup(<NavItemButton>チーム</NavItemButton>);
        expect(html).toContain('<button');
        expect(html).not.toContain('href');
    });

    it('ref が実 button 要素まで届く（Esc のフォーカス復帰がこれに依存する）', () => {
        const ref = React.createRef<HTMLButtonElement>();
        const element = NavItemButton({ ref, children: 'チーム' }) as React.ReactElement<{
            ref?: React.Ref<HTMLButtonElement>;
        }>;
        expect(element.type).toBe('button');
        expect(element.props.ref).toBe(ref);
    });

    it('inline / block どちらのレイアウトでも 44px 下限を保つ', () => {
        expect(navItemClassName({ layout: 'inline' })).toContain('min-h-11');
        expect(navItemClassName({ layout: 'block' })).toContain('min-h-11');
    });

    it('選択状態と非選択状態で配色が変わる', () => {
        expect(navItemClassName({ active: true })).not.toBe(navItemClassName({ active: false }));
    });
});

describe('PageHeader', () => {
    it('h1 と説明と主要アクション枠を出す', () => {
        const html = renderToStaticMarkup(
            <PageHeader
                title="管理者画面"
                description="システム管理とモニタリング"
                actions={<Button>ホームに戻る</Button>}
            />,
        );
        expect(html).toContain('<h1');
        expect(html).toContain('管理者画面');
        expect(html).toContain('システム管理とモニタリング');
        expect(html).toContain('ホームに戻る');
    });

    it('h1 はページにひとつだけ', () => {
        const html = renderToStaticMarkup(<PageHeader title="管理者画面" />);
        expect(html.match(/<h1/g)).toHaveLength(1);
    });

    it('装飾アイコンは支援技術から隠す', () => {
        const Icon: React.FC<{ className?: string }> = ({ className }) => <svg className={className} />;
        const html = renderToStaticMarkup(<PageHeader title="管理者画面" icon={Icon} />);
        expect(html).toContain('aria-hidden="true"');
    });
});

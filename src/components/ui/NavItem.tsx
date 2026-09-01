import React from 'react';
import Link from 'next/link';

/** inline=ヘッダー横並び / block=モバイルの縦積み。 */
export type NavItemLayout = 'inline' | 'block';

interface NavItemClassNameOptions {
    active?: boolean;
    layout?: NavItemLayout;
    className?: string;
}

const NAV_ITEM_BASE =
    'relative flex min-h-11 items-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2';

export function navItemClassName({
    active = false,
    layout = 'inline',
    className = '',
}: NavItemClassNameOptions = {}): string {
    const layoutClass =
        layout === 'block' ? 'w-full justify-between gap-3 px-3 py-2 text-left' : 'px-4 py-2';
    const stateClass = active
        ? 'bg-selection text-selection-foreground'
        : 'text-muted hover:bg-surface-subtle hover:text-text-primary';
    return `${NAV_ITEM_BASE} ${layoutClass} ${stateClass}${className ? ` ${className}` : ''}`;
}

interface NavItemVisualProps {
    icon?: React.ComponentType<{ className?: string }>;
    active?: boolean;
    layout?: NavItemLayout;
    /** ラベル右（inline では絶対配置）に出すバッジ。 */
    badge?: React.ReactNode;
    /** 開閉シェブロンなど、バッジの後ろに置く装飾。 */
    trailing?: React.ReactNode;
    className?: string;
    children: React.ReactNode;
}

const NavItemContent: React.FC<NavItemVisualProps> = ({ icon: Icon, badge, trailing, children }) => (
    <>
        <span className="flex min-w-0 items-center gap-2">
            {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
            <span className="truncate whitespace-nowrap">{children}</span>
        </span>
        {badge}
        {trailing}
    </>
);

export type NavItemProps = NavItemVisualProps &
    Omit<React.ComponentPropsWithoutRef<typeof Link>, 'className' | 'children'>;

/** 現在地は aria-current="page" で伝える。href を持つ実リンクなので新規タブ・戻るが効く。 */
export const NavItem: React.FC<NavItemProps> = ({
    icon,
    active = false,
    layout = 'inline',
    badge,
    trailing,
    className = '',
    children,
    ...rest
}) => (
    <Link
        aria-current={active ? 'page' : undefined}
        className={navItemClassName({ active, layout, className })}
        {...rest}
    >
        <NavItemContent icon={icon} badge={badge} trailing={trailing}>
            {children}
        </NavItemContent>
    </Link>
);

export type NavItemButtonProps = NavItemVisualProps &
    Omit<React.ComponentPropsWithRef<'button'>, 'className' | 'children'>;

/** 遷移せずメニューを開くだけの項目（href を持たせるとリンク先が嘘になる）。 */
export const NavItemButton: React.FC<NavItemButtonProps> = ({
    icon,
    active = false,
    layout = 'inline',
    badge,
    trailing,
    className = '',
    type = 'button',
    children,
    ...rest
}) => (
    <button
        type={type}
        /* 現在地の節を開くトリガー。ページそのものへのリンクではないので "page" ではなく
           "true"（集合の中の現在項目）を使う。これが無いと、開閉式の節にいる間だけ
           ナビの現在地が支援技術から消える。 */
        aria-current={active ? 'true' : undefined}
        className={navItemClassName({ active, layout, className })}
        {...rest}
    >
        <NavItemContent icon={icon} badge={badge} trailing={trailing}>
            {children}
        </NavItemContent>
    </button>
);

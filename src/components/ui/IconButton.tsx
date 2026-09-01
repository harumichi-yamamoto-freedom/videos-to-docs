import React from 'react';
import { BUTTON_VARIANT_CLASS, type ButtonVariant } from './Button';

const ICON_BUTTON_BASE =
    'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

/* 押し下げ状態は variant を差し替えて表す。同じ役割のユーティリティを className で
   後から足しても、勝敗を決めるのは生成 CSS の順序であって class 属性の順序ではない。 */
const ICON_BUTTON_SELECTED =
    'border border-brand-border bg-selection text-selection-foreground focus-visible:ring-action';

export function iconButtonClassName(
    variant: ButtonVariant = 'ghost',
    className = '',
    selected = false,
): string {
    const variantClass = selected ? ICON_BUTTON_SELECTED : BUTTON_VARIANT_CLASS[variant];
    return `${ICON_BUTTON_BASE} ${variantClass}${className ? ` ${className}` : ''}`;
}

export interface IconButtonProps extends Omit<React.ComponentPropsWithRef<'button'>, 'aria-label'> {
    variant?: ButtonVariant;
    /** 開いている・選択中であることを配色で示す。 */
    selected?: boolean;
    /** アイコンのみのボタンなので、操作の結果が分かる説明を必ず与える。 */
    'aria-label': string;
}

export const IconButton: React.FC<IconButtonProps> = ({
    variant = 'ghost',
    selected = false,
    className = '',
    type = 'button',
    children,
    ...rest
}) => (
    <button type={type} className={iconButtonClassName(variant, className, selected)} {...rest}>
        {children}
    </button>
);

import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/* hover は not-disabled: で括る。無効時の :hover は発火するため、素の hover だけだと
   disabled でも色が動いて「押せる」と読めてしまう。anchor には :disabled が無いので
   not-disabled: は常に真になり、buttonClassName を Link へ流用しても hover は効く。 */
export const BUTTON_VARIANT_CLASS: Record<ButtonVariant, string> = {
    primary:
        'bg-action text-action-foreground not-disabled:hover:bg-action-hover focus-visible:ring-action',
    secondary:
        'border border-border bg-surface text-text-primary not-disabled:hover:bg-surface-subtle focus-visible:ring-action',
    ghost:
        'text-muted not-disabled:hover:bg-surface-subtle not-disabled:hover:text-text-primary focus-visible:ring-action',
    danger:
        'bg-status-danger text-action-foreground not-disabled:hover:bg-status-danger-strong focus-visible:ring-status-danger',
};

const BUTTON_BASE =
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

/** ボタン外観のクラス生成。Link など button 以外の要素へ同じ外観を与えるためにも使う。 */
export function buttonClassName(variant: ButtonVariant = 'primary', className = ''): string {
    return `${BUTTON_BASE} ${BUTTON_VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`;
}

export interface ButtonProps extends React.ComponentPropsWithRef<'button'> {
    variant?: ButtonVariant;
}

export const Button: React.FC<ButtonProps> = ({
    variant = 'primary',
    className = '',
    type = 'button',
    children,
    ...rest
}) => (
    <button type={type} className={buttonClassName(variant, className)} {...rest}>
        {children}
    </button>
);

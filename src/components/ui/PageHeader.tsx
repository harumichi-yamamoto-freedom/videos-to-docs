import React from 'react';

export interface PageHeaderProps {
    title: string;
    description?: React.ReactNode;
    icon?: React.ComponentType<{ className?: string }>;
    /** 主要アクション（ボタン・リンク）を置く枠。 */
    actions?: React.ReactNode;
    /** aria-labelledby から参照させたい場合に h1 へ付ける id。 */
    titleId?: string;
    className?: string;
}

/** 各ページの h1 はここに一本化する（AppHeader のブランドは見出しではない）。 */
export const PageHeader: React.FC<PageHeaderProps> = ({
    title,
    description,
    icon: Icon,
    actions,
    titleId,
    className = '',
}) => (
    <header className={`mb-6 flex flex-wrap items-start justify-between gap-4${className ? ` ${className}` : ''}`}>
        <div className="flex min-w-0 items-start gap-3">
            {Icon && (
                <span
                    aria-hidden="true"
                    className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-action-foreground shadow-elevation-persistent"
                >
                    <Icon className="h-6 w-6" />
                </span>
            )}
            <div className="min-w-0">
                <h1 id={titleId} className="text-2xl font-bold text-text-primary sm:text-3xl">
                    {title}
                </h1>
                {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
);

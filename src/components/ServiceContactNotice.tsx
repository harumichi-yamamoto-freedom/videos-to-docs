import React from 'react';

/**
 * サービスの不具合や気づいた点の連絡先案内。
 * 文言はこの定数 1 箇所にまとめる。担当者や連絡先（メール・URL）を変えるときはここだけを直す。
 * 現在はメールアドレス・URL を渡されていないため、宛先は氏名だけで示す。
 */
export const SERVICE_CONTACT_NOTICE = 'サービスの不具合や気づいた点は東野までお知らせください。';

/**
 * ヘッダー行の直下に出す細い常時表示バー。
 * - 操作を持たない案内なので、装飾ではなくテキストで伝える（role="note" は補助的な注記の意味）。
 * - 文字色 text-muted(#374151) は bg-surface-subtle(#f1f5f9) 上で 9.4:1（AA の 4.5:1 を満たす）。
 * - 文字はモバイルで text-xs、sm 以上で text-sm。行送りと余白の組で、1 行なら高さ 28px に揃う。
 *   折り返しは隠さず伸ばす（truncate しない）。
 */
export const ServiceContactNotice: React.FC = () => (
    <div className="border-t border-elevation-persistent-boundary bg-surface-subtle">
        <p
            role="note"
            className="container mx-auto max-w-7xl px-4 py-1.5 text-center text-xs text-muted sm:py-1 sm:text-sm"
        >
            {SERVICE_CONTACT_NOTICE}
        </p>
    </div>
);

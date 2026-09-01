'use client';

import React from 'react';
import { AppShell } from '@/components/AppShell';

/* /admin は (dashboard) ルートグループの外にあるため、共通シェルをここでも張る。
   ページ側は SettingsPanel から型を import されており、移動させると参照が切れる。 */
export default function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <AppShell>{children}</AppShell>;
}

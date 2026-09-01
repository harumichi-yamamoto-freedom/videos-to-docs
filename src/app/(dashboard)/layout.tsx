'use client';

import React from 'react';
import { AppShell } from '@/components/AppShell';

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <AppShell>{children}</AppShell>;
}

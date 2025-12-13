'use client';

import React, { Suspense } from 'react';
import { AppHeader } from '@/components/AppHeader';

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
            <Suspense fallback={<div className="h-20" />}>
                <AppHeader />
            </Suspense>
            <main className="container mx-auto px-10 py-8 max-w-full">
                {children}
            </main>
        </div>
    );
}



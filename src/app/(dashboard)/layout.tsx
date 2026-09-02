'use client';

import React, { useEffect } from 'react';
import { AppShell } from '@/components/AppShell';
import { setupClientErrorReporter } from '@/lib/clientErrorReporter';

/* 未捕捉エラー観測 (S2-8) を1回だけ起動する最小のクライアント境界。
   登録は setupClientErrorReporter 側で冪等なので、StrictMode の effect 二重実行や
   レイアウト再マウントで二重登録にはならない。unmount で外さないのは、リスナーが
   ページ寿命の観測用で、ルート遷移のたびに監視を切らないため。 */
function ClientErrorReporterMount(): null {
    useEffect(() => {
        setupClientErrorReporter();
    }, []);
    return null;
}

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <>
            <ClientErrorReporterMount />
            <AppShell>{children}</AppShell>
        </>
    );
}

'use client';

import React, { Suspense } from 'react';
import { AppHeader } from '@/components/AppHeader';

/**
 * スキップリンク・ヘッダー・main ランドマークを 1 か所で定義するアプリシェル。
 * ルートグループごとの layout から呼び、シェルの実体が分岐しないようにする。
 */
export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="flex min-h-dvh flex-col bg-gradient-to-br from-blue-50 to-indigo-100">
        {/* not-sr-only は padding:0 を含み、詳細度(0,2,0)で素の px-4/py-3 に勝つ。
            余白は同じ focus-visible: 修飾で上書きし直さないと、フォーカス時だけ潰れる。 */}
        <a
            href="#main-content"
            className="sr-only z-50 rounded-lg bg-action px-4 py-3 font-bold text-action-foreground shadow-elevation-overlay outline-none focus-visible:not-sr-only focus-visible:fixed focus-visible:left-4 focus-visible:top-4 focus-visible:px-4 focus-visible:py-3 focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
        >
            メインコンテンツへ移動
        </a>
        <Suspense fallback={<div className="h-20" />}>
            <AppHeader />
        </Suspense>
        <main
            id="main-content"
            tabIndex={-1}
            className="container mx-auto w-full max-w-7xl flex-1 px-4 py-8 outline-none"
        >
            {children}
        </main>
    </div>
);

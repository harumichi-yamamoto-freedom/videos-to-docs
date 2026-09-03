// @vitest-environment jsdom

/**
 * (dashboard) レイアウトが未捕捉エラー観測 (S2-8) を起動する配線の錠。
 * 純関数 (clientErrorReporter) だけ守っても、この1行が消えると観測は全滅するので
 * マウント時の呼び出しを実マウントで検査する。
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const setupClientErrorReporter = vi.hoisted(() => vi.fn());

vi.mock('@/lib/clientErrorReporter', () => ({ setupClientErrorReporter }));
vi.mock('@/components/AppShell', () => ({
    AppShell: ({ children }: { children: React.ReactNode }) => <div data-shell="">{children}</div>,
}));

import DashboardLayout from './layout';

describe('DashboardLayout の未捕捉エラー観測 (S2-8)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    beforeEach(() => {
        setupClientErrorReporter.mockClear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('マウント時に setupClientErrorReporter を呼び、子をシェルの中へ描画する', async () => {
        await act(async () => {
            root.render(
                <DashboardLayout>
                    <p>本文</p>
                </DashboardLayout>,
            );
        });

        expect(setupClientErrorReporter).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[data-shell] p')?.textContent).toBe('本文');
    });

    it('StrictMode 配下でも子を描画し、setup を呼ぶ (冪等性は reporter 側が担う)', async () => {
        await act(async () => {
            root.render(
                <React.StrictMode>
                    <DashboardLayout>
                        <p>本文</p>
                    </DashboardLayout>
                </React.StrictMode>,
            );
        });

        expect(setupClientErrorReporter).toHaveBeenCalled();
        expect(container.querySelector('[data-shell] p')?.textContent).toBe('本文');
    });

    it('静的レンダリング (SSR) では effect が走らず setup を呼ばない', () => {
        const html = renderToStaticMarkup(
            <DashboardLayout>
                <p>本文</p>
            </DashboardLayout>,
        );

        expect(html).toContain('<p>本文</p>');
        expect(setupClientErrorReporter).not.toHaveBeenCalled();
    });
});

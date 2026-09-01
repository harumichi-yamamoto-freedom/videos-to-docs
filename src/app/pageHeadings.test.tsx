import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * AppHeader からブランド h1 を外した対の錠。
 * 「ヘッダーは h1 を持たない」だけを錠にすると、どのページにも h1 が無い状態が全緑になる。
 */

const state = vi.hoisted(() => ({
    user: { uid: 'u1' } as { uid: string } | null,
    authLoading: false,
    isAdmin: true,
    adminLoading: false,
    adminError: null as Error | null,
    teamView: 'view=subordinates',
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(state.teamView),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: state.user, loading: state.authLoading }) }));
vi.mock('@/hooks/useAdmin', () => ({
    useAdmin: () => ({
        isAdmin: state.isAdmin,
        loading: state.adminLoading,
        error: state.adminError,
        retry: vi.fn(),
    }),
}));
vi.mock('@/components/admin/AuditLogPanel', () => ({ default: () => <div>監査ログ</div> }));
vi.mock('@/components/admin/SettingsPanel', () => ({ default: () => <div>設定</div> }));
vi.mock('@/components/admin/UsersPanel', () => ({ default: () => <div>ユーザー</div> }));
vi.mock('@/components/admin/AudioFilesPanel', () => ({ default: () => <div>音声</div> }));
vi.mock('@/components/admin/SystemNotificationPanel', () => ({ default: () => <div>通知</div> }));
vi.mock('@/components/team/TeamPanel', () => ({ TeamPanel: () => <div>チームパネル</div> }));

const AdminPage = (await import('./admin/page')).default;
const TeamPage = (await import('./(dashboard)/team/page')).default;

/** このツリーで見出しを適用済みのページ。実際に描画して h1 を数える。 */
const APPLIED_PAGES: { name: string; render: () => string }[] = [
    { name: '/admin', render: () => renderToStaticMarkup(<AdminPage />) },
    { name: '/team', render: () => renderToStaticMarkup(<TeamPage />) },
];

/**
 * 🔴 統合チェックリスト項目: 統合ツリーではこの 2 件を APPLIED_PAGES へ移すこと。
 * 移すまで、この錠は全ページを覆っていない。移動は 1 行で済む形にしてある。
 * ここを空にせずに「見出しは全ページ対応済み」と記録してはならない。
 */
const INTEGRATION_PENDING_PAGES = [
    { name: '/home', reason: 'X2 レーンが R11 で適用済み・このツリーからは見えない' },
    { name: '/documents', reason: '凍結中の X3 レーン所有・統合時に lead が適用' },
] as const;

/** 見出しを自前で持っており PageHeader 経由でないページ。 */
const SELF_HEADED_PAGES = [
    { name: '/notifications', file: '(dashboard)/notifications/page.tsx' },
] as const;

/** 見出しが不要なルート。 */
const NO_HEADING_REQUIRED = [
    { name: '/', reason: '/home へリダイレクトするだけ' },
] as const;

beforeEach(() => {
    state.user = { uid: 'u1' };
    state.authLoading = false;
    state.isAdmin = true;
    state.adminLoading = false;
    state.adminError = null;
    state.teamView = 'view=subordinates';
});

/** ディスク上の実ルート（page.tsx）を列挙する。名簿の取りこぼしを錠自身に検出させる。 */
function routePagesOnDisk(): string[] {
    const appDir = fileURLToPath(new URL('.', import.meta.url));
    const routes: string[] = [];
    const walk = (dir: string, segments: string[]) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
            if (item.isDirectory()) {
                // (dashboard) のようなルートグループは URL に出ない
                const next = /^\(.*\)$/.test(item.name) ? segments : [...segments, item.name];
                walk(join(dir, item.name), next);
            } else if (/^page\.(tsx|ts|jsx|js)$/.test(item.name)) {
                routes.push('/' + segments.join('/'));
            }
        }
    };
    walk(appDir, []);
    return routes.sort();
}

describe('見出しの覆い範囲 (Y11)', () => {
    it('全ルートがいずれかの名簿に載っている（新規ページを黙って見逃さない）', () => {
        const accounted = new Set<string>([
            ...APPLIED_PAGES.map(page => page.name),
            ...INTEGRATION_PENDING_PAGES.map(page => page.name),
            ...SELF_HEADED_PAGES.map(page => page.name),
            ...NO_HEADING_REQUIRED.map(page => page.name),
        ]);
        const unaccounted = routePagesOnDisk().filter(route => !accounted.has(route));
        expect(unaccounted, `名簿に無いルート: ${unaccounted.join(', ')}`).toEqual([]);
    });

    it('統合待ちが残っている間は「全ページ適用済み」と記録しない', () => {
        // このツリーで描画して確かめられているのは APPLIED_PAGES だけ。
        // 統合で 2 件を移した時点で、ここが 0 件になり錠が全ページを覆う。
        const pending = INTEGRATION_PENDING_PAGES.map(page => page.name);
        expect(pending.length, '統合待ちが 0 件なら APPLIED_PAGES 側へ移動済みのはず').toBeGreaterThan(0);
        for (const page of INTEGRATION_PENDING_PAGES) {
            expect(page.reason.length, `${page.name} に理由が無い`).toBeGreaterThan(0);
        }
        expect(APPLIED_PAGES.map(page => page.name)).not.toContain('/home');
        expect(APPLIED_PAGES.map(page => page.name)).not.toContain('/documents');
    });

    it('自前見出しのページは実際に h1 を持っている', () => {
        for (const page of SELF_HEADED_PAGES) {
            const source = readFileSync(fileURLToPath(new URL(`./${page.file}`, import.meta.url)), 'utf8');
            expect(source.match(/<h1\b/g) ?? [], page.name).toHaveLength(1);
        }
    });
});

describe('適用済みページの見出し (Y1)', () => {
    it.each(APPLIED_PAGES)('$name は h1 をちょうど 1 本持つ', ({ render }) => {
        const headings = render().match(/<h1\b/g) ?? [];
        expect(headings).toHaveLength(1);
    });

    it.each(APPLIED_PAGES)('$name の h1 は中身が空でない', ({ render }) => {
        const text = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(render())?.[1] ?? '';
        expect(text.replace(/<[^>]*>/g, '').trim().length).toBeGreaterThan(0);
    });

    it('/team は読み込み中（Suspense fallback）でも h1 を欠かさない', () => {
        // fallback を直接描画して、見出しが遅れて現れないことを確かめる
        const element = TeamPage() as React.ReactElement<{ fallback: React.ReactNode }>;
        const fallback = renderToStaticMarkup(<>{element.props.fallback}</>);
        expect(fallback.match(/<h1\b/g) ?? []).toHaveLength(1);
        expect(fallback).toContain('チーム');
    });

    it('/team の h1 は view が変わっても 1 本のまま', () => {
        state.teamView = 'view=supervisors';
        const html = renderToStaticMarkup(<TeamPage />);
        expect(html.match(/<h1\b/g) ?? []).toHaveLength(1);
        expect(html).toContain('上司');
    });

    it('/admin はどの権限状態でも h1 を保つ', () => {
        for (const setup of [
            () => { state.adminLoading = true; },
            () => { state.adminError = new Error('x'); },
            () => { state.isAdmin = false; },
            () => { state.user = null; },
        ]) {
            state.user = { uid: 'u1' };
            state.authLoading = false;
            state.isAdmin = true;
            state.adminLoading = false;
            state.adminError = null;
            setup();
            expect(renderToStaticMarkup(<AdminPage />).match(/<h1\b/g) ?? []).toHaveLength(1);
        }
    });
});

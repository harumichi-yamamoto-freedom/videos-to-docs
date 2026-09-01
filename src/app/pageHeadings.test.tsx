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
    adminStatus: 'allowed' as 'checking' | 'allowed' | 'denied' | 'error',
    teamView: 'view=subordinates',
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(state.teamView),
    usePathname: () => '/documents',
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: state.user, loading: state.authLoading }) }));
vi.mock('@/hooks/useAdmin', async () => {
    const { adminAccessResult } = await import('@/testUtils/hookResults');
    return { useAdmin: () => adminAccessResult(state.adminStatus) };
});
vi.mock('@/components/admin/AuditLogPanel', () => ({ default: () => <div>監査ログ</div> }));
vi.mock('@/components/admin/SettingsPanel', () => ({ default: () => <div>設定</div> }));
vi.mock('@/components/admin/UsersPanel', () => ({ default: () => <div>ユーザー</div> }));
vi.mock('@/components/admin/AudioFilesPanel', () => ({ default: () => <div>音声</div> }));
vi.mock('@/components/admin/SystemNotificationPanel', () => ({ default: () => <div>通知</div> }));
vi.mock('@/components/team/TeamPanel', () => ({ TeamPanel: () => <div>チームパネル</div> }));

// --- /home を描画するための最小モック（X2 レーンの page.test.tsx と同じ形） ---
vi.mock('@/hooks/usePromptManagement', () => ({
    usePromptManagement: () => ({
        data: [], availablePrompts: [], status: 'success', error: null,
        retry: vi.fn(), reloadPrompts: vi.fn(),
        bulkSelectedPromptIds: [], toggleBulkPrompt: vi.fn(),
    }),
}));
vi.mock('@/hooks/useFileManagement', () => ({
    useFileManagement: () => ({
        selectedFiles: [], handleFilesSelected: vi.fn(), handleRemoveFile: vi.fn(),
        toggleFilePrompt: vi.fn(), clearFiles: vi.fn(), cleanupDeletedPrompts: vi.fn(),
    }),
}));
vi.mock('@/hooks/useVideoProcessing', () => ({
    useVideoProcessing: () => ({
        processingStatuses: [], setProcessingStatuses: vi.fn(),
        isProcessing: false, setIsProcessing: vi.fn(),
        ffmpegLoaded: false, setFfmpegLoaded: vi.fn(),
        converterRef: { current: null }, geminiClientRef: { current: null },
        audioConversionQueueRef: { current: false },
        processTranscription: vi.fn(), processTranscriptionResume: vi.fn(),
        activeJobIds: [], hasActiveJobs: false,
        pendingSaveCount: 0, needsDiscardConfirm: false,
        pendingSavesForFile: () => 0, needsRemovalConfirm: () => false,
        isCanceling: false, claimJob: vi.fn(), cancelJob: vi.fn(), markJobCanceled: vi.fn(),
        resetProcessing: vi.fn(), forceDiscardProcessing: vi.fn(), countPendingSaves: vi.fn(() => 0),
    }),
}));
vi.mock('@/hooks/useProcessingWorkflow', () => ({
    useProcessingWorkflow: () => ({
        handleStartProcessing: vi.fn(), handleResumeFile: vi.fn(),
        workflowError: null, clearWorkflowError: vi.fn(), reportWorkflowError: vi.fn(),
    }),
}));
vi.mock('@/components/PromptListSidebar', () => ({ PromptListSidebar: () => null }));
vi.mock('@/components/prompts/PromptModals', () => ({ PromptModals: () => null }));
vi.mock('@/components/NotificationBanner', () => ({ NotificationBanner: () => null }));
vi.mock('@/components/DebugControls', () => ({ DebugControls: () => null }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));

// --- /documents を描画するための最小モック ---
vi.mock('@/components/DocumentListSidebar', () => ({ DocumentListSidebar: () => null }));
vi.mock('@/components/DocumentDetailPanel', () => ({ DocumentDetailPanel: () => null }));
vi.mock('@/lib/firestore', () => ({
    restoreTranscription: vi.fn(),
    updateTranscription: vi.fn(),
}));

const AdminPage = (await import('./admin/page')).default;
const TeamPage = (await import('./(dashboard)/team/page')).default;
const HomePage = (await import('./(dashboard)/home/page')).default;
const DocumentsPage = (await import('./(dashboard)/documents/page')).default;

/** このツリーで見出しを適用済みのページ。実際に描画して h1 を数える。 */
const APPLIED_PAGES: { name: string; render: () => string }[] = [
    { name: '/admin', render: () => renderToStaticMarkup(<AdminPage />) },
    { name: '/team', render: () => renderToStaticMarkup(<TeamPage />) },
    { name: '/home', render: () => renderToStaticMarkup(<HomePage />) },
    { name: '/documents', render: () => renderToStaticMarkup(<DocumentsPage />) },
];

/**
 * 統合待ちのページ置き場。統合で全ページが APPLIED_PAGES へ移り、現在は空。
 * 新しいページを他レーンが持ち込んだときは、描画して h1 を数えられるように
 * なるまでここへ理由つきで置く。空でない間、この錠は全ページを覆っていない。
 */
const INTEGRATION_PENDING_PAGES: { name: string; reason: string }[] = [];

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
    state.adminStatus = 'allowed';
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

    it('見出しを持つべきページはすべて実際に描画して数えている', () => {
        // 統合完了時点で統合待ちは 0 件。ここに何か積まれている間は、
        // その分だけ錠が覆えていないので理由が要る。
        for (const page of INTEGRATION_PENDING_PAGES) {
            expect(page.reason.length, `${page.name} に理由が無い`).toBeGreaterThan(0);
        }

        const rendered = new Set<string>(APPLIED_PAGES.map(page => page.name));
        const selfHeaded = new Set<string>(SELF_HEADED_PAGES.map(page => page.name));
        const exempt = new Set<string>(NO_HEADING_REQUIRED.map(page => page.name));
        const pending = new Set<string>(INTEGRATION_PENDING_PAGES.map(page => page.name));

        const uncovered = routePagesOnDisk()
            .filter(route => !exempt.has(route) && !selfHeaded.has(route))
            .filter(route => !rendered.has(route));
        expect(uncovered, `描画検査から漏れているルート: ${uncovered.join(', ')}`)
            .toEqual([...pending].filter(route => uncovered.includes(route)));
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
            () => { state.adminStatus = 'checking'; },
            () => { state.adminStatus = 'error'; },
            () => { state.adminStatus = 'denied'; },
            () => { state.user = null; },
        ]) {
            state.user = { uid: 'u1' };
            state.authLoading = false;
            state.adminStatus = 'allowed';
            setup();
            expect(renderToStaticMarkup(<AdminPage />).match(/<h1\b/g) ?? []).toHaveLength(1);
        }
    });
});

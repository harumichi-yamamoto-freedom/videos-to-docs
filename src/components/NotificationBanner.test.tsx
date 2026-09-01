import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SystemNotification } from '@/lib/systemNotifications';

const retry = vi.hoisted(() => vi.fn());

const state = vi.hoisted(() => ({
    user: { uid: 'u1' } as { uid: string } | null,
    loading: false,
    banner: [] as SystemNotification[],
    error: null as Error | null,
    stale: false,
    retrying: false,
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: state.user, loading: false }) }));

vi.mock('@/hooks/useSystemNotifications', async () => {
    const { systemNotificationsResult } = await import('@/testUtils/hookResults');
    return {
        useSystemNotifications: () => systemNotificationsResult({
            notifications: state.banner,
            bannerNotifications: state.banner,
            loading: state.loading,
            error: state.error,
            stale: state.stale,
            retrying: state.retrying,
            retry,
        }),
    };
});

vi.mock('@/lib/systemNotifications', () => ({ dismissNotification: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

const { NotificationBanner } = await import('./NotificationBanner');

const notification = (over: Partial<SystemNotification> = {}): SystemNotification => ({
    id: 'n1',
    title: 'メンテナンスのお知らせ',
    body: '本文',
    severity: 'info',
    published: true,
    publishedAt: new Date('2026-08-01T00:00:00Z'),
    publishedBy: 'admin',
    ...over,
});

const render = () => renderToStaticMarkup(<NotificationBanner />);

beforeEach(() => {
    retry.mockClear();
    state.user = { uid: 'u1' };
    state.loading = false;
    state.banner = [notification()];
    state.error = null;
    state.stale = false;
    state.retrying = false;
});

describe('NotificationBanner の入れ子解消 (E7)', () => {
    it('本文は実リンクで、閉じるボタンはその入れ子ではなく兄弟になる', () => {
        const html = render();
        const anchorEnd = html.indexOf('</a>');
        const closeButton = html.indexOf('<button');

        expect(anchorEnd).toBeGreaterThan(-1);
        expect(closeButton).toBeGreaterThan(anchorEnd);
    });

    it('偽のボタン（role="button" の div）を使わない', () => {
        expect(render()).not.toContain('role="button"');
    });

    it('本文リンクは通知の詳細を開く href を持つ', () => {
        expect(render()).toContain('href="/notifications?open=n1"');
    });

    it('閉じるボタンの読み上げ名が「今後表示しない」効果まで伝える', () => {
        const html = render();
        const label = /aria-label="([^"]*)"/.exec(html)?.[1] ?? '';
        expect(label).toContain('メンテナンスのお知らせ');
        expect(label).toContain('今後');
    });

    it('閉じるボタンは 44px 角を満たす', () => {
        const buttonTag = /<button\b[^>]*>/.exec(render())?.[0] ?? '';
        expect(buttonTag).toContain('min-h-11');
        expect(buttonTag).toContain('min-w-11');
    });

    it('未認証時は閉じるボタンを出さない', () => {
        state.user = null;
        expect(render()).not.toContain('<button');
    });
});

describe('意味トークンだけで配色する (Y6)', () => {
    // ファイル全体の生パレット禁止は src/app/rawPalette.test.ts が所有ファイル横断で持つ。
    // ここでは描画結果に状態トークンが実際に出ていることだけを見る。
    it('info と critical の両方が状態トークンで hover を持つ', () => {
        state.banner = [notification({ severity: 'critical', title: '障害のお知らせ' })];
        expect(render()).toContain('hover:bg-status-danger-bg-hover');

        state.banner = [notification({ severity: 'info' })];
        expect(render()).toContain('hover:bg-status-info-bg-hover');
    });
});

describe('NotificationBanner が購読エラーを捨てない (E10)', () => {
    it('購読が失敗して 1 件も出せないとき、無言で消えず再試行を出す', () => {
        state.banner = [];
        state.error = new Error('permission-denied');
        const html = render();

        expect(html).toContain('role="alert"');
        expect(html).toContain('お知らせを取得できませんでした');
        expect(html).toContain('再試行');
    });

    it('取得済みの内容を出しながら失敗している場合は古い可能性を明示する', () => {
        state.error = new Error('network');
        state.stale = true;
        const html = render();

        expect(html).toContain('最新ではない可能性があります');
        expect(html).toContain('メンテナンスのお知らせ');
    });

    it('再取得中は再試行ボタンを押せなくし、進行中だと分かる文言にする', () => {
        state.banner = [];
        state.error = new Error('network');
        state.retrying = true;
        const html = render();

        expect(html).toContain('再試行しています...');
        expect(html).toContain('disabled=""');
    });

    it('再取得中でなければ押せる状態で出す', () => {
        state.banner = [];
        state.error = new Error('network');
        const html = render();

        expect(html).toContain('>再試行<');
        expect(html).not.toContain('disabled=""');
    });

    it('読み込み中は何も出さない（エラーと読み込み中を混同しない）', () => {
        state.loading = true;
        state.error = new Error('network');
        expect(render()).toBe('');
    });

    it('正常かつ 0 件なら何も出さない', () => {
        state.banner = [];
        expect(render()).toBe('');
    });
});

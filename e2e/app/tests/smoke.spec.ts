import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { collectConsole, DEFAULT_SEED_PROMPTS, isRelevantConsoleError, resetEmulators, seedGuestPrompts } from '../helpers';

/**
 * 全画面の素通し: 描画される・console error と pageerror が無い・横スクロールしない・
 * axe の critical/serious が無い・**エミュレータに向いている**（本番に触れていない tripwire）。
 * desktop と mobile(Pixel 7) の両方で回る（playwright.config の projects）。
 */
const ROUTES: Array<{ path: string; heading: string }> = [
    { path: '/', heading: 'ホーム' },
    { path: '/home', heading: 'ホーム' },
    { path: '/documents', heading: '文書' },
    { path: '/notifications', heading: 'お知らせ' },
    { path: '/team', heading: 'チーム' },
    { path: '/admin', heading: '管理者画面' },
];

test.beforeAll(async () => {
    await resetEmulators();
    await seedGuestPrompts(DEFAULT_SEED_PROMPTS);
});

for (const route of ROUTES) {
    test(`${route.path} が描画され、console error・横スクロール・重大な a11y 違反が無い`, async ({ page }) => {
        const console_ = collectConsole(page);
        const failed: string[] = [];
        page.on('requestfailed', request => {
            // Next の RSC 先読みは遷移で中断されることがある (ERR_ABORTED)。それ以外の失敗だけ数える
            if (request.failure()?.errorText !== 'net::ERR_ABORTED') failed.push(`${request.method()} ${request.url()}`);
        });

        const response = await page.goto(route.path);
        expect(response?.status(), 'HTTP status').toBeLessThan(400);
        await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
        await page.waitForTimeout(1500);

        expect(console_.hasEmulatorWarning(), 'ブラウザ SDK がエミュレータに接続していること（本番に触れない tripwire）').toBe(true);
        expect(console_.errors.filter(isRelevantConsoleError), 'console error / pageerror').toEqual([]);
        expect(failed, '失敗したリクエスト').toEqual([]);

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, '横方向のはみ出し (px)').toBeLessThanOrEqual(1);

        const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        const serious = axe.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
        expect(
            serious.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(', ')}`),
            'axe critical/serious',
        ).toEqual([]);
    });
}

test('存在しないパスは 404 画面になる', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
});

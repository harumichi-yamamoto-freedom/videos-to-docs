import { expect, test } from '@playwright/test';
import {
    addFiles, choosePrompt, DEFAULT_SEED_PROMPTS, ensureFixtures, expectCompleted, expectErrorRow, fixture,
    mockGenerateError, mockGenerateSuccess, openHome, resetEmulators, seedGuestPrompts, startProcessing,
} from '../helpers';

/**
 * サーバ側の失敗が、契約 (src/lib/generateApiContract.ts) の文言のまま利用者に届き、次の手（再開・再変換）が出ること。
 * 差し替えは page.route（サーバのコードは通らない。サーバ側の分類は vitest が守る）。
 */
test.beforeAll(async () => {
    await resetEmulators();
    await seedGuestPrompts(DEFAULT_SEED_PROMPTS);
});

test.skip(!ensureFixtures().available, 'ffmpeg が無くテスト用メディアを作れない');

test.beforeEach(async ({ page }) => {
    await openHome(page);
    await choosePrompt(page, 'e2e 議事録');
    await addFiles(page, fixture('tone5s.mp3'));
});

test('503 not_configured: サーバの文言がそのまま出て、再開できる', async ({ page }) => {
    await mockGenerateError(page, 503, { error: 'not_configured', message: 'サーバの設定が完了していません (Gemini API キーが未設定)。管理者に連絡してください。' });
    await startProcessing(page);
    await expectErrorRow(page, 'Gemini API キーが未設定');
    await expect(page.getByRole('button', { name: /再開する/ })).toBeVisible();

    // 復旧後に再開すると同じアップロードで生成だけやり直す
    await page.unroute('**/api/generate');
    const generate = await mockGenerateSuccess(page);
    await page.getByRole('button', { name: /再開する/ }).click();
    await expectCompleted(page, 1);
    expect(generate.calls).toHaveLength(1);
});

test('429 rate_limited: 待ち時間つきの文言が出る', async ({ page }) => {
    await mockGenerateError(page, 429, { error: 'rate_limited', message: '時間あたりの上限に達しました。しばらく待ってから再度お試しください。', retryAfterSec: 1800 });
    await startProcessing(page);
    await expectErrorRow(page, '時間あたりの上限に達しました');
    await expect(page.getByText(/約30分後に再試行できます/)).toBeVisible();
});

test('413 media_too_large: 「アップロードできない」と読ませず、変換して再試行する導線が出る', async ({ page }) => {
    await mockGenerateError(page, 413, { error: 'media_too_large', message: 'この音声は文書生成に送れる上限を超えています。ビットレートを下げて変換し直してください。' });
    await startProcessing(page);
    await expectErrorRow(page, '上限を超えています');
    // サイズ超過の行には通常の「再開する」（同じデータを送り直すだけ）を出さない
    await expect(page.getByRole('button', { name: '再開する' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /変換|ビットレートを下げて/ }).first()).toBeVisible();
});

test('契約外の応答 (HTML 502) でも生の英文ではなく日本語の文言になる', async ({ page }) => {
    await page.route('**/api/generate', route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }));
    await startProcessing(page);
    await expectErrorRow(page, '文書生成サーバがエラーを返しました（HTTP 502）');
});

test('ネットワーク断は「インターネット接続を確認」になる', async ({ page }) => {
    await page.route('**/api/generate', route => route.abort('internetdisconnected'));
    await startProcessing(page);
    await expectErrorRow(page, 'ネットワークエラー');
});

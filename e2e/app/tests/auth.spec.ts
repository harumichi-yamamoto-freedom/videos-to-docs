import { expect, test } from '@playwright/test';
import {
    addFiles, choosePrompt, DEFAULT_SEED_PROMPTS, ensureFixtures, expectCompleted, fixture, listCollection,
    mockGenerateSuccess, openHome, resetEmulators, seedGuestPrompts, startProcessing,
} from '../helpers';

/**
 * 認証の境界: アカウント作成 → 自分の文書だけ見える → ログアウトでゲストに戻る。
 * Auth エミュレータなので本物のメール送信・Google 認証は無い。
 */
const EMAIL = `e2e-${Date.now()}@example.com`;
const PASSWORD = 'e2e-password-123';

test.beforeAll(async () => {
    await resetEmulators();
    await seedGuestPrompts(DEFAULT_SEED_PROMPTS);
});

test.skip(!ensureFixtures().available, 'ffmpeg が無くテスト用メディアを作れない');

test('ゲストの文書はログイン後に見えず、ログアウトで戻る', async ({ page }) => {
    // 1. ゲストで 1 件作る
    await mockGenerateSuccess(page);
    await openHome(page);
    await choosePrompt(page, 'e2e 議事録');
    await addFiles(page, fixture('tone5s.mp3'));
    await startProcessing(page);
    await expectCompleted(page, 1);

    // 2. アカウント作成
    await page.getByRole('button', { name: 'ログイン / アカウント作成' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // 既定はログイン。フッターの切替でアカウント作成へ
    await dialog.getByRole('button', { name: 'アカウント作成' }).last().click();
    await dialog.getByLabel(/表示名/).fill('e2e 利用者');
    await dialog.getByLabel(/メールアドレス/).fill(EMAIL);
    await dialog.getByLabel(/パスワード/).fill(PASSWORD);
    await dialog.getByRole('button', { name: 'アカウント作成', exact: true }).first().click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'ログイン / アカウント作成' })).toHaveCount(0);

    // 3. ログイン後の文書一覧にゲストの文書は無い
    await page.goto('/documents');
    await expect(page.getByRole('heading', { level: 1, name: '文書' })).toBeVisible();
    await expect(page.getByText('tone5s.mp3')).toHaveCount(0);

    // 4. ログイン中に 1 件作ると所有者は自分になり、認証ヘッダが付く
    const generate = await mockGenerateSuccess(page);
    await openHome(page);
    // ログイン利用者には自分の既定プロンプト（テンプレート由来）が自動生成される
    await choosePrompt(page, 'お客様情報');
    await addFiles(page, fixture('tone5s.mp3'));
    await startProcessing(page);
    await expectCompleted(page, 1);
    expect(generate.calls[0].authorization).toMatch(/^Bearer /);
    expect(String(generate.calls[0].body.storagePath)).not.toContain('/GUEST/');
    const docs = await listCollection('transcriptions');
    const owners = new Set(docs.map(d => d.ownerType));
    expect(owners).toEqual(new Set(['guest', 'user']));

    // 5. ログアウトするとゲストの文書だけが見える
    await page.getByRole('button', { name: /e2e 利用者|アカウント|メニュー/ }).first().click();
    await page.getByRole('button', { name: /ログアウト/ }).click();
    await expect(page.getByRole('button', { name: 'ログイン / アカウント作成' })).toBeVisible({ timeout: 30_000 });
    await page.goto('/documents');
    await expect(page.getByText('tone5s.mp3').first()).toBeVisible();
});

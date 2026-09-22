import { expect, test } from '@playwright/test';
import { openHome, resetEmulators } from '../helpers';

/**
 * 初回訪問（ゲスト共有プロンプトがまだ 1 件も無い）で、右の「プロンプトの管理」が既定プロンプトを自動生成したあと、
 * 左の「適用するプロンプトを選ぶ」にもそれが現れること。
 *
 * 🔴 2026-09-22 の実測で、自動生成後も左は「全文文字起こし」だけのまま止まっていた（2 つの読み込みが独立していた）。
 *    PromptListSidebar.onDefaultsInitialized → usePromptManagement.reloadPrompts で直した。この検査はその回帰。
 */
test.beforeEach(async () => {
    await resetEmulators(); // 種まきしない = 空の DB
});

test('空の DB でも、自動生成された既定プロンプトが選択肢に現れて既定が 1 つ選ばれる', async ({ page }) => {
    await openHome(page);
    const fieldset = page.getByRole('group', { name: '適用するプロンプトを選ぶ' });
    // 右の一覧が自動生成を終える
    await expect(page.getByText(/[1-9]\d*件のプロンプト/)).toBeVisible({ timeout: 30_000 });
    // 左にも同じ既定プロンプトが出る（テンプレート名の 1 つ）
    await expect(fieldset.getByLabel('お客様情報')).toBeVisible({ timeout: 30_000 });
    // isDefault の先頭が 1 つだけ自動選択される
    const checked = await fieldset.getByRole('checkbox', { checked: true }).count();
    expect(checked).toBe(1);
});

test('プロンプトを新規作成すると、選択肢と一覧の両方に即座に出る', async ({ page }) => {
    await openHome(page);
    await expect(page.getByText(/[1-9]\d*件のプロンプト/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '新規プロンプト' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/プロンプト名|名前/).fill('e2e 追加プロンプト');
    await dialog.getByLabel(/プロンプト内容|内容|本文/).fill('e2e 用の本文です。');
    await dialog.getByRole('button', { name: /保存|作成/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('group', { name: '適用するプロンプトを選ぶ' }).getByLabel('e2e 追加プロンプト')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'e2e 追加プロンプト' }).or(page.getByText('e2e 追加プロンプト').nth(1))).toBeVisible();
});

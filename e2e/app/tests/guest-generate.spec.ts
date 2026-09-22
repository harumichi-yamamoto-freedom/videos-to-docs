import { expect, test } from '@playwright/test';
import {
    addFiles, choosePrompt, collectConsole, DEFAULT_SEED_PROMPTS, ensureFixtures, expectCompleted, fixture,
    isRelevantConsoleError, listCollection, mockGenerateSuccess, openHome, resetEmulators, seedGuestPrompts, startProcessing,
} from '../helpers';

/**
 * ゲストの基本経路: 圧縮済み音声 (mp3) は変換を飛ばして Storage へ上がり、/api/generate が呼ばれ、文書が保存される。
 * /api/generate はサーバの契約どおりの応答で差し替える（Gemini は呼ばない）。
 */
test.beforeAll(async () => {
    await resetEmulators();
    await seedGuestPrompts(DEFAULT_SEED_PROMPTS);
});

test.skip(!ensureFixtures().available, 'ffmpeg が無くテスト用メディアを作れない');

test('mp3 を 1 本、プロンプト 1 つで文書が保存され、文書一覧に出る', async ({ page }) => {
    const console_ = collectConsole(page);
    const generate = await mockGenerateSuccess(page, '# e2e 議事録\n\n- 本文');

    await openHome(page);
    await choosePrompt(page, 'e2e 議事録');
    await addFiles(page, fixture('tone5s.mp3'));
    await startProcessing(page);
    await expectCompleted(page, 1);

    // サーバへ渡した内容が契約どおり（ゲストは GUEST 配下・元の MIME・選んだプロンプト・認証ヘッダ無し）
    expect(generate.calls).toHaveLength(1);
    const call = generate.calls[0];
    expect(String(call.body.storagePath)).toMatch(/^audio\/GUEST\/\d+_tone5s(\.mp3)?\.mp3$/);
    expect(call.body.mimeType).toBe('audio/mpeg');
    expect(call.body.fileName).toBe('tone5s.mp3');
    expect((call.body.prompt as { name: string }).name).toBe('e2e 議事録');
    expect(call.authorization).toBeNull();

    // Firestore に文書が 1 件、ゲスト所有で保存されている
    const docs = await listCollection('transcriptions');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ ownerType: 'guest', ownerId: 'GUEST', promptName: 'e2e 議事録', fileName: 'tone5s.mp3' });
    // 本文のフィールド名は実装都合で変わり得るので、文字列フィールドのどれかに本文が入っていることだけ見る
    expect(Object.values(docs[0]).some(v => typeof v === 'string' && v.includes('e2e 議事録')), `保存された本文: ${JSON.stringify(docs[0]).slice(0, 300)}`).toBe(true);

    // 文書一覧に出て、開くと本文が読める
    await page.goto('/documents');
    await expect(page.getByText('tone5s.mp3').first()).toBeVisible();
    await page.getByText('tone5s.mp3').first().click();
    await expect(page.getByText('本文').first()).toBeVisible();

    expect(console_.errors.filter(isRelevantConsoleError)).toEqual([]);
});

test('プロンプトを 2 つ選ぶと 1 本の音声から 2 件の文書ができる（並列生成）', async ({ page }) => {
    const generate = await mockGenerateSuccess(page);
    await openHome(page);
    await choosePrompt(page, 'e2e 議事録');
    await page.getByRole('group', { name: '適用するプロンプトを選ぶ' }).getByLabel('e2e 要約').check();
    await addFiles(page, fixture('tone5s.mp3'));
    await startProcessing(page);
    await expectCompleted(page, 2);

    expect(generate.calls.map(c => (c.body.prompt as { name: string }).name).sort()).toEqual(['e2e 要約', 'e2e 議事録']);
    // 同じ Storage パスを 2 回使う（アップロードは 1 回）
    expect(new Set(generate.calls.map(c => c.body.storagePath)).size).toBe(1);
});

test('プロンプト未選択では開始できない', async ({ page }) => {
    await openHome(page);
    const fieldset = page.getByRole('group', { name: '適用するプロンプトを選ぶ' });
    await expect(fieldset.getByLabel('e2e 議事録')).toBeVisible({ timeout: 30_000 });
    for (const box of await fieldset.getByRole('checkbox').all()) {
        if (await box.isChecked()) await box.uncheck();
    }
    await addFiles(page, fixture('tone5s.mp3'));
    // ファイルごとの選択も空なので開始できない（押せても文言で止まる）
    const start = page.getByRole('button', { name: '変換・文書生成を開始する' });
    if (await start.isEnabled()) {
        await start.click();
        await expect(page.getByText('最低1つのプロンプトを選択してください').first()).toBeVisible();
    } else {
        await expect(start).toBeDisabled();
    }
});

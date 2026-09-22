import { expect, test } from '@playwright/test';
import {
    addFiles, choosePrompt, collectConsole, DEFAULT_SEED_PROMPTS, ensureFixtures, expectCompleted, expectErrorRow, fixture,
    isRelevantConsoleError, mockGenerateSuccess, openHome, resetEmulators, seedGuestPrompts, startProcessing,
} from '../helpers';

/**
 * ブラウザ内 FFmpeg.wasm の実経路。core は同一オリジン (/ffmpeg/) から読む（predev で複製済み）。
 *  - 動画 → 音声変換 → アップロード → 生成 → 保存
 *  - 複数ファイル連続（PR #62 の回帰: 2 本目で wasm が死なない）
 *  - 音声トラック無しの動画は利用者向け文言で失敗する
 */
test.beforeAll(async () => {
    await resetEmulators();
    await seedGuestPrompts(DEFAULT_SEED_PROMPTS);
});

test.skip(!ensureFixtures().available, 'ffmpeg が無くテスト用メディアを作れない');

test('動画 1 本を変換して文書が保存される（core は同一オリジンから読む）', async ({ page }) => {
    const console_ = collectConsole(page);
    const coreRequests: string[] = [];
    page.on('request', request => { if (request.url().includes('ffmpeg-core')) coreRequests.push(request.url()); });
    const generate = await mockGenerateSuccess(page);

    await openHome(page);
    await choosePrompt(page, 'e2e 議事録');
    await addFiles(page, fixture('clip20s.mp4'));
    await startProcessing(page);
    await expectCompleted(page, 1, 150_000);

    expect(coreRequests.some(url => url.includes('127.0.0.1') && url.includes('/ffmpeg/ffmpeg-core')), '同一オリジンの core を使う').toBe(true);
    expect(coreRequests.some(url => url.includes('unpkg.com')), 'unpkg へ落ちていない').toBe(false);
    // 動画は変換後の mp3 を送る（サーバが受け取るのは音声）。元のファイル名は記録用に残る
    expect(generate.calls[0].body.mimeType).toBe('audio/mpeg');
    expect(generate.calls[0].body.fileName).toBe('clip20s.mp4');
    expect(String(generate.calls[0].body.storagePath)).toMatch(/\.mp3$/);
    expect(console_.errors.filter(isRelevantConsoleError)).toEqual([]);
});

test('動画と音声を同時に入れても両方完了する（2 本目で FFmpeg が死なない）', async ({ page }) => {
    const generate = await mockGenerateSuccess(page);
    await openHome(page);
    await choosePrompt(page, 'e2e 議事録');
    await addFiles(page, fixture('clip20s.mp4'), fixture('tone5s.mp3'));
    await startProcessing(page);
    await expectCompleted(page, 1, 150_000);
    await expect(page.getByRole('status').filter({ hasText: '完了しました（1/1 件の文書を保存しました）' })).toHaveCount(2, { timeout: 150_000 });
    expect(generate.calls).toHaveLength(2);

    // 呼び出しごとの契約: 動画は変換後の mp3 として、音声はそのまま。どちらも storagePath 上のデータの MIME を送る
    // (generateApiContract.ts の mimeType の説明)。ファイル名は元のまま
    const byName = Object.fromEntries(generate.calls.map(c => [String(c.body.fileName), c.body]));
    expect(Object.keys(byName).sort()).toEqual(['clip20s.mp4', 'tone5s.mp3']);
    expect(byName['clip20s.mp4'].mimeType).toBe('audio/mpeg');
    expect(String(byName['clip20s.mp4'].storagePath)).toMatch(/\.mp3$/);
    expect(byName['tone5s.mp3'].mimeType).toBe('audio/mpeg');
    expect(byName['clip20s.mp4'].storagePath).not.toBe(byName['tone5s.mp3'].storagePath);
});

test('音声トラックの無い動画は「音声トラックが含まれていません」で止まり、再開導線が出る', async ({ page }) => {
    await mockGenerateSuccess(page);
    await openHome(page);
    await choosePrompt(page, 'e2e 議事録');
    await addFiles(page, fixture('silent5s.mp4'));
    await startProcessing(page);
    await expectErrorRow(page, '音声トラックが含まれていません', 120_000);
    await expect(page.getByRole('button', { name: /再開する/ })).toBeVisible();
});

test('処理中に中止すると「中止しました」になり、再開できる', async ({ page }) => {
    const generate = await mockGenerateSuccess(page);
    await openHome(page);
    await choosePrompt(page, 'e2e 議事録');
    await addFiles(page, fixture('clip20s.mp4'));
    await startProcessing(page);
    const cancel = page.getByRole('button', { name: 'このファイルの処理を中止する' });
    await expect(cancel).toBeVisible({ timeout: 60_000 });
    await cancel.click();
    await expect(page.getByText('処理を中止しました')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /再開する/ }).click();
    await expectCompleted(page, 1, 150_000);
    expect(generate.calls.length).toBeGreaterThanOrEqual(1);
});

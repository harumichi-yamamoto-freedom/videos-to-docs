import { expect, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EMULATOR_PROJECT } from './playwright.config';

export const FIRESTORE = 'http://127.0.0.1:8080';
export const AUTH = 'http://127.0.0.1:9099';
export const FIXTURES = path.join(__dirname, 'fixtures');

const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const docsBase = `${FIRESTORE}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`;

// ---- エミュレータの初期化と種まき ------------------------------------------------

export async function resetEmulators(): Promise<void> {
    const fsRes = await fetch(`${FIRESTORE}/emulator/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    if (!fsRes.ok) throw new Error(`Firestore エミュレータの初期化に失敗: ${fsRes.status}`);
    const authRes = await fetch(`${AUTH}/emulator/v1/projects/${EMULATOR_PROJECT}/accounts`, { method: 'DELETE', headers: OWNER });
    if (!authRes.ok) throw new Error(`Auth エミュレータの初期化に失敗: ${authRes.status}`);
}

type FieldValue = { stringValue: string } | { booleanValue: boolean } | { integerValue: string } | { timestampValue: string };
const str = (v: string): FieldValue => ({ stringValue: v });
const bool = (v: boolean): FieldValue => ({ booleanValue: v });
const ts = (d: Date): FieldValue => ({ timestampValue: d.toISOString() });

export interface SeedPrompt {
    id: string;
    name: string;
    content?: string;
    isDefault?: boolean;
    createdAt?: Date;
}

/** ゲスト共有プロンプトを Firestore エミュレータへ直接書く（アプリの自動生成に依存しない） */
export async function seedGuestPrompts(prompts: SeedPrompt[]): Promise<void> {
    for (const prompt of prompts) {
        const createdAt = prompt.createdAt ?? new Date();
        const res = await fetch(`${docsBase}/prompts?documentId=${encodeURIComponent(prompt.id)}`, {
            method: 'POST',
            headers: OWNER,
            body: JSON.stringify({
                fields: {
                    name: str(prompt.name),
                    content: str(prompt.content ?? `${prompt.name}のプロンプト本文`),
                    model: str('default'),
                    thinkingLevel: str('default'),
                    isDefault: bool(prompt.isDefault ?? true),
                    ownerType: str('guest'),
                    ownerId: str('GUEST'),
                    createdBy: str('GUEST'),
                    createdAt: ts(createdAt),
                    updatedAt: ts(createdAt),
                },
            }),
        });
        if (!res.ok) throw new Error(`プロンプトの種まきに失敗 (${prompt.id}): ${res.status} ${await res.text()}`);
    }
}

export const DEFAULT_SEED_PROMPTS: SeedPrompt[] = [
    { id: 'default_GUEST_e2e_minutes', name: 'e2e 議事録', createdAt: new Date('2026-01-02T00:00:00Z') },
    { id: 'default_GUEST_e2e_summary', name: 'e2e 要約', createdAt: new Date('2026-01-01T00:00:00Z') },
];

export async function listCollection(collection: string): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${docsBase}/${collection}?pageSize=100`, { headers: OWNER });
    if (!res.ok) return [];
    const body = await res.json() as { documents?: Array<{ name: string; fields: Record<string, Record<string, unknown>> }> };
    return (body.documents ?? []).map(doc => ({
        id: doc.name.split('/').pop(),
        ...Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, Object.values(v)[0]])),
    }));
}

// ---- テスト用メディア（ffmpeg で生成。無ければ null） ----------------------------------

export type FixtureName = 'tone5s.mp3' | 'clip20s.mp4' | 'silent5s.mp4' | 'tone5s.wav';

const FIXTURE_ARGS: Record<FixtureName, string[]> = {
    'tone5s.mp3': ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '5', '-ac', '1', '-b:a', '64k'],
    'tone5s.wav': ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '5', '-ac', '1'],
    'clip20s.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '64k'],
    'silent5s.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-an'],
};

export function ensureFixtures(): { available: boolean; reason?: string } {
    fs.mkdirSync(FIXTURES, { recursive: true });
    const missing = (Object.keys(FIXTURE_ARGS) as FixtureName[]).filter(name => !fs.existsSync(path.join(FIXTURES, name)));
    if (missing.length === 0) return { available: true };
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch {
        return { available: false, reason: 'ffmpeg が無いのでテスト用メディアを作れない (brew install ffmpeg)' };
    }
    for (const name of missing) {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...FIXTURE_ARGS[name], path.join(FIXTURES, name)], { stdio: 'inherit' });
    }
    return { available: true };
}

export const fixture = (name: FixtureName): string => path.join(FIXTURES, name);

// ---- 外部 API の差し替え -----------------------------------------------------

export interface GenerateCapture {
    calls: Array<{ body: Record<string, unknown>; authorization: string | null }>;
}

/** /api/generate を契約どおりの成功応答で差し替え、リクエストを記録する */
export async function mockGenerateSuccess(page: Page, text = '# 議事録\n\n- e2e で生成した本文'): Promise<GenerateCapture> {
    const capture: GenerateCapture = { calls: [] };
    await page.route('**/api/generate', async (route: Route) => {
        const request = route.request();
        capture.calls.push({ body: request.postDataJSON() as Record<string, unknown>, authorization: await request.headerValue('authorization') });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                text, usedModel: 'gemini-3.8-flash', thinkingLevel: 'LOW', transport: 'inline',
                usage: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }, elapsedMs: 12,
            }),
        });
    });
    return capture;
}

export async function mockGenerateError(page: Page, status: number, body: { error: string; message: string; retryAfterSec?: number }): Promise<void> {
    await page.route('**/api/generate', route => route.fulfill({
        status, contentType: 'application/json',
        headers: body.retryAfterSec ? { 'retry-after': String(body.retryAfterSec) } : {},
        body: JSON.stringify(body),
    }));
}

// ---- 画面操作 ---------------------------------------------------------------

/** console の error と pageerror を集める。エミュレータ接続の警告は「本番に触れていない」証拠として別に数える */
export function collectConsole(page: Page) {
    const errors: string[] = [];
    let emulatorWarnings = 0;
    page.on('console', message => {
        const text = message.text();
        if (text.includes('Firebase エミュレータに接続')) emulatorWarnings += 1;
        if (message.type() === 'error') errors.push(text.slice(0, 400));
    });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message.slice(0, 400)}`));
    return { errors, hasEmulatorWarning: () => emulatorWarnings > 0 };
}

/** 既知の無害な console error（開発サーバ由来）を除く */
export const isRelevantConsoleError = (text: string): boolean =>
    !/Download the React DevTools|Failed to load resource: .* 404/.test(text);

export async function openHome(page: Page): Promise<void> {
    await page.goto('/home');
    await expect(page.getByRole('heading', { level: 1, name: 'ホーム' })).toBeVisible();
}

/** 「適用するプロンプトを選ぶ」に指定名が出るまで待って選ぶ（既定の自動選択があれば外してから） */
export async function choosePrompt(page: Page, name: string): Promise<void> {
    const fieldset = page.getByRole('group', { name: '適用するプロンプトを選ぶ' });
    await expect(fieldset.getByLabel(name, { exact: false })).toBeVisible({ timeout: 30_000 });
    for (const box of await fieldset.getByRole('checkbox').all()) {
        if (await box.isChecked()) await box.uncheck();
    }
    await fieldset.getByLabel(name, { exact: false }).check();
}

export async function addFiles(page: Page, ...paths: string[]): Promise<void> {
    await page.locator('input[type=file]').setInputFiles(paths);
    for (const p of paths) {
        await expect(page.getByRole('button', { name: `${path.basename(p)}を削除` })).toBeVisible();
    }
}

export const startButton = (page: Page) => page.getByRole('button', { name: '変換・文書生成を開始する' });

export async function startProcessing(page: Page): Promise<void> {
    await expect(startButton(page)).toBeEnabled();
    await startButton(page).click();
}

/** 処理状況の行が「完了しました（n/m 件…）」になるまで待つ */
export async function expectCompleted(page: Page, count: number, timeout = 120_000): Promise<void> {
    await expect(page.getByRole('status').filter({ hasText: `完了しました（${count}/${count} 件の文書を保存しました）` }).first())
        .toBeVisible({ timeout });
}

export async function expectErrorRow(page: Page, messageFragment: string, timeout = 60_000): Promise<void> {
    await expect(page.getByText(messageFragment, { exact: false }).first()).toBeVisible({ timeout });
}

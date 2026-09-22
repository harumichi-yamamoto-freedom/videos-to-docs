import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * デプロイ前の画面通し検査。
 *
 * 前提: Firebase エミュレータ (auth/firestore/storage) と Next の dev サーバ。どちらも webServer で起動する
 * （既に起動していれば再利用）。ブラウザ側 SDK をエミュレータへ向けるのは NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1
 * （src/lib/firebase.ts）。🔴 ここで渡す env は .env.local より優先されるので、開発者の .env.local に本番の値が
 * あっても e2e が本番へ書くことはない。smoke.spec がその tripwire（エミュレータ接続の console 警告）を確認する。
 *
 * 外部 API (/api/generate, /api/transcribe/*) は page.route で差し替える。Gemini / Azure の鍵は要らない。
 */
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.E2E_PORT || 3100);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const EMULATOR_PROJECT = 'demo-vtd';

const emulatorEnv = {
    NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-api-key',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${EMULATOR_PROJECT}.firebaseapp.com`,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: EMULATOR_PROJECT,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${EMULATOR_PROJECT}.appspot.com`,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
    NEXT_PUBLIC_FIREBASE_APP_ID: '1:000000000000:web:demo',
    NEXT_PUBLIC_FIREBASE_USE_EMULATOR: '1',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
    // サーバ経路は route で差し替えるので鍵は空のまま (503 not_configured の経路も検査対象)
    GEMINI_API_KEY: '',
};

export default defineConfig({
    testDir: './tests',
    globalSetup: './global-setup.ts',
    // wasm の変換や Storage アップロードを含むので長め。1 本の検査が 3 分を越えたら設計を疑う
    timeout: 180_000,
    expect: { timeout: 15_000 },
    // エミュレータの状態を共有するので直列
    workers: 1,
    fullyParallel: false,
    retries: 0,
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
    outputDir: 'test-results',
    use: {
        baseURL: BASE_URL,
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
        { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' }, testMatch: /smoke\.spec\.ts/ },
    ],
    webServer: [
        {
            command: 'firebase emulators:start --only auth,firestore,storage --project demo-vtd',
            cwd: ROOT,
            url: 'http://127.0.0.1:8080/',
            reuseExistingServer: true,
            timeout: 120_000,
            stdout: 'ignore',
            stderr: 'pipe',
        },
        {
            command: `npm run dev -- -p ${PORT}`,
            cwd: ROOT,
            url: `${BASE_URL}/home`,
            reuseExistingServer: true,
            timeout: 180_000,
            env: emulatorEnv,
            stdout: 'ignore',
            stderr: 'pipe',
        },
    ],
});

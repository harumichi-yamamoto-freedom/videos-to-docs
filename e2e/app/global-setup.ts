import type { FullConfig } from '@playwright/test';
import { ensureFixtures } from './helpers';

/**
 * 1 回だけ: テスト用メディアを用意し、エミュレータが本当にエミュレータであることを確かめる。
 * データの初期化と種まきは各 spec の beforeAll/beforeEach が行う（spec ごとに前提が違う）。
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
    const fixtures = ensureFixtures();
    if (!fixtures.available) {
        console.warn(`[e2e] ${fixtures.reason}。メディアを使う検査は skip になる`);
    }
    const res = await fetch('http://127.0.0.1:8080/').catch(() => null);
    if (!res || !res.ok) {
        throw new Error('Firestore エミュレータ (127.0.0.1:8080) に接続できない。firebase emulators:start が要る');
    }
    const auth = await fetch('http://127.0.0.1:9099/').catch(() => null);
    if (!auth || !auth.ok) {
        throw new Error('Auth エミュレータ (127.0.0.1:9099) に接続できない。firebase.json の emulators.auth を確認');
    }
}

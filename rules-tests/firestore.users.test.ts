/**
 * firestore.rules の `users` 一覧の錠（Firestore エミュレータで実ルールを評価する）。
 *
 * 2026-09-22 レビュー S1: `allow list` が 2 本あり OR で緩い方が実効になっていた。
 * ログイン済みなら誰でも orderBy('email') + limit(1) + startAfter の反復で全ユーザーを列挙できた。
 *
 * 実行: `npm run test:rules`（emulators:exec が Firestore エミュレータを立てて vitest を回す）。
 * エミュレータが 127.0.0.1:8080 に居ないときは skip（CI の通常 `npm test` では回らない）。
 */
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestContext, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDocs, limit, orderBy, query, setDoc, startAfter, where } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 8080;

const emulatorUp = await fetch(`http://${EMULATOR_HOST}:${EMULATOR_PORT}/`).then(r => r.ok).catch(() => false);

describe.skipIf(!emulatorUp)('firestore.rules: users の一覧', () => {
    let env: RulesTestEnvironment;

    beforeAll(async () => {
        env = await initializeTestEnvironment({
            projectId: 'demo-vtd-rules',
            firestore: {
                host: EMULATOR_HOST,
                port: EMULATOR_PORT,
                // RULES_FILE で別のルールを差せる（旧ルールで落ちることを確かめる変異検証用）
                rules: readFileSync(process.env.RULES_FILE ?? resolve(__dirname, '..', 'firestore.rules'), 'utf8'),
            },
        });
    });

    afterAll(async () => {
        await env?.cleanup();
    });

    beforeEach(async () => {
        await env.clearFirestore();
        await env.withSecurityRulesDisabled(async (ctx) => {
            const db = ctx.firestore();
            await setDoc(doc(db, 'users', 'admin-1'), { email: 'admin@example.com', displayName: '管理者', superuser: true });
            await setDoc(doc(db, 'users', 'alice'), { email: 'alice@example.com', displayName: 'Alice', superuser: false });
            await setDoc(doc(db, 'users', 'bob'), { email: 'bob@example.com', displayName: 'Bob', superuser: false });
        });
    });

    const users = (ctx: RulesTestContext) => collection(ctx.firestore(), 'users');

    it('一般ユーザーは email の等値検索 + limit(1) だけ通る（上司追加の検索）', async () => {
        const ctx = env.authenticatedContext('alice');
        const snap = await assertSucceeds(getDocs(query(users(ctx), where('email', '==', 'bob@example.com'), limit(1))));
        expect(snap.docs.map(d => d.id)).toEqual(['bob']);
    });

    it('一般ユーザーは orderBy(email) + limit(1) で列挙できない（S1 の再発防止）', async () => {
        const ctx = env.authenticatedContext('alice');
        await assertFails(getDocs(query(users(ctx), orderBy('email'), limit(1))));
        await assertFails(getDocs(query(users(ctx), orderBy('email'), startAfter('a'), limit(1))));
    });

    it('一般ユーザーは email を固定しても limit を 2 以上にできない', async () => {
        const ctx = env.authenticatedContext('alice');
        await assertFails(getDocs(query(users(ctx), where('email', '==', 'bob@example.com'), limit(2))));
        await assertFails(getDocs(query(users(ctx), where('email', '==', 'bob@example.com'))));
    });

    it('一般ユーザーは email 以外の等値でも列挙できない', async () => {
        const ctx = env.authenticatedContext('alice');
        await assertFails(getDocs(query(users(ctx), where('superuser', '==', false), limit(1))));
    });

    it('未ログインは email を固定しても読めない', async () => {
        const ctx = env.unauthenticatedContext();
        await assertFails(getDocs(query(users(ctx), where('email', '==', 'bob@example.com'), limit(1))));
    });

    it('管理者は全件を列挙できる（管理画面の一覧）', async () => {
        const ctx = env.authenticatedContext('admin-1');
        const snap = await assertSucceeds(getDocs(query(users(ctx), orderBy('email'))));
        expect(snap.size).toBe(3);
    });

    it('他人の email でも等値検索は通る（上司候補の存在確認）', async () => {
        const ctx = env.authenticatedContext('alice');
        await assertSucceeds(getDocs(query(users(ctx), where('email', '==', 'admin@example.com'), limit(1))));
    });
});

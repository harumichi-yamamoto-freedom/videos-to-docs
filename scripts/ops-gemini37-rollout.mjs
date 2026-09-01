/**
 * Gemini 3.7 Flash ロールアウト運用スクリプト
 *
 * 実施内容:
 *   1. prompts コレクションの全プロンプトの model を sentinel 'default' へ一括変更
 *      （アプリ推奨モデルへの自動追従に切替。変更前の値は backup JSONL へ全件記録）
 *   2. systemNotifications へ「Gemini 3.7 Flash が利用可能になりました」のお知らせを作成
 *
 * ⚠️ 本番資格情報保持者のみが実行する。ここでは実行しない。
 *   実行者は `npm i --no-save firebase-admin` 済みの環境で、
 *   GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント鍵を設定して実行する。
 *
 * 使い方:
 *   node scripts/ops-gemini37-rollout.mjs                     # dry-run（何も書き込まない）
 *   node scripts/ops-gemini37-rollout.mjs --apply --project-id <id>   # 実書き込み
 *   追加フラグ: --skip-model-reset / --skip-notification（片方だけ実施する場合）
 *
 * 安全策:
 *   - 既定は dry-run。--apply には --project-id の明示が必須で、資格情報の
 *     プロジェクトと完全一致しなければ拒否する。
 *   - モデル一括変更の前に、全対象の {id, 旧model} を backup JSONL へ書き出す。
 *     戻す場合はこのファイルを使う（各docの model を旧値へ戻すだけ）。
 *   - 既に 'default'（または空）のプロンプトはスキップし、件数を報告する。
 */

import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const SENTINEL = 'default';
const NOTIFICATION = {
    title: 'Gemini 3.7 Flash が利用可能になりました',
    body: [
        '文書生成に使用する Gemini モデルを最新世代へ更新し、新しい推奨モデル「Gemini 3.7 Flash」が利用可能になりました。',
        '',
        'あわせて、モデル選択に「デフォルト（アプリ推奨に自動追従）」が追加されました。既存のプロンプトは自動的に「デフォルト」へ切り替わっており、今後は新しい推奨モデルが登場した際も設定変更なしで自動的に適用されます。',
        '',
        '特定のモデルに固定したい場合は、プロンプト編集画面からいつでも個別のモデルを選び直せます。',
    ].join('\n'),
    severity: 'info',
    publishedBy: '運営チーム',
};

function parseArgs(argv) {
    const known = new Set(['--apply', '--project-id', '--skip-model-reset', '--skip-notification']);
    const args = { apply: false, projectId: null, skipModelReset: false, skipNotification: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!known.has(a)) {
            console.error(`不明な引数: ${a}`);
            console.error('Usage: node scripts/ops-gemini37-rollout.mjs [--apply --project-id <id>] [--skip-model-reset] [--skip-notification]');
            process.exit(1);
        }
        if (a === '--apply') args.apply = true;
        else if (a === '--skip-model-reset') args.skipModelReset = true;
        else if (a === '--skip-notification') args.skipNotification = true;
        else if (a === '--project-id') args.projectId = argv[++i] ?? null;
    }
    if (args.apply && !args.projectId) {
        console.error('--apply には --project-id <id> の明示が必須です。');
        process.exit(1);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);

    let admin;
    try {
        admin = {
            app: await import('firebase-admin/app'),
            firestore: await import('firebase-admin/firestore'),
        };
    } catch {
        console.error('firebase-admin が見つかりません。実行者が `npm i --no-save firebase-admin` で導入してから実行してください。');
        process.exit(1);
    }

    const app = admin.app.initializeApp();
    const db = admin.firestore.getFirestore(app);
    const credentialProject = app.options.projectId
        ?? process.env.GOOGLE_CLOUD_PROJECT
        ?? process.env.GCLOUD_PROJECT
        ?? null;

    console.log(`モード: ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`資格情報プロジェクト: ${credentialProject ?? '(不明)'}`);

    if (args.apply && credentialProject !== args.projectId) {
        console.error(`--project-id (${args.projectId}) と資格情報プロジェクト (${credentialProject}) が一致しません。中止します。`);
        process.exit(1);
    }

    // ---- 1. モデル一括リセット ----
    if (!args.skipModelReset) {
        const snapshot = await db.collection('prompts').select('model', 'name', 'ownerId').get();
        const targets = [];
        const skipped = { alreadyDefault: 0, empty: 0 };
        const byModel = new Map();

        for (const doc of snapshot.docs) {
            const model = doc.get('model');
            const normalized = typeof model === 'string' ? model.trim() : '';
            if (!normalized) { skipped.empty += 1; continue; }
            if (normalized === SENTINEL) { skipped.alreadyDefault += 1; continue; }
            targets.push({ id: doc.id, previousModel: model, name: doc.get('name') ?? '', ownerId: doc.get('ownerId') ?? '' });
            byModel.set(normalized, (byModel.get(normalized) ?? 0) + 1);
        }

        console.log(`\n[モデルリセット] 全${snapshot.size}件中、変更対象 ${targets.length}件 / 既にdefault ${skipped.alreadyDefault}件 / model未設定 ${skipped.empty}件`);
        for (const [model, count] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${model}: ${count}件`);
        }

        if (targets.length > 0) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = `prompts-model-backup-${stamp}.jsonl`;
            await writeFile(backupPath, targets.map(t => JSON.stringify(t)).join('\n') + '\n');
            console.log(`変更前の値を ${backupPath} に記録しました（${targets.length}行）。`);

            if (args.apply) {
                let updated = 0;
                for (let i = 0; i < targets.length; i += 450) {
                    const batch = db.batch();
                    for (const t of targets.slice(i, i + 450)) {
                        batch.update(db.collection('prompts').doc(t.id), { model: SENTINEL });
                    }
                    await batch.commit();
                    updated += Math.min(450, targets.length - i);
                    console.log(`  更新済み: ${updated}/${targets.length}`);
                }
                console.log(`[モデルリセット] 完了。更新件数: ${updated}`);
            } else {
                console.log('[モデルリセット] dry-run のため書き込みなし。');
            }
        }
    }

    // ---- 2. お知らせ作成 ----
    if (!args.skipNotification) {
        console.log(`\n[お知らせ] タイトル: ${NOTIFICATION.title}`);
        console.log(`本文:\n${NOTIFICATION.body}\n`);
        if (args.apply) {
            const ref = await db.collection('systemNotifications').add({
                title: NOTIFICATION.title,
                body: NOTIFICATION.body,
                severity: NOTIFICATION.severity,
                published: true,
                publishedAt: admin.firestore.FieldValue.serverTimestamp(),
                publishedBy: NOTIFICATION.publishedBy,
            });
            console.log(`[お知らせ] 作成完了: ${ref.id}`);
        } else {
            console.log('[お知らせ] dry-run のため作成なし。');
        }
    }
}

main().catch(error => {
    console.error('実行に失敗しました:', error);
    process.exit(1);
});

/**
 * システム通知（systemNotifications コレクション）を投入するスクリプト
 *
 * 使用方法:
 *   npx tsx scripts/create-system-notification.ts \
 *     --title "タイトル" \
 *     --body "本文（\n で改行可）" \
 *     --severity info | critical \
 *     [--publishedBy "system"]
 *
 *   または、本文を標準入力から渡す:
 *   echo "本文" | npx tsx scripts/create-system-notification.ts --title "..." --severity info --bodyStdin
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

interface ParsedArgs {
    title?: string;
    body?: string;
    severity?: 'info' | 'critical';
    publishedBy?: string;
    bodyStdin?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    const out: ParsedArgs = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--title':
                out.title = next; i++; break;
            case '--body':
                out.body = next; i++; break;
            case '--severity':
                if (next !== 'info' && next !== 'critical') {
                    throw new Error(`--severity は info|critical を指定してください（受信: ${next}）`);
                }
                out.severity = next; i++; break;
            case '--publishedBy':
                out.publishedBy = next; i++; break;
            case '--bodyStdin':
                out.bodyStdin = true; break;
        }
    }
    return out;
}

async function readStdin(): Promise<string> {
    return new Promise(resolve => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.title || !args.severity) {
        console.error('使用方法: npx tsx scripts/create-system-notification.ts --title "..." --body "..." --severity info|critical');
        process.exit(1);
    }

    const body = args.bodyStdin ? (await readStdin()).trimEnd() : args.body;
    if (!body) {
        console.error('--body または --bodyStdin で本文を指定してください');
        process.exit(1);
    }

    const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json');
    if (!fs.existsSync(serviceAccountPath)) {
        console.error('serviceAccountKey.json がプロジェクトルートに見つかりません');
        process.exit(1);
    }
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

    const db = admin.firestore();
    const docRef = await db.collection('systemNotifications').add({
        title: args.title,
        body,
        severity: args.severity,
        // ユーザー画面の購読は where('published', '==', true) で絞り込むため、
        // 明示的に true を書き込む必要がある（フィールドが欠落しているとヒットしない）
        published: true,
        publishedAt: admin.firestore.FieldValue.serverTimestamp(),
        publishedBy: args.publishedBy ?? 'system',
    });

    console.log(`通知を作成しました: ${docRef.id}`);
    console.log(`  title: ${args.title}`);
    console.log(`  severity: ${args.severity}`);
}

main().then(() => process.exit(0)).catch(error => {
    console.error('通知の作成に失敗しました:', error);
    process.exit(1);
});

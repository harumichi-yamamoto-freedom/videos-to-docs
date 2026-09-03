/**
 * firestore.rules のチーム閲覧グラント+fail-closed list 設計に対する構造の錠。
 *
 * ここで検査するのはテキスト構造だけで、Rules の実行意味論の代わりにはならない
 * (意味論はエミュレータ実走 scripts/verify-firestore-rules.mjs 側で検証する)。
 *
 * 検査の形: toContain(部分文字列の存在)では「&& を || に倒す」「式の末尾に
 * || true を継ぎ足す」型の変異が全緑になるため、
 *  - allow 式は【正規化した全文の完全一致】
 *  - セキュリティ関数の本体は【トップレベル結合子の種別+項集合の完全一致】
 * で錠にする。式を1文字でも変えたらこの錠の更新が必要になるのは意図した摩擦
 * (セキュリティ式の変更は必ずレビューを通る)。
 * コメントは検査前に剥がす(解説コメントが錠を満たす偽緑の防止)。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const rulesPath = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const rawRules = readFileSync(rulesPath, 'utf8');

/** 行コメントを除去する。 */
function stripComments(source: string): string {
    return source
        .split('\n')
        .map((line) => {
            const commentStart = line.indexOf('//');
            return commentStart >= 0 ? line.slice(0, commentStart) : line;
        })
        .join('\n');
}

function normalize(source: string): string {
    return source.replace(/\s+/g, ' ').trim();
}

const rules = stripComments(rawRules);

/** `match /<name>/{...} {` から対応する閉じ括弧までを取り出す(ネスト対応)。 */
function extractMatchBlock(collectionName: string): string {
    const marker = `match /${collectionName}/`;
    const start = rules.indexOf(marker);
    expect(start, `match ブロックが見つかりません: ${collectionName}`).toBeGreaterThanOrEqual(0);
    const braceStart = rules.indexOf('{', rules.indexOf('{', start) + 1);
    let depth = 1;
    let index = braceStart + 1;
    while (index < rules.length && depth > 0) {
        if (rules[index] === '{') depth += 1;
        if (rules[index] === '}') depth -= 1;
        index += 1;
    }
    return rules.slice(braceStart + 1, index - 1);
}

/** ブロック内の allow 文を op ごとの正規化済み式へ展開する(`allow get, list: if ...;`)。 */
function extractAllowExpressions(block: string): Record<string, string> {
    const expressions: Record<string, string> = {};
    const allowPattern = /allow\s+([a-z,\s]+?):\s*if([\s\S]*?);/g;
    for (const match of block.matchAll(allowPattern)) {
        const ops = match[1].split(',').map((op) => op.trim());
        const expression = normalize(match[2]);
        for (const op of ops) {
            expect(expressions[op], `allow ${op} が複数回定義されている`).toBeUndefined();
            expressions[op] = expression;
        }
    }
    return expressions;
}

/** 書込み系(create/update/delete/write)の allow 式だけを取り出す。読取系の重複定義は無視する。 */
function extractWriteAllowExpressions(block: string): Record<string, string> {
    const expressions: Record<string, string> = {};
    const allowPattern = /allow\s+([a-z,\s]+?):\s*if([\s\S]*?);/g;
    for (const match of block.matchAll(allowPattern)) {
        const ops = match[1].split(',').map((op) => op.trim());
        const expression = normalize(match[2]);
        for (const op of ops) {
            if (!['create', 'update', 'delete', 'write'].includes(op)) continue;
            expect(expressions[op], `allow ${op} が複数回定義されている`).toBeUndefined();
            expressions[op] = expression;
        }
    }
    return expressions;
}

/** `function <name>(...)` の return 式(正規化済み)を取り出す。let 束縛は読み飛ばす。 */
function extractReturnExpression(name: string): string {
    const start = rules.indexOf(`function ${name}`);
    expect(start, `関数が見つかりません: ${name}`).toBeGreaterThanOrEqual(0);
    const bodyEnd = rules.indexOf('}', start);
    const body = rules.slice(start, bodyEnd);
    const returnStart = body.indexOf('return');
    expect(returnStart, `return が見つかりません: ${name}`).toBeGreaterThanOrEqual(0);
    const afterReturn = body.slice(returnStart + 'return'.length);
    const semicolon = afterReturn.indexOf(';');
    expect(semicolon, `return 文の終端が見つかりません: ${name}`).toBeGreaterThanOrEqual(0);
    return normalize(afterReturn.slice(0, semicolon));
}

/** 括弧・文字列リテラルを尊重してトップレベルの結合子で分割する。 */
function topLevelSplit(expression: string, operator: '&&' | '||'): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = '';
    for (let i = 0; i < expression.length; i += 1) {
        const ch = expression[i];
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '(' || ch === '[') depth += 1;
        if (ch === ')' || ch === ']') depth -= 1;
        if (depth === 0 && ch === operator[0] && expression[i + 1] === operator[1]) {
            parts.push(current.trim());
            current = '';
            i += 1;
            continue;
        }
        current += ch;
    }
    parts.push(current.trim());
    return parts;
}

/** 全体を1個の括弧が包んでいれば剥がす(トップレベル判定のため)。 */
function stripOuterParens(expression: string): string {
    let result = expression.trim();
    while (result.startsWith('(') && result.endsWith(')')) {
        let depth = 0;
        let wraps = true;
        for (let i = 0; i < result.length; i += 1) {
            if (result[i] === '(') depth += 1;
            if (result[i] === ')') depth -= 1;
            if (depth === 0 && i < result.length - 1) {
                wraps = false;
                break;
            }
        }
        if (!wraps) break;
        result = result.slice(1, -1).trim();
    }
    return result;
}

/** 「トップレベルが operator で、項集合が expected と完全一致」を検査する。 */
function expectJunction(expression: string, operator: '&&' | '||', expected: string[]): void {
    const otherOperator = operator === '&&' ? '||' : '&&';
    // トップレベルに逆の結合子が混ざっていないこと(&&→|| 変異・|| 継ぎ足しの検出)
    expect(topLevelSplit(expression, otherOperator), `トップレベルに ${otherOperator} が混入: ${expression}`).toHaveLength(1);
    expect(topLevelSplit(expression, operator).sort()).toEqual([...expected].sort());
}

// ============================================================
// allow 式の完全一致(prompts / transcriptions / relationships / systemNotifications / auditLogs)
// ============================================================

describe('firestore.rules: allow 式の完全一致', () => {
    const prompts = extractAllowExpressions(extractMatchBlock('prompts'));
    const transcriptions = extractAllowExpressions(extractMatchBlock('transcriptions'));
    const relationships = extractAllowExpressions(extractMatchBlock('relationships'));
    const notifications = extractAllowExpressions(extractMatchBlock('systemNotifications'));
    const auditLogs = extractAllowExpressions(extractMatchBlock('auditLogs'));
    // users は `allow list` を 2 本持つ(管理者の全件 / 上司追加のメール検索 limit<=1)ため、
    // 重複を拒む extractAllowExpressions は使わず、昇格に関わる書込み系だけを取り出す。
    const users = extractWriteAllowExpressions(extractMatchBlock('users'));

    it('prompts: get は 存在確認/所有者/承認済み上司、list は canListExisting() のみ', () => {
        expect(prompts.get).toBe(
            '!exists(/databases/$(database)/documents/prompts/$(promptId)) || canAccessExisting() || canReadAsSupervisor()',
        );
        expect(prompts.list).toBe('canListExisting()');
    });

    it('prompts: 書込み系は所有者(変異はフォールバック無し)+管理者のゲスト既定物のみ', () => {
        expect(prompts.create).toBe(
            'isGuestCreate() || isUserCreate() || (isSuperuser() && request.resource.data.ownerType == "guest" && request.resource.data.ownerId == "GUEST" && request.resource.data.isDefault == true)',
        );
        expect(prompts.update).toBe(
            '(canMutateExisting() && ownershipUnchanged() && !(resource.data.keys().hasAll([\'ownerType\', \'isDefault\']) && resource.data.ownerType == "guest" && resource.data.isDefault == true)) || (isSuperuser() && resource.data.keys().hasAll([\'ownerType\', \'isDefault\']) && resource.data.ownerType == "guest" && resource.data.isDefault == true && ownershipUnchanged())',
        );
        expect(prompts.delete).toBe(
            '(canMutateExisting() && !(resource.data.keys().hasAll([\'ownerType\', \'isDefault\']) && resource.data.ownerType == "guest" && resource.data.isDefault == true)) || (isSuperuser() && resource.data.keys().hasAll([\'ownerType\', \'isDefault\']) && resource.data.ownerType == "guest" && resource.data.isDefault == true)',
        );
    });

    it('transcriptions: get/list の読取と、上司分岐を含まない書込み系', () => {
        expect(transcriptions.get).toBe('canAccessExisting() || canReadAsSupervisor()');
        expect(transcriptions.list).toBe('canListExisting()');
        expect(transcriptions.create).toBe('isGuestCreate() || isUserCreate()');
        expect(transcriptions.update).toBe('canMutateExisting() && ownershipUnchanged()');
        expect(transcriptions.delete).toBe('canMutateExisting()');
    });

    it('relationships: get/delete は当事者、list はクエリ固定型 participant', () => {
        expect(relationships.get).toBe('isRelationshipParticipant()');
        expect(relationships.delete).toBe('isRelationshipParticipant()');
        expect(relationships.list).toBe('queryPinsRelationshipParticipant()');
    });

    it('relationships: 作成は部下本人・pending固定・正規ID・自己指名禁止の && 連鎖', () => {
        expectJunction(relationships.create, '&&', [
            'isSignedIn()',
            'request.resource.data.subordinateId == request.auth.uid',
            'request.resource.data.supervisorId is string',
            'request.resource.data.supervisorId != request.auth.uid',
            'request.resource.data.status == "pending"',
            'isCanonicalId()',
        ]);
    });

    it('relationships: 承認は指名上司・pending→approved 一方向・キー凍結・正規ID の && 連鎖', () => {
        expectJunction(relationships.update, '&&', [
            'isSignedIn()',
            'resource.data.supervisorId == request.auth.uid',
            'resource.data.status == "pending"',
            'request.resource.data.status == "approved"',
            "request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'updatedAt'])",
            'isCanonicalId()',
        ]);
    });

    it('systemNotifications: get は後方互換フォールバック付き、list は published ピン留めか管理者のみ', () => {
        expect(notifications.get).toBe(
            "isSuperuser() || !('published' in resource.data) || resource.data.published == true",
        );
        expect(notifications.list).toBe(
            "isSuperuser() || (resource.data.keys().hasAll(['published']) && resource.data.published == true)",
        );
    });

    it('auditLogs: 作成は「本人 uid」か「未ログインの GUEST」のみ(if true の全開放は不可)、読取は管理者のみ、更新・削除の許可文は無い', () => {
        // S2-3: 旧ルール `allow create: if true` は未ログインでも他人の uid を名乗る偽ログを書けた。
        expect(auditLogs.create).toBe(
            "(isSignedIn() && request.resource.data.userId == request.auth.uid) || (!isSignedIn() && request.resource.data.userId == 'GUEST')",
        );
        expect(auditLogs.read).toBe('isSuperuser()');
        // 監査ログの不変性: create / read 以外の allow 文(update / delete / write)が増えたら錠を落とす。
        expect(Object.keys(auditLogs).sort()).toEqual(['create', 'read']);
    });

    it('users: create は本人かつ superuser が「無い」か false のみ(delete→create の作り直しで昇格できない)、update は superuser 不変', () => {
        // S1-1 (#3): 旧ルールは create/delete に superuser の制約が無く、任意の登録ユーザーが自分の doc を
        // superuser:true で作る(または削除して作り直す)だけで管理者になれた。エミュレータ実証 2026-09-03。
        expect(users.create).toBe(
            "request.auth != null && request.auth.uid == userId && (!('superuser' in request.resource.data) || request.resource.data.superuser == false)",
        );
        expect(users.update).toBe(
            "request.auth != null && request.auth.uid == userId && (!request.resource.data.keys().hasAll(['superuser']) || resource.data.superuser == request.resource.data.superuser)",
        );
        expect(users.delete).toBe('request.auth != null && request.auth.uid == userId');
        // 昇格経路は create / update の 2 本だけ: 他の書込み許可文(write / set 等)が増えたら錠を落とす。
        expect(Object.keys(users).sort()).toEqual(['create', 'delete', 'update']);
    });
});

// ============================================================
// セキュリティ関数の論理構造(結合子の種別+項集合)
// ============================================================

describe('firestore.rules: セキュリティ関数の論理構造', () => {
    it('isApprovedSupervisorOf は5条件の && 連鎖(本文3点照合を || で迂回できない)', () => {
        expectJunction(extractReturnExpression('isApprovedSupervisorOf'), '&&', [
            'isSignedIn()',
            'exists(relPath)',
            'get(relPath).data.status == "approved"',
            'get(relPath).data.supervisorId == request.auth.uid',
            'get(relPath).data.subordinateId == ownerId',
        ]);
    });

    it('isApprovedSupervisorOf のパスは複合キーで組み立てる', () => {
        const start = rules.indexOf('function isApprovedSupervisorOf');
        const body = normalize(rules.slice(start, rules.indexOf('}', start)));
        expect(body).toContain(
            "let relPath = /databases/$(database)/documents/relationships/$(request.auth.uid + '_' + ownerId);",
        );
    });

    it('canListExisting は queryPins 3種 + isSuperuser の || 合成', () => {
        expectJunction(extractReturnExpression('canListExisting'), '||', [
            'queryPinsGuestShared()',
            'queryPinsOwner()',
            'queryPinsSupervisedOwner()',
            'isSuperuser()',
        ]);
    });

    it('queryPinsGuestShared / queryPinsOwner / queryPinsSupervisedOwner は hasAll ガード付き && 連鎖', () => {
        expectJunction(extractReturnExpression('queryPinsGuestShared'), '&&', [
            "resource.data.keys().hasAll(['ownerType'])",
            'resource.data.ownerType == "guest"',
        ]);
        expectJunction(extractReturnExpression('queryPinsOwner'), '&&', [
            'isSignedIn()',
            "resource.data.keys().hasAll(['ownerId'])",
            'resource.data.ownerId == request.auth.uid',
        ]);
        expectJunction(extractReturnExpression('queryPinsSupervisedOwner'), '&&', [
            'isSignedIn()',
            "resource.data.keys().hasAll(['ownerId'])",
            'isApprovedSupervisorOf(resource.data.ownerId)',
        ]);
    });

    it('queryPinsRelationshipParticipant は isSignedIn && (両側 hasAll ガード付きの ||)', () => {
        const conjuncts = topLevelSplit(extractReturnExpression('queryPinsRelationshipParticipant'), '&&');
        expect(conjuncts).toHaveLength(2);
        expect(conjuncts[0]).toBe('isSignedIn()');
        const disjuncts = topLevelSplit(stripOuterParens(conjuncts[1]), '||');
        expect(disjuncts).toHaveLength(2);
        expectJunction(stripOuterParens(disjuncts[0]), '&&', [
            "resource.data.keys().hasAll(['supervisorId'])",
            'resource.data.supervisorId == request.auth.uid',
        ]);
        expectJunction(stripOuterParens(disjuncts[1]), '&&', [
            "resource.data.keys().hasAll(['subordinateId'])",
            'resource.data.subordinateId == request.auth.uid',
        ]);
    });

    it('canMutateExisting は所有フィールド実在 && (ゲスト or 本人) — 欠落フォールバック無し', () => {
        const conjuncts = topLevelSplit(extractReturnExpression('canMutateExisting'), '&&');
        expect(conjuncts).toHaveLength(2);
        expect(conjuncts[0]).toBe("resource.data.keys().hasAll(['ownerType', 'ownerId'])");
        const disjuncts = topLevelSplit(stripOuterParens(conjuncts[1]), '||');
        expect(disjuncts).toHaveLength(2);
        expect(disjuncts[0]).toBe('resource.data.ownerType == "guest"');
        expectJunction(stripOuterParens(disjuncts[1]), '&&', [
            'isSignedIn()',
            'resource.data.ownerType == "user"',
            'resource.data.ownerId == request.auth.uid',
        ]);
        const body = extractReturnExpression('canMutateExisting');
        expect(body).not.toContain('docOwnerType');
        expect(body).not.toContain('docOwnerId');
    });

    it('canReadAsSupervisor は isSignedIn && isApprovedSupervisorOf(docOwnerId())', () => {
        expectJunction(extractReturnExpression('canReadAsSupervisor'), '&&', [
            'isSignedIn()',
            'isApprovedSupervisorOf(docOwnerId())',
        ]);
    });

    it('relationships の isCanonicalId は supervisorId_subordinateId の合成', () => {
        expect(extractReturnExpression('isCanonicalId')).toBe(
            "relationshipId == request.resource.data.supervisorId + '_' + request.resource.data.subordinateId",
        );
    });
});

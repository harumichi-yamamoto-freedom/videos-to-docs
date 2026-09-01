/**
 * Legacy `text` を canonical `transcription` へ安全に移行する二段階CLI。
 * このリポジトリでは実行しない。本番資格情報保持者がバックアップ取得後に実行する。
 *
 * `firebase-admin` は意図的に静的依存しない。実行環境にない場合だけ、実行者が
 * `npm i --no-save firebase-admin` で一時導入してから再実行すること（package*.jsonは変更しない）。
 *
 * 1. DRY-RUN でID順に走査し、レビュー用JSONL planとSHA-256を作る（書込みなし）。
 * 2. APPLY は同じplan、SHA-256、project/database/emulator、期待件数、確認値を必須とする。
 *
 * 使用例は `node scripts/migrate-text-to-transcription.mjs --help` を参照。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
    link,
    mkdir,
    open,
    readFile,
    unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import {
    DEFAULT_LIMITS,
    DEFAULT_PAGE_SIZE,
    PLAN_FORMAT,
    applyPlanRecords,
    buildApplyConfirmation,
    compareDocumentIds,
    countUnprocessed,
    generateMigrationPlan,
    normalizeEnvironment,
    serializeUpdateTime,
    validateApplyBinding,
    validateCredentialProjectId,
} from './migrate-text-to-transcription-core.mjs';

const SERVICE_ACCOUNT_FILE = 'serviceAccountKey.json';
const DOCUMENT_STATUSES = new Set(['planned', 'conflict', 'invalid', 'oversized']);
// Node's buffer.constants.MAX_STRING_LENGTH is approximately 512 MiB - 24 B,
// so stay well below the single-chunk UTF-8 decode boundary. A reviewed plan
// contains metadata only, for which 256 MiB is already ample.
export const MAX_REVIEWED_PLAN_BYTES = 256 * 1024 * 1024;

function printUsage() {
    console.log(`Usage:
  DRY-RUN:
    node scripts/migrate-text-to-transcription.mjs \\
      --project-id <exact-project-id> --database-id <database-id> \\
      --plan-file <new-plan.jsonl>

  APPLY (DRY-RUN出力の値をそのまま指定):
    node scripts/migrate-text-to-transcription.mjs --apply \\
      --project-id <exact-project-id> --database-id <database-id> \\
      --plan-file <reviewed-plan.jsonl> --plan-sha256 <sha256> \\
      --expected-count <planned-count> --confirm <exact-confirmation-value>

Notes:
  - FIRESTORE_EMULATOR_HOST の値（未設定ならproduction）もplanに束縛されます。
  - plan-file は既存ファイルを上書きしません。
  - canonical/legacy不一致、非文字列、巨大文書は隔離され、終了コードは非0です。
  - firebase-admin がなければ npm i --no-save firebase-admin で一時導入してください。`);
}

export function parseArguments(args) {
    const options = {
        apply: false,
        help: false,
        projectId: null,
        databaseId: null,
        planFile: null,
        planSha256: null,
        expectedCount: null,
        confirmation: null,
    };
    const valueFlags = new Map([
        ['--project-id', 'projectId'],
        ['--database-id', 'databaseId'],
        ['--plan-file', 'planFile'],
        ['--plan-sha256', 'planSha256'],
        ['--expected-count', 'expectedCount'],
        ['--confirm', 'confirmation'],
    ]);
    const seen = new Set();

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--apply' || argument === '--help') {
            if (seen.has(argument)) {
                throw new Error(`${argument} は1回だけ指定してください`);
            }
            seen.add(argument);
            options[argument === '--apply' ? 'apply' : 'help'] = true;
            continue;
        }

        const key = valueFlags.get(argument);
        if (!key) {
            throw new Error(`未対応の引数です: ${argument}`);
        }
        if (seen.has(argument)) {
            throw new Error(`${argument} は1回だけ指定してください`);
        }
        const value = args[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`${argument} の値がありません`);
        }
        seen.add(argument);
        options[key] = value;
        index += 1;
    }

    if (options.help) {
        return options;
    }
    for (const [flag, key] of [
        ['--project-id', 'projectId'],
        ['--database-id', 'databaseId'],
        ['--plan-file', 'planFile'],
    ]) {
        if (!options[key]) {
            throw new Error(`${flag} は必須です`);
        }
    }
    if (options.apply) {
        for (const [flag, key] of [
            ['--plan-sha256', 'planSha256'],
            ['--expected-count', 'expectedCount'],
            ['--confirm', 'confirmation'],
        ]) {
            if (!options[key]) {
                throw new Error(`APPLYでは ${flag} が必須です`);
            }
        }
        if (!/^\d+$/.test(options.expectedCount)) {
            throw new Error('--expected-count は0以上の整数で指定してください');
        }
        options.expectedCount = Number(options.expectedCount);
        if (!Number.isSafeInteger(options.expectedCount)) {
            throw new Error('--expected-count が大きすぎます');
        }
    } else if (options.planSha256 || options.expectedCount || options.confirmation) {
        throw new Error('--plan-sha256/--expected-count/--confirm は --apply と同時にだけ指定できます');
    }

    return options;
}

export function runtimeEnvironment(projectId, databaseId, env = process.env) {
    return normalizeEnvironment({
        projectId,
        databaseId,
        emulatorHost: env.FIRESTORE_EMULATOR_HOST || null,
    });
}

function machineLogger({ executionId, mode, environment }) {
    return event => {
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            executionId,
            mode,
            environment,
            ...event,
        }));
    };
}

export class JsonlPlanWriter {
    constructor(planPath, partialPath, handle, hash) {
        this.planPath = planPath;
        this.partialPath = partialPath;
        this.handle = handle;
        this.hash = hash;
        this.closed = false;
    }

    static async create(planFile, executionId) {
        const planPath = path.resolve(process.cwd(), planFile);
        await mkdir(path.dirname(planPath), { recursive: true });
        const partialPath = `${planPath}.${executionId}.partial`;
        const handle = await open(partialPath, 'wx', 0o600);
        return new JsonlPlanWriter(planPath, partialPath, handle, createHash('sha256'));
    }

    async write(value) {
        if (this.closed) {
            throw new Error('plan writer は既に閉じています');
        }
        const line = `${JSON.stringify(value)}\n`;
        this.hash.update(line);
        await this.handle.write(line);
    }

    async finish() {
        if (this.closed) {
            throw new Error('plan writer は既に閉じています');
        }
        this.closed = true;
        const digest = this.hash.digest('hex');
        await this.handle.sync();
        await this.handle.close();
        try {
            // The partial file is in the destination directory, so hard-linking
            // publishes it atomically and fails safely with EEXIST (no overwrite).
            await link(this.partialPath, this.planPath);
        } finally {
            await unlink(this.partialPath).catch(() => {});
        }
        return digest;
    }

    async abort() {
        if (!this.closed) {
            this.closed = true;
            await this.handle.close().catch(() => {});
        }
        await unlink(this.partialPath).catch(() => {});
    }
}

export async function loadServiceAccount(requestedProjectId, {
    serviceAccountPath = path.resolve(process.cwd(), SERVICE_ACCOUNT_FILE),
    readText = readFile,
} = {}) {
    let raw;
    try {
        raw = await readText(serviceAccountPath, 'utf8');
    } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
            throw new Error(`${SERVICE_ACCOUNT_FILE} がプロジェクトルートに見つかりません`, { cause: error });
        }
        throw error;
    }

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${SERVICE_ACCOUNT_FILE} が有効なJSONではありません`, { cause: error });
    }
    validateCredentialProjectId(serviceAccount.project_id, requestedProjectId);
    return serviceAccount;
}

export async function loadFirebaseAdmin(importModule = specifier => import(specifier)) {
    try {
        const [appModule, firestoreModule] = await Promise.all([
            importModule('firebase-admin/app'),
            importModule('firebase-admin/firestore'),
        ]);
        return { ...appModule, ...firestoreModule };
    } catch (error) {
        const missing = error && typeof error === 'object'
            && error.code === 'ERR_MODULE_NOT_FOUND'
            && String(error.message).includes('firebase-admin');
        if (missing) {
            throw new Error(
                'firebase-admin がありません。実行者が `npm i --no-save firebase-admin` で一時導入してから再実行してください（package*.jsonは変更しないでください）。',
                { cause: error },
            );
        }
        throw error;
    }
}

export async function initializeFirestore({ environment, executionId, serviceAccount, admin }) {
    const app = admin.initializeApp(
        {
            credential: admin.cert(serviceAccount),
            projectId: environment.projectId,
        },
        `migrate-text-to-transcription-${executionId}`,
    );
    try {
        const db = admin.getFirestore(app, environment.databaseId);
        if (app.options?.projectId !== environment.projectId) {
            throw new Error(
                `初期化後のFirebase project (${app.options?.projectId ?? 'unknown'}) が期待値 (${environment.projectId}) と一致しません`,
            );
        }
        if (db.databaseId !== environment.databaseId) {
            throw new Error(
                `初期化後のFirestore database (${db.databaseId ?? 'unknown'}) が期待値 (${environment.databaseId}) と一致しません`,
            );
        }
        return { app, db };
    } catch (error) {
        await admin.deleteApp(app).catch(() => {});
        throw error;
    }
}

export async function* firestorePages(collection, FieldPath, pageSize) {
    let lastId = null;
    while (true) {
        let query = collection
            .select('text', 'transcription')
            .orderBy(FieldPath.documentId())
            .limit(pageSize);
        if (lastId !== null) {
            query = query.startAfter(lastId);
        }
        const snapshot = await query.get();
        if (snapshot.docs.length === 0) {
            return;
        }
        yield snapshot.docs;
        lastId = snapshot.docs.at(-1).id;
        if (snapshot.docs.length < pageSize) {
            return;
        }
    }
}

function validateRecordShape(record) {
    if (!record || record.kind !== 'document' || !DOCUMENT_STATUSES.has(record.status)) {
        throw new Error('plan document record が不正です');
    }
    if (
        typeof record.id !== 'string'
        || record.id.length === 0
        || record.id.includes('/')
        || record.id === '.'
        || record.id === '..'
        || /^__.*__$/.test(record.id)
        || Buffer.byteLength(record.id, 'utf8') > 1500
    ) {
        throw new Error('plan document ID がtranscriptions直下のFirestore IDとして不正です');
    }
    if (typeof record.reason !== 'string') {
        throw new Error(`plan reason が不正です: ${record.id}`);
    }
    if (record.updateTime) {
        serializeUpdateTime(record.updateTime);
    }
    if (record.status === 'planned') {
        if (
            record.operation !== 'set_transcription_and_delete_text'
            || !/^[a-f0-9]{64}$/.test(record.bodySha256)
            || !Number.isSafeInteger(record.bodyBytes)
            || record.bodyBytes < 0
            || !Number.isSafeInteger(record.estimatedWriteBytes)
            || record.estimatedWriteBytes <= 0
            || record.estimatedWriteBytes > DEFAULT_LIMITS.maxBatchBytes
            || !record.updateTime
        ) {
            throw new Error(`planned record が不正です: ${record.id}`);
        }
    }
}

function assertPlanBuffer(planBuffer) {
    if (!Buffer.isBuffer(planBuffer)) {
        throw new TypeError('reviewed plan snapshot はBufferでなければなりません');
    }
    return planBuffer;
}

async function* jsonlValues(planBuffer) {
    // During APPLY, inspection and record enumeration decode the exact same
    // private in-memory bytes. No phase reopens or consults a filesystem path.
    const input = Readable.from([assertPlanBuffer(planBuffer)], { objectMode: false });
    input.setEncoding('utf8');
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
        lineNumber += 1;
        if (line.length === 0) {
            throw new Error(`plan ${lineNumber}行目が空です`);
        }
        try {
            yield JSON.parse(line);
        } catch (error) {
            throw new Error(`plan ${lineNumber}行目がJSONではありません`, { cause: error });
        }
    }
}

export async function inspectPlanFile(planBuffer) {
    let header = null;
    let summary = null;
    let previousId = null;
    const recordCounts = { planned: 0, conflict: 0, invalid: 0, oversized: 0 };

    for await (const value of jsonlValues(planBuffer)) {
        if (header === null) {
            if (value.kind !== 'header' || value.format !== PLAN_FORMAT) {
                throw new Error('planの先頭が有効なheaderではありません');
            }
            normalizeEnvironment(value.environment);
            if (
                typeof value.executionId !== 'string'
                || value.executionId.length === 0
                || typeof value.createdAt !== 'string'
                || Number.isNaN(Date.parse(value.createdAt))
                || value.collection !== 'transcriptions'
                || value.ordering !== '__name__ ASC'
                || value.pageSize !== DEFAULT_PAGE_SIZE
                || value.limits?.maxBatchOperations !== DEFAULT_LIMITS.maxBatchOperations
                || value.limits?.maxBatchBytes !== DEFAULT_LIMITS.maxBatchBytes
                || value.limits?.maxSingleWriteBytes !== DEFAULT_LIMITS.maxSingleWriteBytes
            ) {
                throw new Error('plan header のcollection/order/pageSize/limitsがruntimeと一致しません');
            }
            header = value;
            continue;
        }
        if (value.kind === 'summary') {
            if (summary !== null) {
                throw new Error('plan summary が複数あります');
            }
            summary = value;
            continue;
        }
        if (summary !== null) {
            throw new Error('plan summary より後にレコードがあります');
        }

        validateRecordShape(value);
        if (previousId !== null && compareDocumentIds(previousId, value.id) >= 0) {
            throw new Error(`planの文書ID順序が不正です: ${value.id}`);
        }
        previousId = value.id;
        recordCounts[value.status] += 1;
    }

    if (!header || !summary || summary.executionId !== header.executionId) {
        throw new Error('plan header/summary が欠落または不整合です');
    }
    for (const status of ['scanned', 'skipped', 'planned', 'conflict', 'invalid', 'oversized']) {
        if (!Number.isSafeInteger(summary.counts?.[status]) || summary.counts[status] < 0) {
            throw new Error(`plan summary の ${status} 件数が不正です`);
        }
    }
    for (const [status, count] of Object.entries(recordCounts)) {
        if (summary.counts?.[status] !== count) {
            throw new Error(`plan summary の ${status} 件数がレコードと一致しません`);
        }
    }
    if (
        !Number.isSafeInteger(summary.counts?.skipped)
        || summary.counts.skipped < 0
        || summary.counts.scanned !== summary.counts.skipped + Object.values(recordCounts).reduce((a, b) => a + b, 0)
    ) {
        throw new Error('plan summary の scanned/skipped 件数が不正です');
    }
    const shouldBeComplete = recordCounts.conflict === 0
        && recordCounts.invalid === 0
        && recordCounts.oversized === 0;
    if (summary.complete !== shouldBeComplete) {
        throw new Error('plan summary の complete が件数と一致しません');
    }
    return { header, summary };
}

export async function* planDocumentRecords(planBuffer) {
    for await (const value of jsonlValues(planBuffer)) {
        if (value.kind === 'document') {
            // During APPLY, the same private Buffer was fully inspected first.
            yield value;
        }
    }
}

export async function snapshotReviewedPlan(planFile, {
    maxBytes = MAX_REVIEWED_PLAN_BYTES,
    openFile = open,
} = {}) {
    const planPath = path.resolve(process.cwd(), planFile);
    const sourceHandle = await openFile(planPath, 'r');
    try {
        const sourceStat = await sourceHandle.stat({ bigint: true });
        if (!sourceStat.isFile()) {
            throw new Error('reviewed plan が通常ファイルではありません');
        }
        if (sourceStat.size > BigInt(maxBytes)) {
            throw new Error(
                `reviewed plan が上限 ${maxBytes} bytes を超えています: ${sourceStat.size} bytes`,
            );
        }

        // Allocate exactly the bounded, observed size and read every source byte
        // once. A one-byte EOF probe rejects growth during the snapshot instead
        // of allowing an unbounded read after the size check.
        const planBuffer = Buffer.allocUnsafe(Number(sourceStat.size));
        let offset = 0;
        while (offset < planBuffer.length) {
            const { bytesRead } = await sourceHandle.read(
                planBuffer,
                offset,
                planBuffer.length - offset,
                offset,
            );
            if (bytesRead === 0) {
                throw new Error('reviewed plan のサイズがsnapshot中に変更されました');
            }
            offset += bytesRead;
        }
        const overflowProbe = Buffer.allocUnsafe(1);
        const { bytesRead: overflowBytes } = await sourceHandle.read(overflowProbe, 0, 1, offset);
        if (overflowBytes !== 0) {
            throw new Error('reviewed plan のサイズがsnapshot中に変更されました');
        }

        // Hashing uses these snapshotted bytes; runApply checks the Buffer and
        // makes its own private copy before inspection or enumeration.
        const digest = createHash('sha256').update(planBuffer).digest('hex');
        return { planBuffer, digest };
    } finally {
        await sourceHandle.close();
    }
}

async function runDryRun({ options, environment, executionId }) {
    const log = machineLogger({ executionId, mode: 'DRY-RUN', environment });
    const serviceAccount = await loadServiceAccount(environment.projectId);
    const admin = await loadFirebaseAdmin();
    const { app, db } = await initializeFirestore({ environment, executionId, serviceAccount, admin });
    let writer;
    try {
        writer = await JsonlPlanWriter.create(options.planFile, executionId);
        log({
            phase: 'environment',
            status: 'verified',
            credentialProjectId: serviceAccount.project_id,
            planFile: path.resolve(process.cwd(), options.planFile),
        });
        const collection = db.collection('transcriptions');
        const { summary } = await generateMigrationPlan({
            pages: firestorePages(collection, admin.FieldPath, DEFAULT_PAGE_SIZE),
            writer,
            executionId,
            createdAt: new Date().toISOString(),
            environment,
            pageSize: DEFAULT_PAGE_SIZE,
            limits: DEFAULT_LIMITS,
            log,
        });
        const planSha256 = await writer.finish();
        const confirmation = buildApplyConfirmation({
            environment,
            executionId,
            planSha256,
            plannedCount: summary.counts.planned,
        });
        log({
            phase: 'summary',
            status: summary.complete ? 'planned' : 'incomplete',
            counts: summary.counts,
            planFile: path.resolve(process.cwd(), options.planFile),
            planSha256,
            requiredExpectedCount: summary.counts.planned,
            requiredConfirmation: confirmation,
            writesAttempted: 0,
        });
        return summary.complete ? 0 : 2;
    } catch (error) {
        if (writer) {
            await writer.abort();
        }
        throw error;
    } finally {
        await admin.deleteApp(app);
    }
}

export async function runApply({ options, environment, executionId }, overrides = {}) {
    const runtime = {
        applyPlanRecords,
        countUnprocessed,
        initializeFirestore,
        inspectPlanFile,
        loadFirebaseAdmin,
        loadServiceAccount,
        machineLogger,
        planDocumentRecords,
        snapshotReviewedPlan,
        validateApplyBinding,
        ...overrides,
    };
    const log = runtime.machineLogger({ executionId, mode: 'APPLY', environment });
    const reviewedPlan = await runtime.snapshotReviewedPlan(options.planFile);
    // Buffer inspection plus this private copy makes the post-snapshot contents
    // used by APPLY immutable from external mutation, including exotic objects.
    const reviewedPlanBuffer = Buffer.from(assertPlanBuffer(reviewedPlan.planBuffer));
    const { header, summary } = await runtime.inspectPlanFile(reviewedPlanBuffer);
    runtime.validateApplyBinding({
        header,
        summary,
        actualEnvironment: environment,
        actualPlanSha256: reviewedPlan.digest,
        suppliedPlanSha256: options.planSha256,
        expectedCount: options.expectedCount,
        confirmation: options.confirmation,
    });

    const serviceAccount = await runtime.loadServiceAccount(environment.projectId);
    const admin = await runtime.loadFirebaseAdmin();
    const { app, db } = await runtime.initializeFirestore({
        environment,
        executionId,
        serviceAccount,
        admin,
    });
    try {
        log({
            phase: 'environment',
            status: 'verified',
            credentialProjectId: serviceAccount.project_id,
            reviewedPlanExecutionId: header.executionId,
            planFile: path.resolve(process.cwd(), options.planFile),
            planSha256: reviewedPlan.digest,
            expectedCount: options.expectedCount,
        });
        const counts = await runtime.applyPlanRecords({
            records: runtime.planDocumentRecords(reviewedPlanBuffer),
            db,
            collection: db.collection('transcriptions'),
            deleteFieldValue: admin.FieldValue.delete(),
            limits: DEFAULT_LIMITS,
            log,
        });
        const unprocessed = runtime.countUnprocessed(counts);
        const nonNegativeSafeInteger = value => Number.isSafeInteger(value) && value >= 0;
        const terminalCountsAreValid = [counts.applied, counts.conflict, counts.failed]
            .every(nonNegativeSafeInteger);
        const terminalCountCandidate = counts.applied + counts.conflict + counts.failed;
        const terminalCount = terminalCountsAreValid && Number.isSafeInteger(terminalCountCandidate)
            ? terminalCountCandidate
            : null;
        const plannedCountMatches = nonNegativeSafeInteger(counts.planned)
            && counts.planned === summary.counts.planned
            && summary.counts.planned === options.expectedCount;
        const terminalCountMatches = terminalCount !== null && terminalCount === counts.planned;
        const reviewedNonPlanned = summary.counts.conflict
            + summary.counts.invalid
            + summary.counts.oversized;
        const successful = plannedCountMatches
            && terminalCountMatches
            && reviewedNonPlanned === 0
            && counts.failed === 0
            && unprocessed === 0;
        log({
            phase: 'summary',
            status: successful ? 'complete' : 'incomplete',
            counts,
            reviewedPlanCounts: summary.counts,
            planSha256: reviewedPlan.digest,
            unprocessed,
            countConservation: {
                expectedCount: options.expectedCount,
                reviewedPlanned: summary.counts.planned,
                observedPlanned: counts.planned,
                terminalCount,
                reviewedNonPlanned,
                plannedCountMatches,
                terminalCountMatches,
            },
        });
        return successful ? 0 : 2;
    } finally {
        await admin.deleteApp(app);
    }
}

export function attachMigrationContext(error, context) {
    let contextualError = error instanceof Error ? error : new Error(String(error));
    try {
        Object.defineProperty(contextualError, 'migrationContext', {
            configurable: true,
            enumerable: false,
            value: context,
        });
    } catch {
        contextualError = new Error(contextualError.message, { cause: contextualError });
        contextualError.migrationContext = context;
    }
    return contextualError;
}

export function createFatalEvent(error, now = new Date()) {
    const context = error && typeof error === 'object' ? error.migrationContext : null;
    return {
        timestamp: now.toISOString(),
        executionId: context?.executionId ?? null,
        mode: context?.mode ?? null,
        environment: context?.environment ?? null,
        phase: 'fatal',
        status: 'failed',
        error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
        },
    };
}

export async function main(args = process.argv.slice(2), overrides = {}) {
    const runtime = {
        randomUUID,
        runApply,
        runDryRun,
        runtimeEnvironment,
        ...overrides,
    };
    const executionId = runtime.randomUUID();
    let mode = args.includes('--apply') ? 'APPLY' : 'DRY-RUN';
    let environment = null;
    try {
        const options = parseArguments(args);
        if (options.help) {
            printUsage();
            return 0;
        }

        mode = options.apply ? 'APPLY' : 'DRY-RUN';
        environment = runtime.runtimeEnvironment(options.projectId, options.databaseId);
        if (options.apply) {
            return await runtime.runApply({ options, environment, executionId });
        }
        return await runtime.runDryRun({ options, environment, executionId });
    } catch (error) {
        throw attachMigrationContext(error, { executionId, mode, environment });
    }
}

const isDirectExecution = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
    main().then(exitCode => {
        process.exitCode = exitCode;
    }).catch(error => {
        console.error(JSON.stringify(createFatalEvent(error)));
        process.exitCode = 1;
    });
}

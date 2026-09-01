import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, open, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_LIMITS,
    MAX_APPLY_READ_DOCUMENTS,
    applyPlanRecords,
    applyRecordBatch,
    buildApplyConfirmation,
    classifyDocumentData,
    createDocumentPlanRecord,
    createPlanHeader,
    estimateSerializedWriteBytes,
    generateMigrationPlan,
    partitionPlannedRecords,
    sha256,
    validateApplyBinding,
    validateCredentialProjectId,
} from './migrate-text-to-transcription-core.mjs';
import {
    JsonlPlanWriter,
    MAX_REVIEWED_PLAN_BYTES,
    createFatalEvent,
    firestorePages,
    initializeFirestore,
    inspectPlanFile,
    loadFirebaseAdmin,
    loadServiceAccount,
    main,
    parseArguments,
    planDocumentRecords,
    runApply,
    runtimeEnvironment,
    snapshotReviewedPlan,
} from './migrate-text-to-transcription.mjs';

const timestamp = (seconds, nanoseconds = 0) => ({ seconds, nanoseconds });

function snapshot(id, data, updateTime = timestamp(1), ref = { id }) {
    return {
        id,
        exists: true,
        ref,
        updateTime,
        data: () => data,
    };
}

function plannedRecord(id, text = `body-${id}`, updateTime = timestamp(1)) {
    return createDocumentPlanRecord(snapshot(id, { text }, updateTime));
}

const migrationEnvironment = {
    projectId: 'project-a',
    databaseId: '(default)',
    emulatorHost: null,
};

function planSummary(executionId, records, skipped = 0) {
    const counts = {
        scanned: records.length + skipped,
        skipped,
        planned: 0,
        conflict: 0,
        invalid: 0,
        oversized: 0,
    };
    for (const record of records) {
        counts[record.status] += 1;
    }
    return {
        kind: 'summary',
        executionId,
        counts,
        complete: counts.conflict === 0 && counts.invalid === 0 && counts.oversized === 0,
    };
}

function serializePlan(header, records, summary = planSummary(header.executionId, records)) {
    return `${[header, ...records, summary].map(value => JSON.stringify(value)).join('\n')}\n`;
}

async function writeReviewedPlan(directory, {
    records,
    summary = null,
    executionId = 'reviewed-run',
    fileName = 'reviewed.jsonl',
} = {}) {
    const header = createPlanHeader({
        executionId,
        createdAt: '2026-09-01T00:00:00.000Z',
        environment: migrationEnvironment,
        pageSize: 200,
    });
    const actualSummary = summary ?? planSummary(executionId, records);
    const contents = serializePlan(header, records, actualSummary);
    const planPath = path.join(directory, fileName);
    await writeFile(planPath, contents, 'utf8');
    const digest = sha256(contents);
    return {
        header,
        summary: actualSummary,
        contents,
        planPath,
        options: {
            planFile: planPath,
            planSha256: digest,
            expectedCount: actualSummary.counts.planned,
            confirmation: buildApplyConfirmation({
                environment: migrationEnvironment,
                executionId,
                planSha256: digest,
                plannedCount: actualSummary.counts.planned,
            }),
        },
    };
}

function firestoreBoundaries({ getAll, onLoadServiceAccount = null } = {}) {
    const writes = [];
    const commits = [];
    const collection = { doc: vi.fn(id => ({ id })) };
    const db = {
        collection: vi.fn(() => collection),
        getAll: vi.fn(getAll ?? (async (...arguments_) => {
            arguments_.pop();
            return arguments_.map(ref => snapshot(ref.id, { text: `body-${ref.id}` }, timestamp(1), ref));
        })),
        batch: vi.fn(() => {
            const updates = [];
            return {
                update: vi.fn((...arguments_) => {
                    updates.push(arguments_);
                    writes.push(arguments_);
                }),
                commit: vi.fn(async () => {
                    commits.push(updates.map(([ref]) => ref.id));
                    return updates.map(() => ({ writeTime: timestamp(2) }));
                }),
            };
        }),
    };
    const app = { name: 'migration-test-app' };
    const admin = {
        FieldValue: { delete: vi.fn(() => ({ delete: true })) },
        deleteApp: vi.fn().mockResolvedValue(undefined),
    };
    const loadServiceAccount = vi.fn(async projectId => {
        if (onLoadServiceAccount) {
            await onLoadServiceAccount();
        }
        return { project_id: projectId };
    });
    const loadFirebaseAdmin = vi.fn().mockResolvedValue(admin);
    const initialize = vi.fn().mockResolvedValue({ app, db });
    return {
        admin,
        app,
        collection,
        commits,
        db,
        loadServiceAccount,
        loadFirebaseAdmin,
        initializeFirestore: initialize,
        overrides: {
            loadServiceAccount,
            loadFirebaseAdmin,
            initializeFirestore: initialize,
        },
        writes,
    };
}

function expectExactApplyAudit(events, expectedStatusById) {
    const terminalEvents = events.filter(event => event.phase === 'apply');
    const byId = ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0);
    const expectedPairs = Object.entries(expectedStatusById).sort(byId);
    const observedPairs = terminalEvents.map(event => [event.id, event.status]).sort(byId);
    const observedIds = terminalEvents.map(event => event.id);

    expect(terminalEvents).toHaveLength(expectedPairs.length);
    expect(new Set(observedIds).size).toBe(observedIds.length);
    expect(observedPairs).toEqual(expectedPairs);
    return new Map(terminalEvents.map(event => [event.id, event]));
}

describe('移行対象の純粋判定', () => {
    it.each([
        ['missing', { text: 'legacy' }, false, 'planned', 'canonical_missing'],
        ['own undefined', { text: 'legacy', transcription: undefined }, true, 'invalid', 'canonical_not_string'],
        ['own null', { text: 'legacy', transcription: null }, true, 'planned', 'canonical_null'],
        ['own empty string', { text: 'legacy', transcription: '' }, true, 'conflict', 'canonical_legacy_mismatch'],
        ['own non-string number', { text: 'legacy', transcription: 0 }, true, 'invalid', 'canonical_not_string'],
        ['own non-string object', { text: 'legacy', transcription: {} }, true, 'invalid', 'canonical_not_string'],
    ])('transcription %sをown propertyとして区別する', (_case, data, own, status, reason) => {
        expect(Object.hasOwn(data, 'transcription')).toBe(own);
        expect(classifyDocumentData(data)).toMatchObject({ status, reason });
    });

    it('prototype上だけのtranscriptionはmissingとして扱う', () => {
        const data = Object.assign(Object.create({ transcription: 'inherited' }), { text: 'legacy' });

        expect(Object.hasOwn(data, 'transcription')).toBe(false);
        expect(classifyDocumentData(data)).toMatchObject({
            status: 'planned',
            reason: 'canonical_missing',
        });
    });

    it.each([
        [{}, 'skipped', 'legacy_text_missing'],
        [{ text: null }, 'invalid', 'legacy_text_not_string'],
        [{ text: 1 }, 'invalid', 'legacy_text_not_string'],
        [{ text: '', transcription: {} }, 'invalid', 'canonical_not_string'],
        [{ text: '' }, 'planned', 'canonical_missing'],
        [{ text: 'legacy', transcription: null }, 'planned', 'canonical_null'],
        [{ text: '', transcription: '' }, 'planned', 'canonical_matches_legacy'],
        [{ text: 'same', transcription: 'same' }, 'planned', 'canonical_matches_legacy'],
        [{ text: 'legacy', transcription: '' }, 'conflict', 'canonical_legacy_mismatch'],
        [{ text: '', transcription: 'latest' }, 'conflict', 'canonical_legacy_mismatch'],
        [{ text: 'old', transcription: 'latest' }, 'conflict', 'canonical_legacy_mismatch'],
    ])('%j -> %s', (data, status, reason) => {
        expect(classifyDocumentData(data)).toMatchObject({ status, reason });
    });

    it('planはID/updateTime/body hashを持ち、本文自体を保存しない', () => {
        const record = createDocumentPlanRecord(
            snapshot('doc-1', { text: 'legacy text' }, timestamp(123, 456)),
        );

        expect(record).toEqual(expect.objectContaining({
            id: 'doc-1',
            status: 'planned',
            operation: 'set_transcription_and_delete_text',
            updateTime: { seconds: '123', nanoseconds: 456 },
            bodySha256: sha256('legacy text'),
            bodyBytes: 11,
        }));
        expect(record).not.toHaveProperty('text');
    });

    it('byte上限を超える単一文書をoversizedとして隔離する', () => {
        const record = createDocumentPlanRecord(
            snapshot('huge', { text: 'long body' }),
            { ...DEFAULT_LIMITS, maxSingleWriteBytes: 1 },
        );
        expect(record).toMatchObject({ id: 'huge', status: 'oversized' });
    });

    it('既定8 MiBはちょうど境界を許可し、1 byte超過をoversizedにする', () => {
        const id = 'eight-mib-boundary';
        const eightMiB = 8 * 1024 * 1024;
        const fixedBytes = estimateSerializedWriteBytes(id, '');
        const exactBody = 'x'.repeat(eightMiB - fixedBytes);

        expect(DEFAULT_LIMITS).toMatchObject({
            maxBatchBytes: eightMiB,
            maxSingleWriteBytes: eightMiB,
        });
        expect(estimateSerializedWriteBytes(id, exactBody)).toBe(eightMiB);
        expect(createDocumentPlanRecord(snapshot(id, { text: exactBody }))).toMatchObject({
            status: 'planned',
            estimatedWriteBytes: eightMiB,
        });
        expect(createDocumentPlanRecord(snapshot(id, { text: `${exactBody}x` }))).toMatchObject({
            status: 'oversized',
            estimatedWriteBytes: eightMiB + 1,
        });
    });
});

describe('dry-run plan生成', () => {
    it('ページ単位でJSONL writerへ流し、Firestore writeを一度も要求しない', async () => {
        const values = [];
        const logs = [];
        const pages = (async function* pageSource() {
            yield [
                snapshot('a', { transcription: 'canonical' }),
                snapshot('b', { text: 'legacy' }, timestamp(2)),
            ];
            yield [
                snapshot('c', { text: 'old', transcription: 'latest' }, timestamp(3)),
                snapshot('d', { text: null }, timestamp(4)),
            ];
        }());

        const result = await generateMigrationPlan({
            pages,
            writer: { write: async value => values.push(value) },
            executionId: 'dry-run-id',
            createdAt: '2026-09-01T00:00:00.000Z',
            environment: { projectId: 'project-a', databaseId: '(default)', emulatorHost: null },
            pageSize: 2,
            log: event => logs.push(event),
        });

        expect(values[0]).toMatchObject({
            kind: 'header',
            executionId: 'dry-run-id',
            environment: { projectId: 'project-a', databaseId: '(default)', emulatorHost: null },
        });
        expect(values.filter(value => value.kind === 'document').map(value => [value.id, value.status]))
            .toEqual([['b', 'planned'], ['c', 'conflict'], ['d', 'invalid']]);
        expect(values.at(-1)).toEqual(result.summary);
        expect(result.summary).toMatchObject({
            complete: false,
            counts: { scanned: 4, skipped: 1, planned: 1, conflict: 1, invalid: 1, oversized: 0 },
        });
        expect(logs.map(log => log.status)).toEqual(['planned', 'conflict', 'invalid']);
    });

    it('document ID順・固定pageSize・startAfterで全件getを避ける', async () => {
        const calls = [];
        const pagesByCursor = new Map([
            [null, [snapshot('a', {}), snapshot('b', {})]],
            ['b', [snapshot('c', {})]],
        ]);
        const collection = {
            select: (...fields) => {
                calls.push(['select', ...fields]);
                let cursor = null;
                const query = {
                    orderBy: field => {
                        calls.push(['orderBy', field]);
                        return query;
                    },
                    limit: size => {
                        calls.push(['limit', size]);
                        return query;
                    },
                    startAfter: id => {
                        cursor = id;
                        calls.push(['startAfter', id]);
                        return query;
                    },
                    get: async () => ({ docs: pagesByCursor.get(cursor) }),
                };
                return query;
            },
        };
        const documentIdField = { sentinel: '__name__' };
        const pages = [];
        for await (const page of firestorePages(
            collection,
            { documentId: () => documentIdField },
            2,
        )) {
            pages.push(page.map(document => document.id));
        }

        expect(pages).toEqual([['a', 'b'], ['c']]);
        expect(calls.filter(call => call[0] === 'select')).toHaveLength(2);
        expect(calls.filter(call => call[0] === 'orderBy')).toEqual([
            ['orderBy', documentIdField],
            ['orderBy', documentIdField],
        ]);
        expect(calls.filter(call => call[0] === 'limit')).toEqual([['limit', 2], ['limit', 2]]);
        expect(calls.filter(call => call[0] === 'startAfter')).toEqual([['startAfter', 'b']]);
    });
});

describe('planのapply束縛', () => {
    const environment = { projectId: 'project-a', databaseId: '(default)', emulatorHost: null };
    const digest = 'a'.repeat(64);
    const header = createPlanHeader({
        executionId: 'reviewed-run',
        createdAt: '2026-09-01T00:00:00.000Z',
        environment,
        pageSize: 200,
    });
    const summary = {
        kind: 'summary',
        executionId: 'reviewed-run',
        counts: { scanned: 2, skipped: 1, planned: 1, conflict: 0, invalid: 0, oversized: 0 },
        complete: true,
    };
    const confirmation = buildApplyConfirmation({
        environment,
        executionId: 'reviewed-run',
        planSha256: digest,
        plannedCount: 1,
    });

    function binding(overrides = {}) {
        return validateApplyBinding({
            header,
            summary,
            actualEnvironment: environment,
            actualPlanSha256: digest,
            suppliedPlanSha256: digest,
            expectedCount: 1,
            confirmation,
            ...overrides,
        });
    }

    it('project/database/emulator、digest、件数、明示確認が全一致した場合だけ許可する', () => {
        expect(binding()).toEqual({ requiredConfirmation: confirmation });
    });

    it('資格情報project_idの欠落・不一致を拒否する', () => {
        expect(() => validateCredentialProjectId(undefined, 'project-a')).toThrow('project_id がありません');
        expect(() => validateCredentialProjectId('other', 'project-a')).toThrow('一致しません');
        expect(validateCredentialProjectId('project-a', 'project-a')).toBeUndefined();
    });

    it('service account loaderからproject_id検証を外せないよう固定する', async () => {
        const readText = vi.fn().mockResolvedValue(JSON.stringify({ project_id: 'project-a' }));
        await expect(loadServiceAccount('project-a', {
            serviceAccountPath: '/fake/service-account.json',
            readText,
        })).resolves.toEqual({ project_id: 'project-a' });
        await expect(loadServiceAccount('other', {
            serviceAccountPath: '/fake/service-account.json',
            readText,
        })).rejects.toThrow('一致しません');
        expect(readText).toHaveBeenCalledWith('/fake/service-account.json', 'utf8');
    });

    it('firebase-admin dynamic import不足時の一時導入案内を固定する', async () => {
        const missing = Object.assign(
            new Error("Cannot find package 'firebase-admin' imported from migration CLI"),
            { code: 'ERR_MODULE_NOT_FOUND' },
        );
        const importModule = vi.fn().mockRejectedValue(missing);

        await expect(loadFirebaseAdmin(importModule)).rejects.toThrow(
            'npm i --no-save firebase-admin',
        );
        expect(importModule).toHaveBeenCalledWith('firebase-admin/app');
        expect(importModule).toHaveBeenCalledWith('firebase-admin/firestore');
    });

    it('CLI sourceでfirebase-adminの静的importを禁止しdynamic import配線を固定する', async () => {
        const source = await readFile(
            new URL('./migrate-text-to-transcription.mjs', import.meta.url),
            'utf8',
        );
        const staticAdminImport = /(?:\bfrom\s+|^\s*import\s+)['"]firebase-admin(?:\/[^'"]*)?['"]/m;

        expect(source).not.toMatch(staticAdminImport);
        expect(source).toContain('specifier => import(specifier)');
        expect(source).toContain("importModule('firebase-admin/app')");
        expect(source).toContain("importModule('firebase-admin/firestore')");
    });

    it.each([
        [{ actualEnvironment: { ...environment, projectId: 'other' } }, 'project/database/emulator'],
        [{ actualEnvironment: { ...environment, databaseId: 'other' } }, 'project/database/emulator'],
        [{ actualEnvironment: { ...environment, emulatorHost: '127.0.0.1:8080' } }, 'project/database/emulator'],
        [{ actualPlanSha256: 'b'.repeat(64) }, 'SHA-256'],
        [{ expectedCount: 2 }, 'planned 件数'],
        [{ confirmation: 'APPLY:anything' }, '--confirm'],
    ])('不一致を拒否する: %j', (override, message) => {
        expect(() => binding(override)).toThrow(message);
    });

    it('CLIはapply時の全防壁を必須にし、importだけではmainを起動しない', () => {
        const parsed = parseArguments([
            '--apply',
            '--project-id', 'project-a',
            '--database-id', '(default)',
            '--plan-file', 'plan.jsonl',
            '--plan-sha256', digest,
            '--expected-count', '1',
            '--confirm', confirmation,
        ]);
        expect(parsed).toMatchObject({ apply: true, expectedCount: 1, projectId: 'project-a' });
        expect(() => parseArguments([
            '--apply', '--project-id', 'project-a', '--database-id', '(default)', '--plan-file', 'plan.jsonl',
        ])).toThrow('--plan-sha256');
        expect(runtimeEnvironment('project-a', '(default)', { FIRESTORE_EMULATOR_HOST: 'localhost:8080' }))
            .toEqual({ projectId: 'project-a', databaseId: '(default)', emulatorHost: 'localhost:8080' });
    });

    it('子processの --help は資格情報なしでusageを表示してexit 0にする', () => {
        const scriptPath = fileURLToPath(new URL('./migrate-text-to-transcription.mjs', import.meta.url));
        const child = spawnSync(process.execPath, [scriptPath, '--help'], {
            cwd: path.dirname(scriptPath),
            encoding: 'utf8',
            env: { ...process.env },
        });

        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.signal).toBeNull();
        expect(child.stdout).toContain('Usage:');
        expect(child.stdout).toContain('DRY-RUN:');
        expect(child.stdout).toContain('APPLY (DRY-RUN出力の値をそのまま指定):');
        expect(child.stderr).toBe('');
    });

    it('初期化後のproject/database getterも一致検証する', async () => {
        const app = { options: { projectId: 'project-a' } };
        const db = { databaseId: '(default)' };
        const admin = {
            cert: vi.fn(value => value),
            initializeApp: vi.fn(() => app),
            getFirestore: vi.fn(() => db),
            deleteApp: vi.fn().mockResolvedValue(undefined),
        };

        await expect(initializeFirestore({
            environment,
            executionId: 'apply-run',
            serviceAccount: { project_id: 'project-a' },
            admin,
        })).resolves.toEqual({ app, db });

        db.databaseId = 'other';
        await expect(initializeFirestore({
            environment,
            executionId: 'mismatch-run',
            serviceAccount: { project_id: 'project-a' },
            admin,
        })).rejects.toThrow('Firestore database');
        expect(admin.deleteApp).toHaveBeenCalledWith(app);
    });

    it('既存reviewed planがある場合は上書きも削除もせずEEXISTにする', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-plan-writer-test-'));
        const planPath = path.join(directory, 'reviewed-plan.jsonl');
        try {
            await writeFile(planPath, 'reviewed-plan-bytes\n', 'utf8');
            const writer = await JsonlPlanWriter.create(planPath, 'new-run');
            await writer.write({ kind: 'header', executionId: 'new-run' });

            await expect(writer.finish()).rejects.toMatchObject({ code: 'EEXIST' });
            await expect(readFile(planPath, 'utf8')).resolves.toBe('reviewed-plan-bytes\n');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('snapshotは全bytesを単一Bufferに固定し、hash後のsource差替えの影響を受けない', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-plan-snapshot-test-'));
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [plannedRecord('original')],
            });
            const reviewed = await snapshotReviewedPlan(fixture.planPath);
            await writeFile(fixture.planPath, 'replaced-source-after-snapshot\n', 'utf8');

            expect(Buffer.isBuffer(reviewed.planBuffer)).toBe(true);
            await expect(inspectPlanFile(reviewed.planBuffer)).resolves.toEqual({
                header: fixture.header,
                summary: fixture.summary,
            });
            const records = [];
            for await (const record of planDocumentRecords(reviewed.planBuffer)) {
                records.push(record);
            }
            expect(records.map(record => record.id)).toEqual(['original']);
            expect(reviewed.digest).toBe(sha256(reviewed.planBuffer));
            expect(reviewed.digest).toBe(sha256(fixture.contents));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('256 MiBを超えるreviewed planはBuffer確保前に明示拒否する', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-plan-snapshot-limit-test-'));
        const planPath = path.join(directory, 'oversized.jsonl');
        try {
            await writeFile(planPath, '');
            await truncate(planPath, MAX_REVIEWED_PLAN_BYTES + 1);

            expect(MAX_REVIEWED_PLAN_BYTES).toBe(256 * 1024 * 1024);
            await expect(snapshotReviewedPlan(planPath)).rejects.toThrow(
                `上限 ${MAX_REVIEWED_PLAN_BYTES} bytes`,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('注入した上限ちょうどのplanはsnapshotからinspectまで成功する', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-plan-snapshot-exact-limit-test-'));
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [plannedRecord('exact-limit')],
            });
            const exactLimit = Buffer.byteLength(fixture.contents);
            const reviewed = await snapshotReviewedPlan(fixture.planPath, { maxBytes: exactLimit });

            expect(reviewed.planBuffer).toHaveLength(exactLimit);
            await expect(inspectPlanFile(reviewed.planBuffer)).resolves.toEqual({
                header: fixture.header,
                summary: fixture.summary,
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('stat後に伸長したplanをEOF probeで拒否する', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-plan-snapshot-growth-test-'));
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [plannedRecord('grows-after-stat')],
            });
            const openFile = async (...arguments_) => {
                const handle = await open(...arguments_);
                return {
                    stat: async options => {
                        const sourceStat = await handle.stat(options);
                        await appendFile(fixture.planPath, 'x');
                        return sourceStat;
                    },
                    read: (...readArguments) => handle.read(...readArguments),
                    close: () => handle.close(),
                };
            };

            await expect(snapshotReviewedPlan(fixture.planPath, { openFile })).rejects.toThrow(
                'reviewed plan のサイズがsnapshot中に変更されました',
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('Buffer以外のreviewed snapshot overrideは資格情報前に拒否する', async () => {
        const loadAccount = vi.fn();

        await expect(runApply({
            options: {
                planFile: 'reviewed.jsonl',
                planSha256: digest,
                expectedCount: 1,
                confirmation,
            },
            environment,
            executionId: 'path-only-snapshot',
        }, {
            snapshotReviewedPlan: vi.fn().mockResolvedValue({
                planBuffer: '/mutable/path-only.jsonl',
                digest,
            }),
            loadServiceAccount: loadAccount,
        })).rejects.toThrow('Buffer');

        expect(loadAccount).not.toHaveBeenCalled();
    });

    it('runApplyがreviewed digest/environment/count/confirm検証をwriteより先に配線し、未処理はexit 2にする', async () => {
        const planBuffer = Buffer.from('reviewed-plan');
        const reviewedPlan = {
            planBuffer,
            digest,
        };
        const validateBinding = vi.fn();
        const loadAccount = vi.fn().mockResolvedValue({ project_id: 'project-a' });
        const deleteApp = vi.fn().mockResolvedValue(undefined);
        const admin = {
            FieldValue: { delete: vi.fn(() => ({ delete: true })) },
            deleteApp,
        };
        const db = { collection: vi.fn(() => ({ path: 'transcriptions' })) };
        const apply = vi.fn().mockResolvedValue({
            planned: 1,
            applied: 0,
            conflict: 1,
            invalid: 0,
            oversized: 0,
            failed: 0,
        });
        const inspectPlan = vi.fn().mockResolvedValue({ header, summary });
        const planRecords = vi.fn(() => []);
        const log = vi.fn();
        const options = {
            planFile: 'reviewed.jsonl',
            planSha256: digest,
            expectedCount: 1,
            confirmation,
        };

        const exitCode = await runApply(
            { options, environment, executionId: 'apply-execution' },
            {
                snapshotReviewedPlan: vi.fn().mockResolvedValue(reviewedPlan),
                inspectPlanFile: inspectPlan,
                validateApplyBinding: validateBinding,
                loadServiceAccount: loadAccount,
                loadFirebaseAdmin: vi.fn().mockResolvedValue(admin),
                initializeFirestore: vi.fn().mockResolvedValue({ app: { name: 'app' }, db }),
                planDocumentRecords: planRecords,
                applyPlanRecords: apply,
                machineLogger: vi.fn(() => log),
            },
        );

        expect(validateBinding).toHaveBeenCalledWith(expect.objectContaining({
            header,
            summary,
            actualEnvironment: environment,
            actualPlanSha256: digest,
            suppliedPlanSha256: digest,
            expectedCount: 1,
            confirmation,
        }));
        const privatePlanBuffer = inspectPlan.mock.calls[0][0];
        expect(privatePlanBuffer).not.toBe(planBuffer);
        expect(privatePlanBuffer).toEqual(planBuffer);
        expect(loadAccount).toHaveBeenCalledAfter(validateBinding);
        expect(loadAccount).toHaveBeenCalledWith('project-a');
        expect(planRecords.mock.calls[0][0]).toBe(privatePlanBuffer);
        expect(apply).toHaveBeenCalledOnce();
        expect(deleteApp).toHaveBeenCalledOnce();
        expect(exitCode).toBe(2);
        expect(log).toHaveBeenLastCalledWith(expect.objectContaining({
            phase: 'summary', status: 'incomplete', unprocessed: 1,
        }));
    });

    describe('runApply件数保存則の負側錠', () => {
        const zeroCounts = {
            planned: 0,
            applied: 0,
            conflict: 0,
            reviewedConflict: 0,
            invalid: 0,
            oversized: 0,
            failed: 0,
        };

        async function runCountConservationBoundary(counts) {
            const planBuffer = Buffer.from('reviewed-plan');
            const log = vi.fn();
            const countUnprocessed = vi.fn().mockReturnValue(0);
            const inspectPlan = vi.fn().mockResolvedValue({ header, summary });
            const planRecords = vi.fn(() => []);
            const admin = {
                FieldValue: { delete: vi.fn(() => ({ delete: true })) },
                deleteApp: vi.fn().mockResolvedValue(undefined),
            };
            const db = { collection: vi.fn(() => ({ path: 'transcriptions' })) };

            const exitCode = await runApply({
                options: {
                    planFile: 'reviewed.jsonl',
                    planSha256: digest,
                    expectedCount: 1,
                    confirmation,
                },
                environment,
                executionId: 'count-conservation-boundary',
            }, {
                snapshotReviewedPlan: vi.fn().mockResolvedValue({ planBuffer, digest }),
                inspectPlanFile: inspectPlan,
                validateApplyBinding: vi.fn(),
                loadServiceAccount: vi.fn().mockResolvedValue({ project_id: 'project-a' }),
                loadFirebaseAdmin: vi.fn().mockResolvedValue(admin),
                initializeFirestore: vi.fn().mockResolvedValue({ app: { name: 'app' }, db }),
                planDocumentRecords: planRecords,
                applyPlanRecords: vi.fn().mockResolvedValue(counts),
                countUnprocessed,
                machineLogger: vi.fn(() => log),
            });

            const privatePlanBuffer = inspectPlan.mock.calls[0][0];
            expect(privatePlanBuffer).not.toBe(planBuffer);
            expect(privatePlanBuffer).toEqual(planBuffer);
            expect(planRecords.mock.calls[0][0]).toBe(privatePlanBuffer);
            expect(countUnprocessed).toHaveBeenCalledWith(counts);
            return { exitCode, log };
        }

        it('reviewed/expected=1に対するobserved planned=0をincompleteにする', async () => {
            const { exitCode, log } = await runCountConservationBoundary(zeroCounts);

            expect(exitCode).toBe(2);
            expect(log).toHaveBeenLastCalledWith(expect.objectContaining({
                phase: 'summary',
                status: 'incomplete',
                unprocessed: 0,
                countConservation: expect.objectContaining({
                    expectedCount: 1,
                    reviewedPlanned: 1,
                    observedPlanned: 0,
                    terminalCount: 0,
                    reviewedNonPlanned: 0,
                    plannedCountMatches: false,
                    terminalCountMatches: true,
                }),
            }));
        });

        it.each([
            ['terminal不足', 0, 0],
            ['terminal過剰', 2, 2],
        ])('planned=1に対する%sをincompleteにする', async (_case, applied, terminalCount) => {
            const counts = { ...zeroCounts, planned: 1, applied };
            const { exitCode, log } = await runCountConservationBoundary(counts);

            expect(exitCode).toBe(2);
            expect(log).toHaveBeenLastCalledWith(expect.objectContaining({
                phase: 'summary',
                status: 'incomplete',
                unprocessed: 0,
                countConservation: expect.objectContaining({
                    expectedCount: 1,
                    reviewedPlanned: 1,
                    observedPlanned: 1,
                    terminalCount,
                    reviewedNonPlanned: 0,
                    plannedCountMatches: true,
                    terminalCountMatches: false,
                }),
            }));
        });
    });

    it('apply束縛検証失敗時は資格情報読込・admin初期化・writeへ進まない', async () => {
        const validationError = new Error('digest mismatch');
        const loadAccount = vi.fn();
        const apply = vi.fn();
        const planBuffer = Buffer.from('reviewed-plan');

        await expect(runApply(
            {
                options: {
                    planFile: 'reviewed.jsonl',
                    planSha256: digest,
                    expectedCount: 1,
                    confirmation,
                },
                environment,
                executionId: 'apply-execution',
            },
            {
                snapshotReviewedPlan: vi.fn().mockResolvedValue({
                    planBuffer,
                    digest,
                }),
                inspectPlanFile: vi.fn().mockResolvedValue({ header, summary }),
                validateApplyBinding: vi.fn(() => { throw validationError; }),
                loadServiceAccount: loadAccount,
                applyPlanRecords: apply,
                machineLogger: vi.fn(() => vi.fn()),
            },
        )).rejects.toThrow('digest mismatch');

        expect(loadAccount).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });

    it('事前検証fatalにもexecution ID/mode/environmentを必ず残す', async () => {
        const fatal = new Error('binding failed before first log');
        let contextualError;
        try {
            await main([
                '--apply',
                '--project-id', 'project-a',
                '--database-id', '(default)',
                '--plan-file', 'reviewed.jsonl',
                '--plan-sha256', digest,
                '--expected-count', '1',
                '--confirm', confirmation,
            ], {
                randomUUID: () => 'fatal-execution',
                runtimeEnvironment: () => environment,
                runApply: vi.fn().mockRejectedValue(fatal),
            });
        } catch (error) {
            contextualError = error;
        }

        expect(createFatalEvent(contextualError, new Date('2026-09-01T01:02:03.000Z'))).toEqual({
            timestamp: '2026-09-01T01:02:03.000Z',
            executionId: 'fatal-execution',
            mode: 'APPLY',
            environment,
            phase: 'fatal',
            status: 'failed',
            error: { name: 'Error', message: 'binding failed before first log' },
        });
    });
});

describe('実JSONL reviewed planのhermetic APPLY統合', () => {
    it('Buffer prototypeを持つUint8Arrayも私有コピー後の外部変異をapplyへ波及させない', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-exotic-buffer-test-'));
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [plannedRecord('original')],
            });
            const exoticPlan = new Uint8Array(Buffer.from(fixture.contents));
            Object.setPrototypeOf(exoticPlan, Buffer.prototype);
            const boundaries = firestoreBoundaries({
                onLoadServiceAccount: () => {
                    Uint8Array.prototype.fill.call(exoticPlan, 0);
                },
            });

            expect(Buffer.isBuffer(exoticPlan)).toBe(true);
            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId: 'apply-exotic-buffer',
            }, {
                ...boundaries.overrides,
                snapshotReviewedPlan: vi.fn().mockResolvedValue({
                    planBuffer: exoticPlan,
                    digest: fixture.options.planSha256,
                }),
            })).resolves.toBe(0);

            expect([...exoticPlan].every(byte => byte === 0)).toBe(true);
            expect(boundaries.collection.doc).toHaveBeenCalledWith('original');
            expect(boundaries.commits).toEqual([['original']]);
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('hash後かつinspect前に元ファイルをtruncateしてもBuffer内の文書だけをapplyする', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-truncate-'));
        const executionId = 'apply-after-path-truncate';
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [plannedRecord('original')],
            });
            const boundaries = firestoreBoundaries();
            const snapshotThenTruncateSource = vi.fn(async planFile => {
                const reviewed = await snapshotReviewedPlan(planFile);
                await writeFile(fixture.planPath, '', 'utf8');
                return reviewed;
            });

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId,
            }, {
                ...boundaries.overrides,
                snapshotReviewedPlan: snapshotThenTruncateSource,
            })).resolves.toBe(0);

            expect(snapshotThenTruncateSource).toHaveBeenCalledWith(fixture.planPath);
            expect(boundaries.loadServiceAccount).toHaveBeenCalledWith('project-a');
            expect(boundaries.loadFirebaseAdmin).toHaveBeenCalledOnce();
            expect(boundaries.initializeFirestore).toHaveBeenCalledOnce();
            expect(boundaries.collection.doc).toHaveBeenCalledTimes(1);
            expect(boundaries.collection.doc).toHaveBeenCalledWith('original');
            expect(boundaries.commits).toEqual([['original']]);
            expect(boundaries.writes.map(([ref]) => ref.id)).toEqual(['original']);
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('hash後かつinspect前に元ファイルを同件数planへ替えてもreplacement IDをapplyしない', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-replace-'));
        const executionId = 'apply-after-path-replacement';
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [plannedRecord('original')],
            });
            const replacementRecords = [plannedRecord('replacement')];
            const replacement = serializePlan(
                fixture.header,
                replacementRecords,
                planSummary(fixture.header.executionId, replacementRecords),
            );
            const boundaries = firestoreBoundaries();
            const snapshotThenReplaceSource = vi.fn(async planFile => {
                const reviewed = await snapshotReviewedPlan(planFile);
                await writeFile(fixture.planPath, replacement, 'utf8');
                return reviewed;
            });

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId,
            }, {
                ...boundaries.overrides,
                snapshotReviewedPlan: snapshotThenReplaceSource,
            })).resolves.toBe(0);

            expect(snapshotThenReplaceSource).toHaveBeenCalledWith(fixture.planPath);
            expect(boundaries.collection.doc).toHaveBeenCalledTimes(1);
            expect(boundaries.collection.doc).toHaveBeenCalledWith('original');
            expect(boundaries.collection.doc).not.toHaveBeenCalledWith('replacement');
            expect(boundaries.commits).toEqual([['original']]);
            expect(boundaries.writes.map(([ref]) => ref.id)).toEqual(['original']);
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('summary件数不整合はactual inspectで資格情報・Firestoreより先に拒否する', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-summary-'));
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const records = [plannedRecord('only-record')];
            const fixture = await writeReviewedPlan(directory, {
                records,
                summary: planSummary('reviewed-run', []),
            });
            const boundaries = firestoreBoundaries();

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId: 'apply-summary-mismatch',
            }, boundaries.overrides)).rejects.toThrow('planned 件数がレコードと一致しません');

            expect(boundaries.loadServiceAccount).not.toHaveBeenCalled();
            expect(boundaries.loadFirebaseAdmin).not.toHaveBeenCalled();
            expect(boundaries.initializeFirestore).not.toHaveBeenCalled();
            expect(boundaries.db.getAll).not.toHaveBeenCalled();
            expect(boundaries.db.batch).not.toHaveBeenCalled();
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.each([
        ['empty', ''],
        ['nested path', 'a/b/c'],
        ['single dot', '.'],
        ['double dot', '..'],
        ['reserved pattern', '__reserved__'],
        ['1500 UTF-8 byte超', 'x'.repeat(1501)],
    ])('plan document ID %sを資格情報・Firestoreより先に拒否する', async (_case, invalidId) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-id-'));
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [{ ...plannedRecord('safe-id'), id: invalidId }],
            });
            const boundaries = firestoreBoundaries();

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId: 'apply-invalid-document-id',
            }, boundaries.overrides)).rejects.toThrow('document ID');

            expect(boundaries.loadServiceAccount).not.toHaveBeenCalled();
            expect(boundaries.initializeFirestore).not.toHaveBeenCalled();
            expect(boundaries.db.getAll).not.toHaveBeenCalled();
            expect(boundaries.db.batch).not.toHaveBeenCalled();
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.each([
        ['operation', () => [{ ...plannedRecord('a'), operation: 'unexpected_write' }], 'planned record'],
        ['body hash', () => [{ ...plannedRecord('a'), bodySha256: 'not-a-sha256' }], 'planned record'],
        ['precondition', () => {
            const record = { ...plannedRecord('a') };
            delete record.updateTime;
            return [record];
        }, 'planned record'],
        ['document ID order', () => [plannedRecord('b'), plannedRecord('a')], 'ID順序'],
    ])('planの%s破壊をactual inspectで拒否する', async (_case, records, expectedMessage) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-shape-'));
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const fixture = await writeReviewedPlan(directory, { records: records() });
            const boundaries = firestoreBoundaries();

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId: 'apply-invalid-record-shape',
            }, boundaries.overrides)).rejects.toThrow(expectedMessage);

            expect(boundaries.loadServiceAccount).not.toHaveBeenCalled();
            expect(boundaries.initializeFirestore).not.toHaveBeenCalled();
            expect(boundaries.db.getAll).not.toHaveBeenCalled();
            expect(boundaries.db.batch).not.toHaveBeenCalled();
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('summary後の余剰recordをactual inspectで拒否する', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-trailing-'));
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [plannedRecord('a')],
            });
            await writeFile(
                fixture.planPath,
                `${fixture.contents}${JSON.stringify(plannedRecord('z'))}\n`,
                'utf8',
            );
            const boundaries = firestoreBoundaries();

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId: 'apply-trailing-record',
            }, boundaries.overrides)).rejects.toThrow('summary より後');

            expect(boundaries.loadServiceAccount).not.toHaveBeenCalled();
            expect(boundaries.initializeFirestore).not.toHaveBeenCalled();
            expect(boundaries.db.getAll).not.toHaveBeenCalled();
            expect(boundaries.db.batch).not.toHaveBeenCalled();
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('actual failedをexit 2へ保存し、全apply終端状態を1行1 JSON auditにする', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-audit-'));
        const output = [];
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(line => output.push(line));
        try {
            const records = [
                plannedRecord('a-applied'),
                plannedRecord('b-failed'),
                {
                    kind: 'document',
                    id: 'c-conflict',
                    status: 'conflict',
                    reason: 'canonical_legacy_mismatch',
                    updateTime: { seconds: '1', nanoseconds: 0 },
                },
                {
                    kind: 'document',
                    id: 'd-invalid',
                    status: 'invalid',
                    reason: 'canonical_not_string',
                    updateTime: { seconds: '1', nanoseconds: 0 },
                },
                {
                    kind: 'document',
                    id: 'e-oversized',
                    status: 'oversized',
                    reason: 'canonical_missing',
                    updateTime: { seconds: '1', nanoseconds: 0 },
                },
            ];
            const fixture = await writeReviewedPlan(directory, { records });
            const boundaries = firestoreBoundaries({
                getAll: async (ref, readOptions) => {
                    expect(readOptions).toEqual({ fieldMask: ['text', 'transcription'] });
                    if (ref.id === 'b-failed') {
                        throw new Error('synthetic read failure');
                    }
                    return [snapshot(ref.id, { text: `body-${ref.id}` }, timestamp(1), ref)];
                },
            });

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId: 'apply-audit-terminal-states',
            }, boundaries.overrides)).resolves.toBe(2);

            expect(output.length).toBeGreaterThan(0);
            expect(output.every(line => typeof line === 'string' && !line.includes('\n'))).toBe(true);
            const events = output.map(line => JSON.parse(line));
            const terminalById = expectExactApplyAudit(events, {
                'a-applied': 'applied',
                'b-failed': 'failed',
                'c-conflict': 'conflict',
                'd-invalid': 'invalid',
                'e-oversized': 'oversized',
            });
            for (const event of terminalById.values()) {
                expect(event).toEqual(expect.objectContaining({
                    executionId: 'apply-audit-terminal-states',
                    mode: 'APPLY',
                    environment: migrationEnvironment,
                    phase: 'apply',
                    id: expect.any(String),
                    writeResult: expect.objectContaining({ acknowledged: expect.any(Boolean) }),
                }));
                expect(Date.parse(event.timestamp)).not.toBeNaN();
            }
            expect(events.at(-1)).toMatchObject({
                phase: 'summary',
                status: 'incomplete',
                counts: {
                    planned: 2,
                    applied: 1,
                    conflict: 0,
                    reviewedConflict: 1,
                    invalid: 1,
                    oversized: 1,
                    failed: 1,
                },
                unprocessed: 4,
                countConservation: {
                    expectedCount: 2,
                    reviewedPlanned: 2,
                    observedPlanned: 2,
                    terminalCount: 2,
                    plannedCountMatches: true,
                    terminalCountMatches: true,
                },
            });
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('batch rejectの4状態をactual JSONLからmachine auditとexitまで一気通貫で確定する', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-ambiguous-'));
        const output = [];
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(line => output.push(line));
        try {
            const ids = ['a-applied', 'b-unapplied', 'c-different', 'd-unresolved'];
            const fixture = await writeReviewedPlan(directory, {
                records: ids.map(id => plannedRecord(id)),
            });
            const expectedReadIds = [...ids, ...ids];
            let readIndex = 0;
            const boundaries = firestoreBoundaries({
                getAll: async (ref, readOptions) => {
                    expect(readOptions).toEqual({ fieldMask: ['text', 'transcription'] });
                    const currentRead = readIndex;
                    readIndex += 1;
                    expect(ref.id).toBe(expectedReadIds[currentRead]);
                    if (currentRead < ids.length) {
                        return [snapshot(
                            ref.id,
                            { text: `body-${ref.id}` },
                            timestamp(1),
                            ref,
                        )];
                    }
                    if (ref.id === 'a-applied') {
                        return [snapshot(
                            ref.id,
                            { transcription: `body-${ref.id}` },
                            timestamp(2),
                            ref,
                        )];
                    }
                    if (ref.id === 'b-unapplied') {
                        return [snapshot(
                            ref.id,
                            { text: `body-${ref.id}` },
                            timestamp(1),
                            ref,
                        )];
                    }
                    if (ref.id === 'c-different') {
                        return [snapshot(ref.id, { text: 'changed' }, timestamp(2), ref)];
                    }
                    throw new Error('verification read unavailable');
                },
            });
            const batchError = Object.assign(new Error('batch response lost'), { code: 4 });
            const commits = [
                vi.fn().mockRejectedValue(batchError),
                vi.fn().mockResolvedValue([{ writeTime: timestamp(3) }]),
            ];
            const updatedIdsByBatch = [];
            let batchIndex = 0;
            boundaries.db.batch.mockImplementation(() => {
                const updatedIds = [];
                const commit = commits[batchIndex];
                batchIndex += 1;
                updatedIdsByBatch.push(updatedIds);
                return {
                    update: vi.fn(ref => updatedIds.push(ref.id)),
                    commit,
                };
            });

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId: 'apply-ambiguous-four-states',
            }, boundaries.overrides)).resolves.toBe(2);

            expect(readIndex).toBe(8);
            expect(boundaries.db.getAll).toHaveBeenCalledTimes(8);
            expect(boundaries.db.getAll.mock.calls.map(([ref]) => ref.id)).toEqual(expectedReadIds);
            expect(updatedIdsByBatch).toEqual([ids, ['b-unapplied']]);
            expect(boundaries.db.batch).toHaveBeenCalledTimes(2);
            expect(commits[0]).toHaveBeenCalledOnce();
            expect(commits[1]).toHaveBeenCalledOnce();

            expect(output.every(line => typeof line === 'string' && !line.includes('\n'))).toBe(true);
            const events = output.map(line => JSON.parse(line));
            const terminalById = expectExactApplyAudit(events, {
                'a-applied': 'applied',
                'b-unapplied': 'applied',
                'c-different': 'conflict',
                'd-unresolved': 'failed',
            });
            for (const event of terminalById.values()) {
                expect(event).toEqual(expect.objectContaining({
                    executionId: 'apply-ambiguous-four-states',
                    mode: 'APPLY',
                    environment: migrationEnvironment,
                    phase: 'apply',
                    batchCommitError: {
                        name: 'Error',
                        message: 'batch response lost',
                        code: 4,
                    },
                }));
                expect(Date.parse(event.timestamp)).not.toBeNaN();
            }
            expect(terminalById.get('a-applied')).toMatchObject({
                status: 'applied',
                postBatchState: 'applied',
                writeResult: { acknowledged: false, verifiedApplied: true },
            });
            expect(terminalById.get('b-unapplied')).toMatchObject({
                status: 'applied',
                postBatchState: 'unapplied',
                fallback: 'individual_after_batch_failure',
                writeResult: { acknowledged: true },
            });
            expect(terminalById.get('c-different')).toMatchObject({
                status: 'conflict',
                postBatchState: 'different',
                reason: 'post_batch_commit_state_changed:update_time_changed',
            });
            expect(terminalById.get('d-unresolved')).toMatchObject({
                status: 'failed',
                postBatchState: 'unresolved',
                reason: 'batch_commit_verification_read_failed',
                verificationReadError: {
                    name: 'Error',
                    message: 'verification read unavailable',
                },
            });
            expect(events.at(-1)).toMatchObject({
                phase: 'summary',
                status: 'incomplete',
                counts: {
                    planned: 4,
                    applied: 2,
                    conflict: 1,
                    reviewedConflict: 0,
                    invalid: 0,
                    oversized: 0,
                    failed: 1,
                },
                unprocessed: 2,
                countConservation: {
                    expectedCount: 4,
                    reviewedPlanned: 4,
                    observedPlanned: 4,
                    terminalCount: 4,
                    reviewedNonPlanned: 0,
                    plannedCountMatches: true,
                    terminalCountMatches: true,
                },
            });
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('review済みconflictをruntime conflictへ混ぜずplanned終端保存則を保つ', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'vtd-apply-integration-conflicts-'));
        const output = [];
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(line => output.push(line));
        try {
            const fixture = await writeReviewedPlan(directory, {
                records: [
                    plannedRecord('a-runtime-conflict'),
                    {
                        kind: 'document',
                        id: 'b-reviewed-conflict',
                        status: 'conflict',
                        reason: 'canonical_legacy_mismatch',
                        updateTime: { seconds: '1', nanoseconds: 0 },
                    },
                ],
            });
            const boundaries = firestoreBoundaries({
                getAll: async (ref, readOptions) => {
                    expect(readOptions).toEqual({ fieldMask: ['text', 'transcription'] });
                    return [snapshot(ref.id, { text: `body-${ref.id}` }, timestamp(2), ref)];
                },
            });

            await expect(runApply({
                options: fixture.options,
                environment: migrationEnvironment,
                executionId: 'apply-separated-conflicts',
            }, boundaries.overrides)).resolves.toBe(2);

            const summaryEvent = output.map(line => JSON.parse(line)).at(-1);
            expect(summaryEvent).toMatchObject({
                phase: 'summary',
                status: 'incomplete',
                counts: {
                    planned: 1,
                    applied: 0,
                    conflict: 1,
                    reviewedConflict: 1,
                    failed: 0,
                },
                countConservation: {
                    terminalCount: 1,
                    plannedCountMatches: true,
                    terminalCountMatches: true,
                },
            });
        } finally {
            consoleLog.mockRestore();
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe('バッチ境界とwrite payload', () => {
    it('450/451件境界で分割する', () => {
        const records = Array.from({ length: 451 }, (_, index) => ({
            status: 'planned',
            id: String(index).padStart(3, '0'),
            estimatedWriteBytes: 1,
        }));
        expect(partitionPlannedRecords(records).map(batch => batch.length)).toEqual([450, 1]);
    });

    it('件数未満でもserialized byte上限で分割する', () => {
        const records = ['a', 'b', 'c'].map(id => ({ status: 'planned', id, estimatedWriteBytes: 60 }));
        const limits = { maxBatchOperations: 450, maxBatchBytes: 100, maxSingleWriteBytes: 100 };
        expect(partitionPlannedRecords(records, limits).map(batch => batch.map(record => record.id)))
            .toEqual([['a'], ['b'], ['c']]);
    });

    it('transcription設定とtext削除を同じupdate/preconditionに厳密に入れる', async () => {
        const updateTime = timestamp(10, 20);
        const ref = { id: 'one' };
        const current = snapshot('one', { text: 'legacy' }, updateTime, ref);
        const record = plannedRecord('one', 'legacy', updateTime);
        const update = vi.fn();
        const commit = vi.fn().mockResolvedValue([{ writeTime: timestamp(11, 30) }]);
        const db = {
            getAll: vi.fn().mockResolvedValue([current]),
            batch: vi.fn(() => ({ update, commit })),
        };
        const deleteSentinel = { delete: 'sentinel' };

        const results = await applyRecordBatch({
            db,
            collection: { doc: () => ref },
            records: [record],
            deleteFieldValue: deleteSentinel,
        });

        expect(db.getAll).toHaveBeenCalledWith(ref, { fieldMask: ['text', 'transcription'] });
        expect(update).toHaveBeenCalledOnce();
        expect(update).toHaveBeenCalledWith(
            ref,
            { transcription: 'legacy', text: deleteSentinel },
            { lastUpdateTime: updateTime },
        );
        expect(results).toEqual([expect.objectContaining({
            id: 'one',
            status: 'applied',
            precondition: { lastUpdateTime: { seconds: '10', nanoseconds: 20 } },
        })]);
    });

    it('読取後に更新された文書をwriteせずconflictにする', async () => {
        const record = plannedRecord('one', 'legacy', timestamp(10));
        const db = {
            getAll: vi.fn().mockResolvedValue([
                snapshot('one', { text: 'legacy' }, timestamp(11)),
            ]),
            batch: vi.fn(),
        };

        const results = await applyRecordBatch({
            db,
            collection: { doc: id => ({ id }) },
            records: [record],
            deleteFieldValue: { delete: true },
        });

        expect(results).toEqual([expect.objectContaining({
            id: 'one', status: 'conflict', reason: 'update_time_changed',
        })]);
        expect(db.batch).not.toHaveBeenCalled();
    });

    it('updateTimeが同じでも本文hashがplanと違えばwriteせずconflictにする', async () => {
        const updateTime = timestamp(10);
        const record = plannedRecord('one', 'reviewed-body', updateTime);
        const db = {
            getAll: vi.fn().mockResolvedValue([
                snapshot('one', { text: 'different-body' }, updateTime),
            ]),
            batch: vi.fn(),
        };

        const results = await applyRecordBatch({
            db,
            collection: { doc: id => ({ id }) },
            records: [record],
            deleteFieldValue: { delete: true },
        });

        expect(results).toEqual([expect.objectContaining({
            id: 'one', status: 'conflict', reason: 'legacy_body_changed',
        })]);
        expect(db.batch).not.toHaveBeenCalled();
    });

    it('batch失敗時は個別fallbackし、ID別にapplied/conflictを確定する', async () => {
        const records = [plannedRecord('a'), plannedRecord('b')];
        const preconditionError = Object.assign(new Error('changed'), { code: 9 });
        const commits = [
            vi.fn().mockRejectedValue(preconditionError),
            vi.fn().mockResolvedValue([{}]),
            vi.fn().mockRejectedValue(preconditionError),
        ];
        let batchIndex = 0;
        const db = {
            getAll: vi.fn()
                .mockResolvedValueOnce([snapshot('a', { text: 'body-a' })])
                .mockResolvedValueOnce([snapshot('b', { text: 'body-b' })])
                .mockResolvedValueOnce([snapshot('a', { text: 'body-a' })])
                .mockResolvedValueOnce([snapshot('b', { text: 'body-b' })])
                .mockResolvedValueOnce([
                    snapshot('b', { text: 'changed-by-another-writer' }, timestamp(2)),
                ]),
            batch: vi.fn(() => ({
                update: vi.fn(),
                commit: commits[batchIndex++],
            })),
        };

        const results = await applyRecordBatch({
            db,
            collection: { doc: id => ({ id }) },
            records,
            deleteFieldValue: { delete: true },
        });

        expect(results).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'a',
                status: 'applied',
                fallback: 'individual_after_batch_failure',
                postBatchState: 'unapplied',
            }),
            expect.objectContaining({
                id: 'b',
                status: 'conflict',
                fallback: 'individual_after_batch_failure',
                postBatchState: 'unapplied',
                postIndividualState: 'different',
            }),
        ]));
        expect(db.batch).toHaveBeenCalledTimes(3);
    });

    it('曖昧なbatch reject後は各IDをapplied/unapplied/different/unresolvedへ独立判定する', async () => {
        const records = ['a', 'b', 'c', 'd'].map(id => plannedRecord(id));
        const batchError = Object.assign(new Error('batch response lost'), { code: 4 });
        const getAll = vi.fn()
            // Initial validation reads.
            .mockResolvedValueOnce([snapshot('a', { text: 'body-a' })])
            .mockResolvedValueOnce([snapshot('b', { text: 'body-b' })])
            .mockResolvedValueOnce([snapshot('c', { text: 'body-c' })])
            .mockResolvedValueOnce([snapshot('d', { text: 'body-d' })])
            // Post-batch verification reads: applied, unapplied, different, unresolved.
            .mockResolvedValueOnce([snapshot('a', { transcription: 'body-a' }, timestamp(2))])
            .mockResolvedValueOnce([snapshot('b', { text: 'body-b' })])
            .mockResolvedValueOnce([snapshot('c', { text: 'changed' }, timestamp(2))])
            .mockRejectedValueOnce(new Error('verification read unavailable'));
        const commits = [
            vi.fn().mockRejectedValue(batchError),
            vi.fn().mockResolvedValue([{}]),
        ];
        let batchIndex = 0;
        const log = vi.fn();
        const db = {
            getAll,
            batch: vi.fn(() => ({
                update: vi.fn(),
                commit: commits[batchIndex++],
            })),
        };

        const results = await applyRecordBatch({
            db,
            collection: { doc: id => ({ id }) },
            records,
            deleteFieldValue: { delete: true },
            log,
        });

        expect(results).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'a', status: 'applied', postBatchState: 'applied' }),
            expect.objectContaining({
                id: 'b',
                status: 'applied',
                postBatchState: 'unapplied',
                fallback: 'individual_after_batch_failure',
            }),
            expect.objectContaining({ id: 'c', status: 'conflict', postBatchState: 'different' }),
            expect.objectContaining({ id: 'd', status: 'failed', postBatchState: 'unresolved' }),
        ]));
        for (const result of results) {
            expect(result.batchCommitError).toEqual({
                name: 'Error',
                message: 'batch response lost',
                code: 4,
            });
        }
        expect(getAll).toHaveBeenCalledTimes(8);
        expect(db.batch).toHaveBeenCalledTimes(2);
        expect(commits[0]).toHaveBeenCalledOnce();
        expect(commits[1]).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledTimes(4);
    });

    it('曖昧なbatch reject後にcanonical-only期待値を確認できれば再writeせずappliedにする', async () => {
        const record = plannedRecord('ambiguous');
        const reference = { id: 'ambiguous' };
        const commitError = Object.assign(new Error('deadline exceeded after commit'), { code: 4 });
        const commit = vi.fn().mockRejectedValue(commitError);
        const log = vi.fn();
        const db = {
            getAll: vi.fn()
                .mockResolvedValueOnce([
                    snapshot('ambiguous', { text: 'body-ambiguous' }, timestamp(1), reference),
                ])
                .mockResolvedValueOnce([
                    snapshot('ambiguous', { transcription: 'body-ambiguous' }, timestamp(2), reference),
                ]),
            batch: vi.fn(() => ({ update: vi.fn(), commit })),
        };

        const results = await applyRecordBatch({
            db,
            collection: { doc: () => reference },
            records: [record],
            deleteFieldValue: { delete: true },
            log,
        });

        expect(results).toEqual([expect.objectContaining({
            id: 'ambiguous',
            status: 'applied',
            postBatchState: 'applied',
            writeResult: { acknowledged: false, verifiedApplied: true },
            batchCommitError: {
                name: 'Error',
                message: 'deadline exceeded after commit',
                code: 4,
            },
        })]);
        expect(db.getAll).toHaveBeenCalledTimes(2);
        expect(db.batch).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(expect.objectContaining({
            status: 'applied',
            postBatchState: 'applied',
            batchCommitError: expect.objectContaining({ message: 'deadline exceeded after commit' }),
        }));
    });

    it.each([
        ['applied', 'applied', null],
        ['unapplied', 'failed', 'individual_commit_rejected_unapplied'],
        ['different', 'conflict', 'post_individual_commit_state_changed:update_time_changed'],
        ['unresolved', 'failed', 'individual_commit_verification_read_failed'],
    ])('個別commit reject後の再読取 %s を確定しblind retryしない', async (
        postIndividualState,
        expectedStatus,
        expectedReason,
    ) => {
        const record = plannedRecord('one');
        const reference = { id: 'one' };
        const batchError = Object.assign(new Error('batch response lost'), { code: 4 });
        const individualError = Object.assign(new Error('individual response lost'), { code: 4 });
        const getAll = vi.fn()
            .mockResolvedValueOnce([
                snapshot('one', { text: 'body-one' }, timestamp(1), reference),
            ])
            .mockResolvedValueOnce([
                snapshot('one', { text: 'body-one' }, timestamp(1), reference),
            ]);
        if (postIndividualState === 'applied') {
            getAll.mockResolvedValueOnce([
                snapshot('one', { transcription: 'body-one' }, timestamp(2), reference),
            ]);
        } else if (postIndividualState === 'unapplied') {
            getAll.mockResolvedValueOnce([
                snapshot('one', { text: 'body-one' }, timestamp(1), reference),
            ]);
        } else if (postIndividualState === 'different') {
            getAll.mockResolvedValueOnce([
                snapshot('one', { text: 'changed' }, timestamp(2), reference),
            ]);
        } else {
            getAll.mockRejectedValueOnce(new Error('post-individual read unavailable'));
        }
        const commits = [
            vi.fn().mockRejectedValue(batchError),
            vi.fn().mockRejectedValue(individualError),
        ];
        let batchIndex = 0;
        const db = {
            getAll,
            batch: vi.fn(() => ({
                update: vi.fn(),
                commit: commits[batchIndex++],
            })),
        };

        const results = await applyRecordBatch({
            db,
            collection: { doc: () => reference },
            records: [record],
            deleteFieldValue: { delete: true },
        });

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            id: 'one',
            status: expectedStatus,
            fallback: 'individual_after_batch_failure',
            postBatchState: 'unapplied',
            postIndividualState,
            batchCommitError: { name: 'Error', message: 'batch response lost', code: 4 },
            individualCommitError: { name: 'Error', message: 'individual response lost', code: 4 },
        });
        if (expectedReason === null) {
            expect(results[0]).not.toHaveProperty('reason');
        } else {
            expect(results[0]).toHaveProperty('reason', expectedReason);
        }
        expect(getAll).toHaveBeenCalledTimes(3);
        expect(db.batch).toHaveBeenCalledTimes(2);
        expect(commits[0]).toHaveBeenCalledOnce();
        expect(commits[1]).toHaveBeenCalledOnce();
    });

    it('commit成功後にloggerがthrowしてもcommit失敗扱いで再試行しない', async () => {
        const record = plannedRecord('logger-throws');
        const reference = { id: 'logger-throws' };
        const commit = vi.fn().mockResolvedValue([{ writeTime: timestamp(2) }]);
        const db = {
            getAll: vi.fn().mockResolvedValue([
                snapshot('logger-throws', { text: 'body-logger-throws' }, timestamp(1), reference),
            ]),
            batch: vi.fn(() => ({ update: vi.fn(), commit })),
        };
        const loggerError = new Error('audit sink failed');
        const log = vi.fn(() => { throw loggerError; });

        await expect(applyRecordBatch({
            db,
            collection: { doc: () => reference },
            records: [record],
            deleteFieldValue: { delete: true },
            log,
        })).rejects.toBe(loggerError);

        expect(db.getAll).toHaveBeenCalledTimes(1);
        expect(db.batch).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledTimes(1);
    });

    it('個別fallback成功後にloggerがthrowしても追加commitや検証readをしない', async () => {
        const record = plannedRecord('fallback-logger-throws');
        const reference = { id: 'fallback-logger-throws' };
        const batchError = new Error('batch response lost');
        const commits = [
            vi.fn().mockRejectedValue(batchError),
            vi.fn().mockResolvedValue([{ writeTime: timestamp(2) }]),
        ];
        let batchIndex = 0;
        const db = {
            getAll: vi.fn()
                .mockResolvedValueOnce([
                    snapshot(reference.id, { text: `body-${reference.id}` }, timestamp(1), reference),
                ])
                .mockResolvedValueOnce([
                    snapshot(reference.id, { text: `body-${reference.id}` }, timestamp(1), reference),
                ]),
            batch: vi.fn(() => ({
                update: vi.fn(),
                commit: commits[batchIndex++],
            })),
        };
        const loggerError = new Error('audit sink failed after fallback');
        const log = vi.fn(() => { throw loggerError; });

        await expect(applyRecordBatch({
            db,
            collection: { doc: () => reference },
            records: [record],
            deleteFieldValue: { delete: true },
            log,
        })).rejects.toBe(loggerError);

        expect(db.getAll).toHaveBeenCalledTimes(2);
        expect(db.batch).toHaveBeenCalledTimes(2);
        expect(commits[0]).toHaveBeenCalledOnce();
        expect(commits[1]).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledTimes(1);
    });

    it('planが小さくlive本文が巨大でもAPPLY readは必ず1文書ずつにhard capする', async () => {
        const records = ['a', 'b', 'c'].map(id => plannedRecord(id, `small-${id}`));
        const hugeLiveBody = 'x'.repeat(DEFAULT_LIMITS.maxBatchBytes + 1);
        const db = {
            getAll: vi.fn(async (ref, readOptions) => {
                expect(readOptions).toEqual({ fieldMask: ['text', 'transcription'] });
                return [snapshot(ref.id, { text: hugeLiveBody }, timestamp(1), ref)];
            }),
            batch: vi.fn(),
        };

        const results = await applyRecordBatch({
            db,
            collection: { doc: id => ({ id }) },
            records,
            deleteFieldValue: { delete: true },
        });

        expect(MAX_APPLY_READ_DOCUMENTS).toBe(1);
        expect(db.getAll).toHaveBeenCalledTimes(records.length);
        expect(db.getAll.mock.calls.map(call => call[0].id)).toEqual(['a', 'b', 'c']);
        expect(db.getAll.mock.calls.every(call => call.length === MAX_APPLY_READ_DOCUMENTS + 1)).toBe(true);
        expect(results).toHaveLength(3);
        expect(results.every(result => result.status === 'conflict')).toBe(true);
        expect(db.batch).not.toHaveBeenCalled();
    });

    it('async iterableは次batchの先頭までだけpullし、commit完了前に全件をmaterializeしない', async () => {
        const events = [];
        const records = (async function* recordSource() {
            for (const id of ['a', 'b', 'c', 'd']) {
                events.push(`pull:${id}`);
                yield plannedRecord(id);
            }
        }());
        const db = {
            getAll: vi.fn(async (ref) => {
                events.push(`read:${ref.id}`);
                return [snapshot(ref.id, { text: `body-${ref.id}` }, timestamp(1), ref)];
            }),
            batch: vi.fn(() => {
                const ids = [];
                return {
                    update: vi.fn(ref => ids.push(ref.id)),
                    commit: vi.fn(async () => {
                        events.push(`commit:${ids.join(',')}`);
                        return ids.map(() => ({}));
                    }),
                };
            }),
        };

        const counts = await applyPlanRecords({
            records,
            db,
            collection: { doc: id => ({ id }) },
            deleteFieldValue: { delete: true },
            limits: {
                ...DEFAULT_LIMITS,
                maxBatchOperations: 2,
            },
        });

        expect(events).toEqual([
            'pull:a',
            'pull:b',
            'pull:c',
            'read:a',
            'read:b',
            'commit:a,b',
            'pull:d',
            'read:c',
            'read:d',
            'commit:c,d',
        ]);
        expect(counts).toMatchObject({ planned: 4, applied: 4, conflict: 0, failed: 0 });
    });

    it('apply処理自体も451件を1件ずつreadしつつ450+1でcommitする', async () => {
        const records = Array.from({ length: 451 }, (_, index) => {
            const id = String(index).padStart(3, '0');
            return plannedRecord(id);
        });
        const commitSizes = [];
        const readSizes = [];
        const db = {
            getAll: vi.fn(async (...arguments_) => {
                const readOptions = arguments_.pop();
                expect(readOptions).toEqual({ fieldMask: ['text', 'transcription'] });
                const refs = arguments_;
                readSizes.push(refs.length);
                return refs.map(ref => snapshot(ref.id, { text: `body-${ref.id}` }, timestamp(1), ref));
            }),
            batch: vi.fn(() => {
                let size = 0;
                return {
                    update: vi.fn(() => { size += 1; }),
                    commit: vi.fn(async () => {
                        commitSizes.push(size);
                        return Array.from({ length: size }, () => ({}));
                    }),
                };
            }),
        };

        const counts = await applyPlanRecords({
            records,
            db,
            collection: { doc: id => ({ id }) },
            deleteFieldValue: { delete: true },
        });

        expect(readSizes).toHaveLength(451);
        expect(new Set(readSizes)).toEqual(new Set([MAX_APPLY_READ_DOCUMENTS]));
        expect(commitSizes).toEqual([450, 1]);
        expect(counts).toMatchObject({ planned: 451, applied: 451, conflict: 0, failed: 0 });
    });
});

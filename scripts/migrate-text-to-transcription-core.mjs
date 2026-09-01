import { createHash } from 'node:crypto';

export const PLAN_FORMAT = 'videos-to-docs/text-to-transcription/v2';
export const DEFAULT_PAGE_SIZE = 200;
// APPLY reads are intentionally issued one document at a time. `text` can have
// grown since the reviewed plan was created, so plan byte estimates cannot be
// used to safely size a multi-document read request.
export const MAX_APPLY_READ_DOCUMENTS = 1;
export const DEFAULT_LIMITS = Object.freeze({
    maxBatchOperations: 450,
    // Firestore's request limit is 10 MiB. Keep two MiB for protocol/index overhead.
    maxBatchBytes: 8 * 1024 * 1024,
    maxSingleWriteBytes: 8 * 1024 * 1024,
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function utf8Bytes(value) {
    return Buffer.byteLength(value, 'utf8');
}

export function estimateSerializedWriteBytes(id, text) {
    // JSON is deliberately used as a conservative, deterministic approximation of
    // the protobuf request. The fixed allowance covers document paths, transforms,
    // masks, preconditions, and protocol framing.
    const serialized = JSON.stringify({
        documentId: id,
        update: { transcription: text },
        deleteFields: ['text'],
    });
    return utf8Bytes(serialized) + 2048;
}

export function serializeUpdateTime(updateTime) {
    if (!updateTime || typeof updateTime !== 'object') {
        throw new Error('updateTime がありません');
    }

    const seconds = updateTime.seconds;
    const nanoseconds = updateTime.nanoseconds;
    if (
        (typeof seconds !== 'number' && typeof seconds !== 'string' && typeof seconds !== 'bigint')
        || !Number.isInteger(Number(nanoseconds))
        || Number(nanoseconds) < 0
        || Number(nanoseconds) > 999_999_999
    ) {
        throw new Error('updateTime が不正です');
    }

    return {
        seconds: String(seconds),
        nanoseconds: Number(nanoseconds),
    };
}

export function updateTimesEqual(left, right) {
    try {
        const normalizedLeft = serializeUpdateTime(left);
        const normalizedRight = serializeUpdateTime(right);
        return normalizedLeft.seconds === normalizedRight.seconds
            && normalizedLeft.nanoseconds === normalizedRight.nanoseconds;
    } catch {
        return false;
    }
}

export function normalizeEnvironment({ projectId, databaseId, emulatorHost = null }) {
    if (typeof projectId !== 'string' || projectId.length === 0) {
        throw new Error('projectId は空でない文字列で指定してください');
    }
    if (typeof databaseId !== 'string' || databaseId.length === 0) {
        throw new Error('databaseId は空でない文字列で指定してください');
    }
    if (emulatorHost !== null && (typeof emulatorHost !== 'string' || emulatorHost.length === 0)) {
        throw new Error('emulatorHost は null または空でない文字列で指定してください');
    }

    return { projectId, databaseId, emulatorHost };
}

export function environmentsEqual(left, right) {
    try {
        const a = normalizeEnvironment(left);
        const b = normalizeEnvironment(right);
        return a.projectId === b.projectId
            && a.databaseId === b.databaseId
            && a.emulatorHost === b.emulatorHost;
    } catch {
        return false;
    }
}

export function classifyDocumentData(data) {
    if (!data || typeof data !== 'object') {
        return { status: 'invalid', reason: 'document_data_not_object' };
    }
    if (!hasOwn(data, 'text')) {
        return { status: 'skipped', reason: 'legacy_text_missing' };
    }
    if (typeof data.text !== 'string') {
        return { status: 'invalid', reason: 'legacy_text_not_string' };
    }

    const canonicalMissing = !hasOwn(data, 'transcription');
    if (canonicalMissing || data.transcription === null) {
        return {
            status: 'planned',
            reason: canonicalMissing ? 'canonical_missing' : 'canonical_null',
            text: data.text,
        };
    }
    if (typeof data.transcription !== 'string') {
        return { status: 'invalid', reason: 'canonical_not_string' };
    }
    if (data.transcription === data.text) {
        return { status: 'planned', reason: 'canonical_matches_legacy', text: data.text };
    }

    // A mismatch can be produced after the canonical-only application has edited
    // transcription while stale legacy text remains. Never pick either side.
    return {
        status: 'conflict',
        reason: 'canonical_legacy_mismatch',
        text: data.text,
        transcription: data.transcription,
    };
}

function baseDocumentRecord(id, status, reason, updateTime) {
    const record = { kind: 'document', id, status, reason };
    if (updateTime) {
        record.updateTime = serializeUpdateTime(updateTime);
    }
    return record;
}

export function createDocumentPlanRecord(documentSnapshot, limits = DEFAULT_LIMITS) {
    if (!documentSnapshot || typeof documentSnapshot.id !== 'string' || documentSnapshot.id.length === 0) {
        throw new Error('文書IDが不正です');
    }

    let data;
    try {
        data = documentSnapshot.data();
    } catch {
        return baseDocumentRecord(documentSnapshot.id, 'invalid', 'document_data_unreadable');
    }

    const classification = classifyDocumentData(data);
    if (classification.status === 'skipped' || classification.status === 'invalid') {
        let updateTime;
        try {
            updateTime = documentSnapshot.updateTime
                ? serializeUpdateTime(documentSnapshot.updateTime)
                : undefined;
        } catch {
            updateTime = undefined;
        }
        return {
            kind: 'document',
            id: documentSnapshot.id,
            status: classification.status,
            reason: classification.reason,
            ...(updateTime ? { updateTime } : {}),
        };
    }

    let updateTime;
    try {
        updateTime = serializeUpdateTime(documentSnapshot.updateTime);
    } catch {
        return baseDocumentRecord(documentSnapshot.id, 'invalid', 'update_time_missing_or_invalid');
    }

    if (classification.status === 'conflict') {
        return {
            kind: 'document',
            id: documentSnapshot.id,
            status: 'conflict',
            reason: classification.reason,
            updateTime,
            legacyBodySha256: sha256(classification.text),
            legacyBodyBytes: utf8Bytes(classification.text),
            canonicalBodySha256: sha256(classification.transcription),
            canonicalBodyBytes: utf8Bytes(classification.transcription),
        };
    }

    const bodyBytes = utf8Bytes(classification.text);
    const estimatedWriteBytes = estimateSerializedWriteBytes(documentSnapshot.id, classification.text);
    const common = {
        kind: 'document',
        id: documentSnapshot.id,
        reason: classification.reason,
        updateTime,
        bodySha256: sha256(classification.text),
        bodyBytes,
        estimatedWriteBytes,
    };

    if (
        estimatedWriteBytes > limits.maxSingleWriteBytes
        || estimatedWriteBytes > limits.maxBatchBytes
    ) {
        return { ...common, status: 'oversized' };
    }

    return {
        ...common,
        status: 'planned',
        operation: 'set_transcription_and_delete_text',
    };
}

export function createPlanHeader({ executionId, createdAt, environment, pageSize, limits = DEFAULT_LIMITS }) {
    if (typeof executionId !== 'string' || executionId.length === 0) {
        throw new Error('executionId がありません');
    }
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
        throw new Error('createdAt が不正です');
    }
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
        throw new Error('pageSize が不正です');
    }
    if (
        !Number.isSafeInteger(limits.maxBatchOperations)
        || limits.maxBatchOperations <= 0
        || !Number.isSafeInteger(limits.maxBatchBytes)
        || limits.maxBatchBytes <= 0
        || !Number.isSafeInteger(limits.maxSingleWriteBytes)
        || limits.maxSingleWriteBytes <= 0
    ) {
        throw new Error('plan limits が不正です');
    }

    return {
        kind: 'header',
        format: PLAN_FORMAT,
        executionId,
        createdAt,
        environment: normalizeEnvironment(environment),
        collection: 'transcriptions',
        ordering: '__name__ ASC',
        pageSize,
        limits: {
            maxBatchOperations: limits.maxBatchOperations,
            maxBatchBytes: limits.maxBatchBytes,
            maxSingleWriteBytes: limits.maxSingleWriteBytes,
        },
    };
}

export function emptyPlanCounts() {
    return {
        scanned: 0,
        skipped: 0,
        planned: 0,
        conflict: 0,
        invalid: 0,
        oversized: 0,
    };
}

export async function generateMigrationPlan({
    pages,
    writer,
    executionId,
    createdAt,
    environment,
    pageSize = DEFAULT_PAGE_SIZE,
    limits = DEFAULT_LIMITS,
    log = () => {},
}) {
    const header = createPlanHeader({ executionId, createdAt, environment, pageSize, limits });
    const counts = emptyPlanCounts();
    await writer.write(header);

    let previousId = null;
    for await (const page of pages) {
        if (!Array.isArray(page) || page.length > pageSize) {
            throw new Error('ページが不正、または pageSize を超えています');
        }

        for (const documentSnapshot of page) {
            const record = createDocumentPlanRecord(documentSnapshot, limits);
            if (previousId !== null && compareDocumentIds(previousId, record.id) >= 0) {
                throw new Error(`文書IDの順序が不正です: ${record.id}`);
            }
            previousId = record.id;
            counts.scanned += 1;
            counts[record.status] += 1;

            // Fully migrated/canonical documents are counted but omitted from the
            // reviewed plan so even very large collections do not retain them.
            if (record.status !== 'skipped') {
                await writer.write(record);
                log({
                    phase: 'plan',
                    status: record.status,
                    id: record.id,
                    reason: record.reason,
                    ...(record.updateTime ? { precondition: { lastUpdateTime: record.updateTime } } : {}),
                    ...(record.bodySha256 ? { bodySha256: record.bodySha256 } : {}),
                    writeResult: { acknowledged: false, attempted: false },
                });
            }
        }
    }

    const summary = {
        kind: 'summary',
        executionId,
        counts,
        complete: counts.conflict === 0 && counts.invalid === 0 && counts.oversized === 0,
    };
    await writer.write(summary);
    return { header, summary };
}

export function compareDocumentIds(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function addRecordToBatch(batch, record, limits = DEFAULT_LIMITS) {
    if (record.status !== 'planned') {
        throw new Error(`planned でないレコードはバッチに追加できません: ${record.id}`);
    }
    if (record.estimatedWriteBytes > limits.maxBatchBytes) {
        throw new Error(`単一文書がバッチbyte上限を超えています: ${record.id}`);
    }

    const wouldExceedOperations = batch.records.length >= limits.maxBatchOperations;
    const wouldExceedBytes = batch.records.length > 0
        && batch.estimatedBytes + record.estimatedWriteBytes > limits.maxBatchBytes;
    if (wouldExceedOperations || wouldExceedBytes) {
        return false;
    }

    batch.records.push(record);
    batch.estimatedBytes += record.estimatedWriteBytes;
    return true;
}

export function partitionPlannedRecords(records, limits = DEFAULT_LIMITS) {
    const batches = [];
    let batch = { records: [], estimatedBytes: 0 };

    for (const record of records) {
        if (!addRecordToBatch(batch, record, limits)) {
            batches.push(batch.records);
            batch = { records: [], estimatedBytes: 0 };
            if (!addRecordToBatch(batch, record, limits)) {
                throw new Error(`文書を空バッチに追加できません: ${record.id}`);
            }
        }
    }
    if (batch.records.length > 0) {
        batches.push(batch.records);
    }
    return batches;
}

export function buildApplyConfirmation({ environment, executionId, planSha256, plannedCount }) {
    const normalized = normalizeEnvironment(environment);
    return [
        'APPLY',
        normalized.projectId,
        normalized.databaseId,
        normalized.emulatorHost ?? 'production',
        executionId,
        String(plannedCount),
        planSha256,
    ].join(':');
}

export function validateApplyBinding({
    header,
    summary,
    actualEnvironment,
    actualPlanSha256,
    suppliedPlanSha256,
    expectedCount,
    confirmation,
}) {
    if (!header || header.kind !== 'header' || header.format !== PLAN_FORMAT) {
        throw new Error('plan header または format が不正です');
    }
    if (!summary || summary.kind !== 'summary' || summary.executionId !== header.executionId) {
        throw new Error('plan summary が不正です');
    }
    if (!environmentsEqual(header.environment, actualEnvironment)) {
        throw new Error('plan の project/database/emulator が実行環境と一致しません');
    }
    if (!/^[a-f0-9]{64}$/.test(suppliedPlanSha256 ?? '')) {
        throw new Error('--plan-sha256 は64文字の小文字SHA-256で指定してください');
    }
    if (actualPlanSha256 !== suppliedPlanSha256) {
        throw new Error('plan SHA-256 が --plan-sha256 と一致しません');
    }
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new Error('--expected-count は0以上の整数で指定してください');
    }
    if (summary.counts?.planned !== expectedCount) {
        throw new Error('plan の planned 件数が --expected-count と一致しません');
    }

    const requiredConfirmation = buildApplyConfirmation({
        environment: actualEnvironment,
        executionId: header.executionId,
        planSha256: actualPlanSha256,
        plannedCount: expectedCount,
    });
    if (confirmation !== requiredConfirmation) {
        throw new Error(`--confirm が一致しません。必要な値: ${requiredConfirmation}`);
    }
    return { requiredConfirmation };
}

export function validateCredentialProjectId(credentialProjectId, requestedProjectId) {
    if (typeof credentialProjectId !== 'string' || credentialProjectId.length === 0) {
        throw new Error('資格情報に project_id がありません');
    }
    if (credentialProjectId !== requestedProjectId) {
        throw new Error(
            `資格情報の project_id (${credentialProjectId}) が --project-id (${requestedProjectId}) と一致しません`,
        );
    }
}

export function validateCurrentSnapshot(record, snapshot) {
    if (!snapshot || snapshot.exists !== true) {
        return { ok: false, reason: 'document_missing' };
    }
    if (snapshot.id !== record.id) {
        return { ok: false, reason: 'document_id_mismatch' };
    }
    if (!updateTimesEqual(snapshot.updateTime, record.updateTime)) {
        return { ok: false, reason: 'update_time_changed' };
    }

    let data;
    try {
        data = snapshot.data();
    } catch {
        return { ok: false, reason: 'document_data_unreadable' };
    }
    const classification = classifyDocumentData(data);
    if (classification.status !== 'planned') {
        return { ok: false, reason: `document_now_${classification.status}` };
    }
    // Check the cheap reviewed byte bound before hashing. In particular, this
    // rejects a body that became huge after planning without feeding it through
    // SHA-256 or serializing it for a write-size estimate.
    if (
        utf8Bytes(classification.text) !== record.bodyBytes
        || sha256(classification.text) !== record.bodySha256
    ) {
        return { ok: false, reason: 'legacy_body_changed' };
    }
    if (estimateSerializedWriteBytes(record.id, classification.text) !== record.estimatedWriteBytes) {
        return { ok: false, reason: 'estimated_write_bytes_mismatch' };
    }

    return { ok: true, text: classification.text };
}

export function isPreconditionError(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = error.code;
    return code === 9
        || code === '9'
        || code === 'failed-precondition'
        || code === 'FAILED_PRECONDITION';
}

function errorForLog(error) {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, ...('code' in error ? { code: error.code } : {}) };
    }
    return { name: 'Error', message: String(error) };
}

function writeResultForLog(writeResult) {
    if (!writeResult) {
        return { acknowledged: true };
    }
    try {
        return {
            acknowledged: true,
            updateTime: serializeUpdateTime(writeResult.writeTime ?? writeResult.updateTime),
        };
    } catch {
        return { acknowledged: true };
    }
}

const APPLY_FIELD_MASK = Object.freeze(['text', 'transcription']);

/**
 * Read exactly one migration document with the smallest useful field mask.
 *
 * This deliberately does not accept an array. A reviewed plan only bounds the
 * old body size; the live `text` value may now be much larger. Keeping request
 * cardinality at one gives APPLY a hard, plan-independent read-memory bound.
 */
export async function readSingleApplySnapshot(db, reference) {
    const snapshots = await db.getAll(reference, { fieldMask: [...APPLY_FIELD_MASK] });
    if (!Array.isArray(snapshots)) {
        throw new Error('APPLY の単一文書read結果が配列ではありません');
    }
    if (snapshots.length > MAX_APPLY_READ_DOCUMENTS) {
        throw new Error('APPLY の単一文書read上限を超える結果が返されました');
    }
    return snapshots[0];
}

function addExactUpdate(batch, candidate, deleteFieldValue) {
    batch.update(
        candidate.reference,
        { transcription: candidate.text, text: deleteFieldValue },
        { lastUpdateTime: candidate.lastUpdateTime },
    );
}

function classifyPostCommitSnapshot(candidate, snapshot) {
    if (!snapshot || snapshot.exists !== true) {
        return { state: 'different', reason: 'document_missing' };
    }
    if (snapshot.id !== candidate.record.id) {
        return { state: 'different', reason: 'document_id_mismatch' };
    }

    let data;
    try {
        data = snapshot.data();
    } catch (error) {
        return {
            state: 'unresolved',
            reason: 'document_data_unreadable',
            readError: errorForLog(error),
        };
    }
    if (!data || typeof data !== 'object') {
        return { state: 'different', reason: 'document_data_not_object' };
    }

    // This is the exact state produced by the migration update. updateTime is
    // intentionally not compared here: a successful write necessarily changes
    // it, and a rejected RPC may still have been committed by Firestore.
    if (
        !hasOwn(data, 'text')
        && typeof data.transcription === 'string'
        && data.transcription === candidate.text
    ) {
        return { state: 'applied' };
    }

    if (!updateTimesEqual(snapshot.updateTime, candidate.record.updateTime)) {
        return { state: 'different', reason: 'update_time_changed' };
    }
    const classification = classifyDocumentData(data);
    if (classification.status !== 'planned') {
        return { state: 'different', reason: `document_now_${classification.status}` };
    }
    if (
        utf8Bytes(classification.text) !== candidate.record.bodyBytes
        || sha256(classification.text) !== candidate.record.bodySha256
    ) {
        return { state: 'different', reason: 'legacy_body_changed' };
    }
    if (
        estimateSerializedWriteBytes(candidate.record.id, classification.text)
        !== candidate.record.estimatedWriteBytes
    ) {
        return { state: 'different', reason: 'estimated_write_bytes_mismatch' };
    }
    return { state: 'unapplied' };
}

async function inspectPostCommitState({ db, candidate }) {
    let snapshot;
    try {
        snapshot = await readSingleApplySnapshot(db, candidate.reference);
    } catch (error) {
        return { state: 'unresolved', readError: errorForLog(error) };
    }
    return classifyPostCommitSnapshot(candidate, snapshot);
}

async function applyIndividually({
    db,
    candidates,
    deleteFieldValue,
    log,
    batchCommitError,
}) {
    const results = [];
    for (const candidate of candidates) {
        const batch = db.batch();
        addExactUpdate(batch, candidate, deleteFieldValue);

        let writeResults;
        let commitRejected = false;
        let individualCommitError;
        try {
            writeResults = await batch.commit();
        } catch (error) {
            commitRejected = true;
            individualCommitError = error;
        }

        // Keep logger exceptions outside the commit catch. Retrying an already
        // committed write because the audit sink threw would make the RPC result
        // ambiguous again and can incorrectly turn success into conflict.
        if (!commitRejected) {
            const result = {
                status: 'applied',
                id: candidate.record.id,
                precondition: { lastUpdateTime: candidate.record.updateTime },
                writeResult: writeResultForLog(writeResults?.[0]),
                fallback: 'individual_after_batch_failure',
                postBatchState: 'unapplied',
                batchCommitError,
            };
            results.push(result);
            log(result);
            continue;
        }

        // A rejected individual commit is ambiguous for the same reason as a
        // rejected batch commit. Resolve it by reading that ID once more; never
        // issue a blind second retry.
        const postCommit = await inspectPostCommitState({ db, candidate });
        const serializedIndividualError = errorForLog(individualCommitError);
        let result;
        if (postCommit.state === 'applied') {
            result = {
                status: 'applied',
                id: candidate.record.id,
                precondition: { lastUpdateTime: candidate.record.updateTime },
                writeResult: { acknowledged: false, verifiedApplied: true },
                fallback: 'individual_after_batch_failure',
                postBatchState: 'unapplied',
                postIndividualState: 'applied',
                batchCommitError,
                individualCommitError: serializedIndividualError,
            };
        } else if (postCommit.state === 'unapplied') {
            result = {
                status: 'failed',
                id: candidate.record.id,
                reason: 'individual_commit_rejected_unapplied',
                precondition: { lastUpdateTime: candidate.record.updateTime },
                writeResult: { acknowledged: false, error: serializedIndividualError },
                fallback: 'individual_after_batch_failure',
                postBatchState: 'unapplied',
                postIndividualState: 'unapplied',
                batchCommitError,
                individualCommitError: serializedIndividualError,
            };
        } else if (postCommit.state === 'different') {
            result = {
                status: 'conflict',
                id: candidate.record.id,
                reason: `post_individual_commit_state_changed:${postCommit.reason}`,
                precondition: { lastUpdateTime: candidate.record.updateTime },
                writeResult: { acknowledged: false, error: serializedIndividualError },
                fallback: 'individual_after_batch_failure',
                postBatchState: 'unapplied',
                postIndividualState: 'different',
                batchCommitError,
                individualCommitError: serializedIndividualError,
            };
        } else {
            const result = {
                status: 'failed',
                id: candidate.record.id,
                reason: 'individual_commit_verification_read_failed',
                precondition: { lastUpdateTime: candidate.record.updateTime },
                writeResult: { acknowledged: false, error: serializedIndividualError },
                fallback: 'individual_after_batch_failure',
                postBatchState: 'unapplied',
                postIndividualState: 'unresolved',
                batchCommitError,
                individualCommitError: serializedIndividualError,
                verificationReadError: postCommit.readError,
            };
            results.push(result);
            log(result);
            continue;
        }
        results.push(result);
        log(result);
    }
    return results;
}

async function resolveRejectedBatchCommit({
    db,
    candidates,
    deleteFieldValue,
    log,
    error,
}) {
    const results = [];
    const unappliedCandidates = [];
    const batchCommitError = errorForLog(error);

    // Resolve every ID independently. Even though a Firestore batch is atomic,
    // another writer can change individual documents before this verification
    // read, so a single inferred outcome for the whole batch is not sufficient.
    for (const candidate of candidates) {
        const postCommit = await inspectPostCommitState({ db, candidate });
        let result;
        if (postCommit.state === 'applied') {
            result = {
                status: 'applied',
                id: candidate.record.id,
                precondition: { lastUpdateTime: candidate.record.updateTime },
                writeResult: { acknowledged: false, verifiedApplied: true },
                postBatchState: 'applied',
                batchCommitError,
            };
        } else if (postCommit.state === 'unapplied') {
            unappliedCandidates.push(candidate);
            continue;
        } else if (postCommit.state === 'different') {
            result = {
                status: 'conflict',
                id: candidate.record.id,
                reason: `post_batch_commit_state_changed:${postCommit.reason}`,
                precondition: { lastUpdateTime: candidate.record.updateTime },
                writeResult: { acknowledged: false, error: batchCommitError },
                postBatchState: 'different',
                batchCommitError,
            };
        } else {
            result = {
                status: 'failed',
                id: candidate.record.id,
                reason: 'batch_commit_verification_read_failed',
                precondition: { lastUpdateTime: candidate.record.updateTime },
                writeResult: { acknowledged: false, error: batchCommitError },
                postBatchState: 'unresolved',
                batchCommitError,
                verificationReadError: postCommit.readError,
            };
        }
        results.push(result);
        log(result);
    }

    results.push(...await applyIndividually({
        db,
        candidates: unappliedCandidates,
        deleteFieldValue,
        log,
        batchCommitError,
    }));
    return results;
}

async function commitValidatedCandidates({ db, candidates, deleteFieldValue, log }) {
    const batch = db.batch();
    for (const candidate of candidates) {
        addExactUpdate(batch, candidate, deleteFieldValue);
    }

    let writeResults;
    let commitRejected = false;
    let commitError;
    try {
        writeResults = await batch.commit();
    } catch (error) {
        commitRejected = true;
        commitError = error;
    }

    if (commitRejected) {
        return resolveRejectedBatchCommit({
            db,
            candidates,
            deleteFieldValue,
            log,
            error: commitError,
        });
    }

    // As above, logging is deliberately outside the commit try/catch.
    const results = [];
    candidates.forEach((candidate, index) => {
        const result = {
            status: 'applied',
            id: candidate.record.id,
            precondition: { lastUpdateTime: candidate.record.updateTime },
            writeResult: writeResultForLog(writeResults?.[index]),
        };
        results.push(result);
        log(result);
    });
    return results;
}

function recordExceedsRuntimeLimits(record, limits) {
    return !Number.isSafeInteger(record.estimatedWriteBytes)
        || record.estimatedWriteBytes <= 0
        || record.estimatedWriteBytes > limits.maxSingleWriteBytes
        || record.estimatedWriteBytes > limits.maxBatchBytes;
}

export async function applyRecordBatch({
    db,
    collection,
    records,
    deleteFieldValue,
    limits = DEFAULT_LIMITS,
    log = () => {},
}) {
    const results = [];
    let candidateBatch = { candidates: [], estimatedBytes: 0 };

    const flushCandidates = async () => {
        if (candidateBatch.candidates.length === 0) {
            return;
        }
        const current = candidateBatch;
        candidateBatch = { candidates: [], estimatedBytes: 0 };
        results.push(...await commitValidatedCandidates({
            db,
            candidates: current.candidates,
            deleteFieldValue,
            log,
        }));
    };

    for (const record of records) {
        if (recordExceedsRuntimeLimits(record, limits)) {
            const result = {
                status: 'failed',
                id: record.id,
                reason: 'record_exceeds_runtime_batch_limits',
                precondition: { lastUpdateTime: record.updateTime },
                writeResult: { acknowledged: false, attempted: false },
            };
            results.push(result);
            log(result);
            continue;
        }

        const wouldExceedOperations = candidateBatch.candidates.length >= limits.maxBatchOperations;
        const wouldExceedBytes = candidateBatch.candidates.length > 0
            && candidateBatch.estimatedBytes + record.estimatedWriteBytes > limits.maxBatchBytes;
        if (wouldExceedOperations || wouldExceedBytes) {
            await flushCandidates();
        }

        const reference = collection.doc(record.id);
        let snapshot;
        let readFailed = false;
        let readError;
        try {
            snapshot = await readSingleApplySnapshot(db, reference);
        } catch (error) {
            readFailed = true;
            readError = error;
        }

        // Logging stays outside the read catch for the same reason it stays
        // outside commit catches: an audit sink failure is not a Firestore read
        // failure and must not be relabelled as one.
        if (readFailed) {
            const result = {
                status: 'failed',
                id: record.id,
                reason: 'read_failed',
                precondition: { lastUpdateTime: record.updateTime },
                writeResult: { acknowledged: false, error: errorForLog(readError) },
            };
            results.push(result);
            log(result);
            continue;
        }

        const validation = validateCurrentSnapshot(record, snapshot);
        if (!validation.ok) {
            const result = {
                status: 'conflict',
                id: record.id,
                reason: validation.reason,
                precondition: { lastUpdateTime: record.updateTime },
                writeResult: { acknowledged: false, attempted: false },
            };
            results.push(result);
            log(result);
            continue;
        }

        // Do not retain the snapshot: its data closure can keep the whole live
        // document (including a large body) reachable. Only validated text and
        // the exact ref/precondition needed by the write enter the bounded batch.
        candidateBatch.candidates.push({
            record,
            reference,
            lastUpdateTime: snapshot.updateTime,
            text: validation.text,
        });
        candidateBatch.estimatedBytes += record.estimatedWriteBytes;
    }

    await flushCandidates();
    return results;
}

export function emptyApplyCounts() {
    return {
        planned: 0,
        applied: 0,
        conflict: 0,
        reviewedConflict: 0,
        invalid: 0,
        oversized: 0,
        failed: 0,
    };
}

export async function applyPlanRecords({
    records,
    db,
    collection,
    deleteFieldValue,
    limits = DEFAULT_LIMITS,
    log = () => {},
}) {
    const counts = emptyApplyCounts();
    let batch = { records: [], estimatedBytes: 0 };

    const flush = async () => {
        if (batch.records.length === 0) {
            return;
        }
        const current = batch;
        batch = { records: [], estimatedBytes: 0 };
        const results = await applyRecordBatch({
            db,
            collection,
            records: current.records,
            deleteFieldValue,
            limits,
            log: event => log({ phase: 'apply', ...event }),
        });
        for (const result of results) {
            counts[result.status] += 1;
        }
    };

    for await (const record of records) {
        if (record.status !== 'planned') {
            if (record.status === 'conflict') {
                // Keep reviewed/static conflicts separate from conflicts reached
                // by a planned record during APPLY. The latter participates in
                // the planned terminal-state conservation equation.
                counts.reviewedConflict += 1;
            } else if (record.status in counts) {
                counts[record.status] += 1;
            }
            log({
                phase: 'apply',
                status: record.status,
                id: record.id,
                reason: `isolated_by_reviewed_plan:${record.reason}`,
                ...(record.updateTime ? { precondition: { lastUpdateTime: record.updateTime } } : {}),
                writeResult: { acknowledged: false, attempted: false },
            });
            continue;
        }

        counts.planned += 1;
        if (!addRecordToBatch(batch, record, limits)) {
            await flush();
            if (!addRecordToBatch(batch, record, limits)) {
                counts.failed += 1;
                log({
                    phase: 'apply',
                    status: 'failed',
                    id: record.id,
                    reason: 'record_exceeds_runtime_batch_limits',
                    precondition: { lastUpdateTime: record.updateTime },
                    writeResult: { acknowledged: false, attempted: false },
                });
            }
        }
    }
    await flush();
    return counts;
}

export function countUnprocessed(counts) {
    // Every planned record ends as applied, conflict, or failed. Non-planned
    // records are already represented by their isolated terminal status.
    return counts.conflict
        + (counts.reviewedConflict ?? 0)
        + counts.invalid
        + counts.oversized
        + counts.failed;
}

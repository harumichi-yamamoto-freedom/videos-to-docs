/**
 * 非同期バッチ文字起こしの**ジョブ状態**を Firestore `transcriptionJobs/{jobId}` に持つ。
 *
 * 🔴 なぜ永続化するか（設計 §7.2・L5-#5 の指摘）: 現行はジョブ状態がブラウザのメモリにしか無く、
 *    タブを閉じる/リロード/スリープで全損し、再開は全チャンクやり直し（再課金）だった。
 *    バッチは Azure 側で数分〜数十分走るので、状態をサーバに持てば**タブ非依存**で完了を拾える。
 *
 * 🔴 このコレクションはサーバ (Admin SDK) だけが書く。クライアントは status API 経由で読む。
 *    Firestore ルールでクライアントの直接読み書きは禁止する（別途 firestore.rules）。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminFirestore } from './firebaseAdmin';
import { TRANSCRIPTIONS_COLLECTION, type TranscriptionDocStatus } from './transcriptionDocument';
import { createLogger } from '@/lib/logger';
import type { AzureBatchStatus } from '@/lib/azureBatchContract';

const logger = createLogger('server/transcriptionJob');

export const TRANSCRIPTION_JOBS_COLLECTION = 'transcriptionJobs';

/**
 * `finalizing` は確定処理中の一時状態（内部用）。
 * 🔴 並行に status が 2 回叩かれても確定を 1 回にするための CAS ロック（設計 §3.7・冪等性）。
 *    利用者向けの公開ステータスは running / succeeded / failed の 3 値だけ（finalizing は running 相当に見せる）。
 */
export type TranscriptionJobStatus = 'running' | 'finalizing' | 'succeeded' | 'failed';

/** finalizing のまま放置されたジョブ（確定中にプロセスが落ちた等）を再確定できるようにするリース期限 */
export const FINALIZE_LEASE_MS = 3 * 60 * 1000;

export interface TranscriptionJob {
    id: string;
    ownerId: string;
    ownerType: 'guest' | 'user';
    /** 先に作っておく文書の ID。完了時にここへ本文を書き込む */
    docId: string;
    /** Azure バッチジョブの参照 URL（?api-version 付き。二重付与しないこと） */
    azureSelfUrl: string;
    status: TranscriptionJobStatus;
    audioSec: number;
    storagePath: string;
    promptName: string;
    /** 失敗理由（利用者にも記録にも残す。件数だけの警報にしない） */
    error?: string;
    /** 何名の話者が出たか等、完了時の要約（本文は入れない） */
    speakers?: number;
    createdAtMs: number;
    updatedAtMs: number;
    /** 最後に取得した有効な Azure 状態。内部の finalizing とは区別する。 */
    azureStatus?: AzureBatchStatus;
    /** 有効観測のサーバ時刻。updatedAt のリース時計には使わない。 */
    azureStatusCheckedAtMs?: number;
}

export interface CreateTranscriptionJobInput {
    ownerId: string;
    ownerType: 'guest' | 'user';
    docId: string;
    azureSelfUrl: string;
    audioSec: number;
    storagePath: string;
    promptName: string;
}

export type TerminalOutcome =
    | { kind: 'succeeded'; transcription: string; generatedByModel: string; speakers: number }
    | { kind: 'failed'; reason: string };

const db = (): Firestore => getAdminFirestore();

const toMs = (v: unknown): number => {
    try {
        const ms = v && typeof v === 'object' && typeof (v as { toMillis?: () => number }).toMillis === 'function'
            ? (v as { toMillis: () => number }).toMillis()
            : v;
        return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
    } catch {
        return 0;
    }
};

const isAzureBatchStatus = (value: unknown): value is AzureBatchStatus =>
    value === 'NotStarted' || value === 'Running' || value === 'Succeeded' || value === 'Failed';

const parseJob = (id: string, data: FirebaseFirestore.DocumentData | undefined): TranscriptionJob | null => {
    if (!data) return null;
    if (typeof data.azureSelfUrl !== 'string' || typeof data.docId !== 'string') return null;
    const azureStatusCheckedAtMs = toMs(data.azureStatusCheckedAt);
    return {
        id,
        ownerId: String(data.ownerId ?? ''),
        ownerType: data.ownerType === 'user' ? 'user' : 'guest',
        docId: data.docId,
        azureSelfUrl: data.azureSelfUrl,
        status: (['running', 'finalizing', 'succeeded', 'failed'] as const).includes(data.status) ? data.status : 'running',
        audioSec: typeof data.audioSec === 'number' ? data.audioSec : 0,
        storagePath: String(data.storagePath ?? ''),
        promptName: String(data.promptName ?? ''),
        ...(typeof data.error === 'string' && { error: data.error }),
        ...(typeof data.speakers === 'number' && { speakers: data.speakers }),
        createdAtMs: toMs(data.createdAt),
        updatedAtMs: toMs(data.updatedAt),
        ...(isAzureBatchStatus(data.azureStatus) && { azureStatus: data.azureStatus }),
        ...(azureStatusCheckedAtMs > 0 && { azureStatusCheckedAtMs }),
    };
};

/** ジョブを作る。ID は Firestore の自動採番を使う。 */
export async function createTranscriptionJob(input: CreateTranscriptionJobInput): Promise<string> {
    const ref = db().collection(TRANSCRIPTION_JOBS_COLLECTION).doc();
    await ref.set({
        ...input,
        status: 'running' satisfies TranscriptionJobStatus,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info('文字起こしジョブを登録', { jobId: ref.id, ownerType: input.ownerType, audioSec: input.audioSec });
    return ref.id;
}

export async function getTranscriptionJob(jobId: string): Promise<TranscriptionJob | null> {
    const snap = await db().collection(TRANSCRIPTION_JOBS_COLLECTION).doc(jobId).get();
    return parseJob(jobId, snap.exists ? snap.data() : undefined);
}

/**
 * 有効な Azure 観測だけを保存する。進捗確認で finalizing のリース時計 updatedAt を延ばさない。
 * 遅延したリクエストが終端状態や既に得た Azure 終端観測を巻き戻すことも防ぐ。
 */
export async function recordAzureObservation(jobId: string, azureStatus: AzureBatchStatus): Promise<TranscriptionJob | null> {
    const firestore = db();
    const ref = firestore.collection(TRANSCRIPTION_JOBS_COLLECTION).doc(jobId);
    return firestore.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const job = parseJob(jobId, snap.exists ? snap.data() : undefined);
        if (!job || job.status === 'succeeded' || job.status === 'failed' || !isAzureBatchStatus(azureStatus)) return job;
        if ((job.azureStatus === 'Succeeded' || job.azureStatus === 'Failed') && job.azureStatus !== azureStatus) return job;

        tx.set(ref, { azureStatus, azureStatusCheckedAt: FieldValue.serverTimestamp() }, { merge: true });
        // serverTimestamp は commit 時に確定するため、応答にはサーバでの観測時刻を使う。
        return { ...job, azureStatus, azureStatusCheckedAtMs: Date.now() };
    });
}

/** jobId 未付与の既存文書も、docId から最新のジョブを引けるようにする。 */
export async function getTranscriptionJobByDocId(docId: string): Promise<TranscriptionJob | null> {
    // docId 単一等値・自動索引を使う。createdAt の比較は取得後に行い、複合索引を不要にする。
    const snapshot = await db().collection(TRANSCRIPTION_JOBS_COLLECTION).where('docId', '==', docId).get();
    let latest: TranscriptionJob | null = null;
    for (const doc of snapshot.docs) {
        const job = parseJob(doc.id, doc.data());
        if (job && (!latest || job.createdAtMs > latest.createdAtMs)) latest = job;
    }
    return latest;
}

/** 確定権を取得する。処理中のリースが切れた場合だけ、別リクエストで再取得できる。 */
export async function claimJobForFinalize(jobId: string): Promise<TranscriptionJob | null> {
    const firestore = db();
    const ref = firestore.collection(TRANSCRIPTION_JOBS_COLLECTION).doc(jobId);
    return firestore.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const job = parseJob(jobId, snap.exists ? snap.data() : undefined);
        if (!job || job.status === 'succeeded' || job.status === 'failed') return null;

        const nowMs = Date.now();
        if (job.status === 'finalizing' && nowMs - job.updatedAtMs <= FINALIZE_LEASE_MS) return null;

        tx.update(ref, { status: 'finalizing', updatedAt: FieldValue.serverTimestamp() });
        // serverTimestamp は commit 時に確定するため、戻り値には取得時刻を使う。
        return { ...job, status: 'finalizing', updatedAtMs: nowMs };
    });
}

/** 文書とジョブを同時に終端化する。失敗時は両方の更新を取り消し、リース切れ後に再確定できる。 */
export async function commitTerminalOutcome(params: {
    jobId: string;
    docId: string;
    expectedOwnerId: string;
    outcome: TerminalOutcome;
}): Promise<'committed' | 'not_owner'> {
    const { jobId, docId, expectedOwnerId, outcome } = params;
    const firestore = db();
    const jobRef = firestore.collection(TRANSCRIPTION_JOBS_COLLECTION).doc(jobId);
    const docRef = firestore.collection(TRANSCRIPTIONS_COLLECTION).doc(docId);
    return firestore.runTransaction(async tx => {
        const jobSnap = await tx.get(jobRef);
        if (!jobSnap.exists || jobSnap.data()?.status !== 'finalizing') return 'not_owner';

        const docSnap = await tx.get(docRef);
        const doc = docSnap.data();
        const updatedAt = FieldValue.serverTimestamp();
        if (!docSnap.exists) {
            logger.warn('削除済みの文書の終端更新をスキップ', { docId });
        } else if (doc?.ownerId !== expectedOwnerId) {
            logger.warn('所有者が異なる文書の終端更新をスキップ', { docId });
        } else if (doc.status !== 'processing') {
            logger.warn('処理中でない文書の終端更新をスキップ', { docId });
        } else if (doc.jobId !== undefined && doc.jobId !== jobId) {
            logger.warn('ジョブが異なる文書の終端更新をスキップ', { docId });
        } else {
            tx.set(docRef, outcome.kind === 'succeeded' ? {
                transcription: outcome.transcription,
                generatedByModel: outcome.generatedByModel,
                status: 'completed' satisfies TranscriptionDocStatus,
                processingProgress: FieldValue.delete(),
                updatedAt,
            } : {
                transcription: `文字起こしに失敗しました。\n\n理由: ${outcome.reason}\n\nお手数ですが、もう一度お試しください。`,
                status: 'failed' satisfies TranscriptionDocStatus,
                processingProgress: FieldValue.delete(),
                updatedAt,
            }, { merge: true });
        }

        // 文書が削除・変更されていてもジョブは終端化し、同じ結果の取り込みを繰り返さない。
        tx.set(jobRef, outcome.kind === 'succeeded' ? {
            status: 'succeeded' satisfies TranscriptionJobStatus,
            speakers: outcome.speakers,
            updatedAt,
        } : {
            status: 'failed' satisfies TranscriptionJobStatus,
            error: outcome.reason,
            updatedAt,
        }, { merge: true });
        return 'committed';
    });
}

export async function updateTranscriptionJob(
    jobId: string,
    patch: Partial<Pick<TranscriptionJob, 'status' | 'error' | 'speakers'>>,
): Promise<void> {
    const firestore = db();
    const ref = firestore.collection(TRANSCRIPTION_JOBS_COLLECTION).doc(jobId);
    if (patch.status === 'running' || patch.status === 'finalizing') {
        // 遅れて届いた確定権の解放で、削除済み・終端化済みのジョブを復活させない。
        await firestore.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const status = snap.data()?.status;
            if (!snap.exists || status === 'succeeded' || status === 'failed') return;
            tx.set(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        });
        return;
    }
    await ref.set(
        { ...patch, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
    );
}

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
    if (v && typeof v === 'object' && typeof (v as { toMillis?: () => number }).toMillis === 'function') {
        return (v as { toMillis: () => number }).toMillis();
    }
    return typeof v === 'number' ? v : 0;
};

const parseJob = (id: string, data: FirebaseFirestore.DocumentData | undefined): TranscriptionJob | null => {
    if (!data) return null;
    if (typeof data.azureSelfUrl !== 'string' || typeof data.docId !== 'string') return null;
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
        } else {
            tx.set(docRef, outcome.kind === 'succeeded' ? {
                transcription: outcome.transcription,
                generatedByModel: outcome.generatedByModel,
                status: 'completed' satisfies TranscriptionDocStatus,
                updatedAt,
            } : {
                transcription: `文字起こしに失敗しました。\n\n理由: ${outcome.reason}\n\nお手数ですが、もう一度お試しください。`,
                status: 'failed' satisfies TranscriptionDocStatus,
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
    await db().collection(TRANSCRIPTION_JOBS_COLLECTION).doc(jobId).set(
        { ...patch, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
    );
}

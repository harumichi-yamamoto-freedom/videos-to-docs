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

export async function updateTranscriptionJob(
    jobId: string,
    patch: Partial<Pick<TranscriptionJob, 'status' | 'error' | 'speakers'>>,
): Promise<void> {
    await db().collection(TRANSCRIPTION_JOBS_COLLECTION).doc(jobId).set(
        { ...patch, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
    );
}

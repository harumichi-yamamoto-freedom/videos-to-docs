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
import type { TranscriptReview } from '@/lib/transcriptReviewContract';

const logger = createLogger('server/transcriptionJob');

export const TRANSCRIPTION_JOBS_COLLECTION = 'transcriptionJobs';

/**
 * Firestore の 1 文書上限（1 MiB）と、その手前で確保する余白。
 * 🔴 要確認データ(transcriptReview)を載せた**文書全体**がこの上限を超えないかは、既存フィールド（title 等）の
 *    実サイズを含めて確定判定しなければならない。route 側の reviewFitsDocument は本文＋review＋一定の余白しか見ないため、
 *    極端に長い title があると見落とす。ここ（終端トランザクション）は tx で読んだ実フィールドで最終判定し、
 *    超えるなら review を落として**本文だけは必ず保存する**（設計 B4 の本文優先）。
 *    余白は Firestore の実サイズ計算（フィールド名・型オーバーヘッド）と JSON 概算の差を吸収するためのもの。
 */
const FIRESTORE_DOC_LIMIT_BYTES = 1024 * 1024;
const DOC_WRITE_MARGIN_BYTES = 32 * 1024;

/**
 * 本文だけで 1 文書上限を超えるとき、末尾を省いて保存する旨の断り。
 * 🔴 240 分の時間上限内でも密度が高い文字起こしは 1 MiB を超えうる。超えたまま書くと終端 commit が失敗し、
 *    ジョブが finalizing のまま「処理中」で固まる（リース切れごとに同じ失敗を繰り返す）。本文優先（B4）で、
 *    review を落とし、それでも超えるなら本文の末尾を省いてでも**必ず終端化する**。
 */
const TRANSCRIPT_TRUNCATION_NOTICE =
    '\n\n---\n（この文字起こしは長すぎて全文を保存できなかったため、ここまでを保存しました。'
    + '全文が必要な場合は、録音を分割してから再度お試しください。）';

/**
 * UTF-8 バイト数で maxBytes 以下に収まる最大の前置きを返す。可能なら行境界（改行）で切る。
 * 多バイト文字を途中で割らない（割れた末尾は継続バイトを後退して落とす）。
 */
function truncateUtf8AtLine(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return text;
    let cut = Math.max(0, Math.min(maxBytes, buf.length));
    // 継続バイト (10xxxxxx) の途中で切らないよう後退する
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
    let sliced = buf.subarray(0, cut).toString('utf8');
    const lastNewline = sliced.lastIndexOf('\n');
    if (lastNewline > 0) sliced = sliced.slice(0, lastNewline);
    return sliced;
}

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
    | {
        kind: 'succeeded';
        transcription: string;
        generatedByModel: string;
        speakers: number;
        /**
         * 要確認候補（設計 B2/B4）。本文・status・job 終端と**同じトランザクション**で文書へ保存する（job には複製しない）。
         * 省略時はフィールドを書かない（旧文書と同じ形）。再確定のたびに呼び出し側が決定的に作り直す（後から append しない）。
         */
        review?: TranscriptReview;
    }
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
        } else if (outcome.kind === 'succeeded') {
            // 🔴 文書全体（既存フィールド＋本文＋review）が 1MiB を超えると終端 commit 自体が失敗し、
            //    ジョブが finalizing のまま「処理中」で固まる（リース切れごとに同じ失敗を繰り返す）。
            //    必ず収まるよう、まず review を落とし（本文優先・B4）、それでも本文だけで超えるなら本文の末尾を省く。
            const budget = FIRESTORE_DOC_LIMIT_BYTES - DOC_WRITE_MARGIN_BYTES;
            const projectedBytes = (body: string, review: TranscriptReview | undefined): number => {
                const projected: Record<string, unknown> = {
                    ...doc,
                    transcription: body,
                    generatedByModel: outcome.generatedByModel,
                    status: 'completed',
                    ...(review !== undefined && { transcriptReview: review }),
                };
                delete projected.processingProgress;
                return Buffer.byteLength(JSON.stringify(projected), 'utf8');
            };

            let reviewToWrite = outcome.review;
            let transcriptionToWrite = outcome.transcription;
            if (reviewToWrite !== undefined && projectedBytes(transcriptionToWrite, reviewToWrite) > budget) {
                logger.warn('文書全体が保存上限に近いため要確認データを省いて本文だけ保存', { docId });
                reviewToWrite = undefined;
            }
            // 🔴 本文以外（title 等）を除いた余地に本文が収まらないときだけ末尾を省く。
            //    超過が本文以外だけで起きているなら、本文を削っても収まらない＝削らない（本文を無駄に失わない）。
            const overheadBytes = projectedBytes('', undefined);
            if (overheadBytes < budget && projectedBytes(transcriptionToWrite, undefined) > budget) {
                // 本文だけで上限を超える。末尾を省いてでも必ず終端化する（finalizing で固めない）。
                let maxBodyBytes = Math.max(
                    0, budget - overheadBytes - Buffer.byteLength(TRANSCRIPT_TRUNCATION_NOTICE, 'utf8'));
                transcriptionToWrite = truncateUtf8AtLine(outcome.transcription, maxBodyBytes) + TRANSCRIPT_TRUNCATION_NOTICE;
                // JSON エスケープ（改行・引用符）で概算を超えることがあるので、収まるまで詰める（有界: 0.9 倍ずつ）
                while (maxBodyBytes > 0 && projectedBytes(transcriptionToWrite, undefined) > budget) {
                    maxBodyBytes = Math.floor(maxBodyBytes * 0.9);
                    transcriptionToWrite = truncateUtf8AtLine(outcome.transcription, maxBodyBytes) + TRANSCRIPT_TRUNCATION_NOTICE;
                }
                reviewToWrite = undefined; // 末尾を省くと候補の行番号がずれるので候補は載せない
                logger.warn('本文が保存上限を超えるため末尾を省いて保存', { docId });
            } else if (overheadBytes >= budget) {
                // 本文以外だけで上限超（例: 極端に長い title）。本文の切り詰めでは収まらない異常ケース。
                logger.warn('本文以外のフィールドだけで保存上限を超えている（本文の切り詰めでは収まらない）', { docId });
            }
            tx.set(docRef, {
                transcription: transcriptionToWrite,
                generatedByModel: outcome.generatedByModel,
                // 書く先は processing 文書だけ（上の分岐）。processing 文書は候補を持たないので merge で旧候補と混ざらない。
                ...(reviewToWrite !== undefined && { transcriptReview: reviewToWrite }),
                status: 'completed' satisfies TranscriptionDocStatus,
                processingProgress: FieldValue.delete(),
                updatedAt,
            }, { merge: true });
        } else {
            tx.set(docRef, {
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

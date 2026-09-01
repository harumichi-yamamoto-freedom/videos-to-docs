/**
 * アカウント削除時の関連データクリーンアップ
 */

import { db } from './firebase';
import {
    collection,
    query,
    where,
    getDocs,
    doc,
    writeBatch,
    type DocumentData,
    type DocumentReference,
} from 'firebase/firestore';
import { logAudit } from './auditLog';
import { createLogger } from './logger';

const accountDeletionLogger = createLogger('accountDeletion');

const DELETE_BATCH_SIZE = 400;

export interface UserDeletionCounts {
    promptCount: number;
    documentCount: number;
    /**
     * 確認時に走査した削除対象。旧呼出側の件数指定との互換性のため optional です。
     * getUserDeletionInfo の成功結果には必ず含まれます。
     */
    readonly targetSnapshot?: UserDeletionTargetSnapshot;
}

export interface UserDeletionTargetSnapshot {
    readonly promptIds: readonly string[];
    readonly documentIds: readonly string[];
    readonly relationshipIds: readonly string[];
}

export type UserDeletionInfo =
    | {
        status: 'success';
        promptCount: UserDeletionCounts['promptCount'];
        documentCount: UserDeletionCounts['documentCount'];
        readonly targetSnapshot: UserDeletionTargetSnapshot;
    }
    | {
        status: 'unavailable';
        readonly promptCount: never;
        readonly documentCount: never;
    };

export type UserDataDeletionFailedStage = 'scan' | 'verification' | 'audit' | 'commit';

interface UserDataDeletionErrorDetails {
    committedBatchCount?: number;
    failedBatchNumber?: number;
    totalBatchCount?: number;
}

/**
 * Firestore データ削除のどの段階で失敗したかを呼び出し側へ残すエラー。
 * commit 失敗時は、再試行時の判断に使えるよう完了済みバッチ数も保持します。
 */
export class UserDataDeletionError extends Error {
    readonly failedStage: UserDataDeletionFailedStage;
    readonly committedBatchCount: number;
    readonly failedBatchNumber?: number;
    readonly totalBatchCount?: number;
    override readonly cause?: unknown;

    constructor(
        message: string,
        failedStage: UserDataDeletionFailedStage,
        details: UserDataDeletionErrorDetails = {},
        cause?: unknown,
    ) {
        super(message);
        this.name = 'UserDataDeletionError';
        this.failedStage = failedStage;
        this.committedBatchCount = details.committedBatchCount ?? 0;
        this.failedBatchNumber = details.failedBatchNumber;
        this.totalBatchCount = details.totalBatchCount;
        this.cause = cause;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** 確認画面の削除対象と削除直前の削除対象が変わり、削除を始めなかったことを表します。 */
export class UserDeletionInfoChangedError extends UserDataDeletionError {
    readonly expectedInfo: UserDeletionCounts;
    readonly currentInfo: Extract<UserDeletionInfo, { status: 'success' }>;

    constructor(
        expectedInfo: UserDeletionCounts,
        currentInfo: Extract<UserDeletionInfo, { status: 'success' }>,
    ) {
        super('削除対象が変更されました。最新の情報を確認してください', 'verification');
        this.name = 'UserDeletionInfoChangedError';
        this.expectedInfo = {
            ...expectedInfo,
            ...(expectedInfo.targetSnapshot
                ? { targetSnapshot: cloneTargetSnapshot(expectedInfo.targetSnapshot) }
                : {}),
        };
        this.currentInfo = {
            ...currentInfo,
            targetSnapshot: cloneTargetSnapshot(currentInfo.targetSnapshot),
        };
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

function cloneTargetSnapshot(
    targetSnapshot: UserDeletionTargetSnapshot,
): UserDeletionTargetSnapshot {
    return {
        promptIds: [...targetSnapshot.promptIds],
        documentIds: [...targetSnapshot.documentIds],
        relationshipIds: [...targetSnapshot.relationshipIds],
    };
}

function uniqueSortedDocumentIds(
    documentSnapshots: readonly { id: string }[],
): string[] {
    return [...new Set(documentSnapshots.map(documentSnapshot => documentSnapshot.id))].sort();
}

function haveSameDocumentIds(
    expectedIds: readonly string[],
    currentIds: readonly string[],
): boolean {
    const expectedIdSet = new Set(expectedIds);
    const currentIdSet = new Set(currentIds);
    return expectedIdSet.size === currentIdSet.size
        && [...expectedIdSet].every(id => currentIdSet.has(id));
}

function deletionTargetsChanged(
    expectedInfo: UserDeletionCounts,
    currentInfo: Extract<UserDeletionInfo, { status: 'success' }>,
): boolean {
    if (
        expectedInfo.promptCount !== currentInfo.promptCount
        || expectedInfo.documentCount !== currentInfo.documentCount
    ) {
        return true;
    }

    // snapshot を持たない旧呼出側は従来どおり件数のみで照合します。
    const expectedSnapshot = expectedInfo.targetSnapshot;
    if (!expectedSnapshot) return false;

    const currentSnapshot = currentInfo.targetSnapshot;
    return !haveSameDocumentIds(expectedSnapshot.promptIds, currentSnapshot.promptIds)
        || !haveSameDocumentIds(expectedSnapshot.documentIds, currentSnapshot.documentIds)
        || !haveSameDocumentIds(
            expectedSnapshot.relationshipIds,
            currentSnapshot.relationshipIds,
        );
}

function createUnavailableDeletionInfo(): Extract<UserDeletionInfo, { status: 'unavailable' }> {
    const unavailableInfo = { status: 'unavailable' } as Extract<
        UserDeletionInfo,
        { status: 'unavailable' }
    >;
    // 未所有の旧呼出側が status を確認せず件数へ触れても、削除準備を fail-closed にします。
    const throwUnavailable = () => {
        throw new Error('削除対象件数を取得できませんでした');
    };

    Object.defineProperties(unavailableInfo, {
        promptCount: { enumerable: false, get: throwUnavailable },
        documentCount: { enumerable: false, get: throwUnavailable },
    });
    return unavailableInfo;
}

async function scanUserDeletionTargets(userId: string) {
    const promptsQuery = query(
        collection(db, 'prompts'),
        where('ownerId', '==', userId),
    );
    const transcriptionsQuery = query(
        collection(db, 'transcriptions'),
        where('ownerId', '==', userId),
    );
    const relationshipsCol = collection(db, 'relationships');
    const supervisorQuery = query(relationshipsCol, where('supervisorId', '==', userId));
    const subordinateQuery = query(relationshipsCol, where('subordinateId', '==', userId));

    const [
        promptsSnapshot,
        transcriptionsSnapshot,
        supervisorSnapshot,
        subordinateSnapshot,
    ] = await Promise.all([
        getDocs(promptsQuery),
        getDocs(transcriptionsQuery),
        getDocs(supervisorQuery),
        getDocs(subordinateQuery),
    ]);

    const relationshipRefs = new Map<string, DocumentReference<DocumentData>>();
    for (const documentSnapshot of supervisorSnapshot.docs) {
        relationshipRefs.set(documentSnapshot.id, documentSnapshot.ref);
    }
    for (const documentSnapshot of subordinateSnapshot.docs) {
        relationshipRefs.set(documentSnapshot.id, documentSnapshot.ref);
    }

    const targetSnapshot: UserDeletionTargetSnapshot = {
        promptIds: uniqueSortedDocumentIds(promptsSnapshot.docs),
        documentIds: uniqueSortedDocumentIds(transcriptionsSnapshot.docs),
        relationshipIds: [...relationshipRefs.keys()].sort(),
    };
    const info: Extract<UserDeletionInfo, { status: 'success' }> = {
        status: 'success',
        promptCount: targetSnapshot.promptIds.length,
        documentCount: targetSnapshot.documentIds.length,
        targetSnapshot,
    };

    return {
        promptsSnapshot,
        transcriptionsSnapshot,
        relationshipRefs,
        info,
    };
}

/**
 * アカウント削除対象のFirestoreデータを削除
 */
export async function deleteUserData(
    userId: string,
    userEmail?: string,
    expectedCounts?: UserDeletionCounts,
): Promise<void> {
    try {
        accountDeletionLogger.info('ユーザー関連データの削除を開始', { userId });

        // 確認後に作成されたデータを取りこぼさないよう、削除直前に全対象を再走査します。
        // ここで得た snapshot を件数確認と実削除の両方に用い、両者の時間差を最小化します。
        let deletionScan: Awaited<ReturnType<typeof scanUserDeletionTargets>>;
        try {
            deletionScan = await scanUserDeletionTargets(userId);
        } catch (error) {
            throw new UserDataDeletionError(
                '削除対象の再走査に失敗しました',
                'scan',
                {},
                error,
            );
        }

        const {
            promptsSnapshot,
            transcriptionsSnapshot,
            relationshipRefs,
            info: currentInfo,
        } = deletionScan;

        if (expectedCounts && deletionTargetsChanged(expectedCounts, currentInfo)) {
            throw new UserDeletionInfoChangedError(expectedCounts, currentInfo);
        }

        accountDeletionLogger.info('プロンプトと文書の削除対象を検出', {
            userId,
            prompts: currentInfo.promptCount,
            documents: currentInfo.documentCount,
        });

        accountDeletionLogger.info('リレーションシップの削除対象を検出', {
            userId,
            relationships: relationshipRefs.size,
        });

        try {
            await logAudit('user_delete', 'user', userId, {
                userEmail: userEmail || '',
                dataCleanup: true,
            });
        } catch (error) {
            throw new UserDataDeletionError(
                '削除前の監査ログ記録に失敗しました',
                'audit',
                {},
                error,
            );
        }

        const userRef = doc(db, 'users', userId);
        const deletionRefs: DocumentReference<DocumentData>[] = [
            ...promptsSnapshot.docs.map(documentSnapshot => documentSnapshot.ref),
            ...transcriptionsSnapshot.docs.map(documentSnapshot => documentSnapshot.ref),
            ...relationshipRefs.values(),
            userRef,
        ];
        const totalBatchCount = Math.ceil(deletionRefs.length / DELETE_BATCH_SIZE);

        for (let batchIndex = 0; batchIndex < totalBatchCount; batchIndex += 1) {
            const batchNumber = batchIndex + 1;
            try {
                const batch = writeBatch(db);
                const batchStart = batchIndex * DELETE_BATCH_SIZE;
                const batchRefs = deletionRefs.slice(batchStart, batchStart + DELETE_BATCH_SIZE);
                for (const documentRef of batchRefs) {
                    batch.delete(documentRef);
                }
                await batch.commit();
            } catch (error) {
                throw new UserDataDeletionError(
                    `関連データの削除バッチ ${batchNumber}/${totalBatchCount} に失敗しました`,
                    'commit',
                    {
                        committedBatchCount: batchIndex,
                        failedBatchNumber: batchNumber,
                        totalBatchCount,
                    },
                    error,
                );
            }
        }

        accountDeletionLogger.info('関連データの削除が完了', {
            userId,
            totalDeleted: deletionRefs.length,
            batchCount: totalBatchCount,
        });
    } catch (error) {
        const deletionError = error instanceof UserDataDeletionError
            ? error
            : new UserDataDeletionError(
                '関連データの削除に失敗しました',
                'scan',
                {},
                error,
            );
        accountDeletionLogger.error('ユーザー関連データの削除に失敗', deletionError, {
            userId,
            failedStage: deletionError.failedStage,
            committedBatchCount: deletionError.committedBatchCount,
            failedBatchNumber: deletionError.failedBatchNumber,
            totalBatchCount: deletionError.totalBatchCount,
        });
        throw deletionError;
    }
}

/**
 * アカウント削除前の確認情報を取得
 */
export async function getUserDeletionInfo(userId: string): Promise<UserDeletionInfo> {
    try {
        const { info } = await scanUserDeletionTargets(userId);
        return info;
    } catch (error) {
        accountDeletionLogger.error('削除前情報の取得に失敗', error, { userId });
        return createUnavailableDeletionInfo();
    }
}

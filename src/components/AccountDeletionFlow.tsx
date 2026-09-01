'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import { auth } from '../lib/firebase';
import {
    deleteUserData,
    getUserDeletionInfo,
    UserDataDeletionError,
    UserDeletionInfoChangedError,
    type UserDataDeletionFailedStage,
    type UserDeletionCounts,
    type UserDeletionInfo,
} from '../lib/accountDeletion';
import { createLogger } from '../lib/logger';
import ReauthModal, { type ReauthenticationCloseReason } from './ReauthModal';

const accountDeletionFlowLogger = createLogger('AccountDeletionFlow');

export type AccountDeletionFailedStage =
    | 'confirmation'
    | 'data'
    | UserDataDeletionFailedStage
    | 'auth'
    | null;

export interface AccountDeletionResult {
    dataDeleted: boolean;
    authDeleted: boolean;
    failedStage: AccountDeletionFailedStage;
    committedBatchCount?: number;
    failedBatchNumber?: number;
    totalBatchCount?: number;
    latestDeletionInfo?: Extract<UserDeletionInfo, { status: 'success' }>;
}

interface DeletionTarget {
    uid: string;
    email?: string;
}

type FlowState =
    | { kind: 'closed' }
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | {
        kind: 'confirmation';
        info: Extract<UserDeletionInfo, { status: 'success' }>;
        deletionTargetsChanged?: boolean;
    }
    | {
        kind: 'reauth';
        confirmedInfo: Extract<UserDeletionInfo, { status: 'success' }>;
        deletionInProgress: boolean;
    }
    | { kind: 'result'; result: AccountDeletionResult };

export type AccountDeletionFlowDisposition = 'show' | 'wait' | 'invalidate' | 'closed';

export function shouldCloseAccountDeletionFlow(
    reason: ReauthenticationCloseReason,
): boolean {
    return reason === 'dismiss';
}

interface AccountDeletionFlowContext {
    phase: FlowState['kind'];
    deletionInProgress: boolean;
    result: AccountDeletionResult | null;
    targetUserId: string | null;
    userId: string | null;
    authenticatedUserId: string | null;
}

export function getAccountDeletionFlowDisposition({
    phase,
    deletionInProgress,
    result,
    targetUserId,
    userId,
    authenticatedUserId,
}: AccountDeletionFlowContext): AccountDeletionFlowDisposition {
    if (phase === 'closed') return 'closed';
    if (!targetUserId) return 'invalidate';

    const userChanged = userId !== null && userId !== targetUserId;
    const authenticatedUserChanged = authenticatedUserId !== null
        && authenticatedUserId !== targetUserId;
    if (userChanged || authenticatedUserChanged) return 'invalidate';

    if (phase === 'result') {
        if (result?.authDeleted) {
            if (userId === null && authenticatedUserId === null) return 'show';
            if (userId === targetUserId && authenticatedUserId === null) return 'wait';
            return 'invalidate';
        }

        return userId === targetUserId && authenticatedUserId === targetUserId
            ? 'show'
            : 'invalidate';
    }

    if (deletionInProgress) {
        if (userId === targetUserId && authenticatedUserId === targetUserId) return 'show';
        return 'wait';
    }

    return userId === targetUserId && authenticatedUserId === targetUserId
        ? 'show'
        : 'invalidate';
}

export async function deleteAccountInStages(
    userId: string,
    userEmail?: string,
    expectedCounts?: UserDeletionCounts,
): Promise<AccountDeletionResult> {
    const initialResult: AccountDeletionResult = {
        dataDeleted: false,
        authDeleted: false,
        failedStage: 'data',
    };
    const currentUser = auth.currentUser;

    if (!currentUser || currentUser.uid !== userId) {
        accountDeletionFlowLogger.error('削除対象の認証ユーザーを確認できません', undefined, {
            userId,
        });
        return initialResult;
    }

    try {
        await currentUser.getIdToken(true);
    } catch (error) {
        accountDeletionFlowLogger.error('アカウント削除前の認証トークン更新に失敗', error, {
            userId,
        });
        return initialResult;
    }

    try {
        await deleteUserData(userId, userEmail, expectedCounts);
    } catch (error) {
        if (error instanceof UserDeletionInfoChangedError) {
            accountDeletionFlowLogger.info('削除対象の変更を検出したため再確認を要求', {
                userId,
                expectedInfo: error.expectedInfo,
                currentInfo: error.currentInfo,
            });
            return {
                dataDeleted: false,
                authDeleted: false,
                failedStage: 'confirmation',
                latestDeletionInfo: error.currentInfo,
            };
        }

        if (error instanceof UserDataDeletionError) {
            accountDeletionFlowLogger.error('アカウント関連データの削除に失敗', error, {
                userId,
                failedStage: error.failedStage,
                committedBatchCount: error.committedBatchCount,
                failedBatchNumber: error.failedBatchNumber,
                totalBatchCount: error.totalBatchCount,
            });
            return {
                dataDeleted: false,
                authDeleted: false,
                failedStage: error.failedStage,
                committedBatchCount: error.committedBatchCount,
                ...(error.failedBatchNumber === undefined
                    ? {}
                    : { failedBatchNumber: error.failedBatchNumber }),
                ...(error.totalBatchCount === undefined
                    ? {}
                    : { totalBatchCount: error.totalBatchCount }),
            };
        }

        accountDeletionFlowLogger.error('アカウント関連データの削除に失敗', error, {
            userId,
        });
        return initialResult;
    }

    const dataDeletedResult: AccountDeletionResult = {
        dataDeleted: true,
        authDeleted: false,
        failedStage: 'auth',
    };
    const authenticatedUser = auth.currentUser;

    if (!authenticatedUser || authenticatedUser.uid !== userId) {
        accountDeletionFlowLogger.error('データ削除後に認証ユーザーを確認できません', undefined, {
            userId,
        });
        return dataDeletedResult;
    }

    try {
        await authenticatedUser.delete();
        accountDeletionFlowLogger.info('アカウント削除が完了', { userId });
        return {
            dataDeleted: true,
            authDeleted: true,
            failedStage: null,
        };
    } catch (error) {
        accountDeletionFlowLogger.error('データ削除後の認証アカウント削除に失敗', error, {
            userId,
        });
        return dataDeletedResult;
    }
}

interface DialogFrameProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
}

function DialogFrame({ title, onClose, children }: DialogFrameProps) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="account-deletion-dialog-title"
                className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
            >
                <div className="mb-4 flex items-start justify-between gap-4">
                    <h2 id="account-deletion-dialog-title" className="text-xl font-bold text-red-700">
                        {title}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="アカウント削除画面を閉じる"
                        className="shrink-0 text-gray-500 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                        ✕
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

interface RemainingDataProps {
    resultView?: boolean;
}

function RemainingData({ resultView = false }: RemainingDataProps) {
    return (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <h3 className="font-semibold text-amber-900">
                {resultView ? 'この操作で削除されていないもの' : 'この操作後も残るもの'}
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                <li>Firebase Storage に保存された音声ファイル</li>
                <li>操作履歴として保存された監査ログ</li>
                <li>お知らせの確認状態</li>
            </ul>
        </div>
    );
}

interface DataDeletionResultPresentation {
    message: string;
    status: string;
    partiallyDeleted: boolean;
}

function getDataDeletionResultPresentation(
    result: AccountDeletionResult,
): DataDeletionResultPresentation {
    if (result.dataDeleted) {
        return {
            message: result.authDeleted
                ? 'Firestore の対象データとログイン用アカウントを削除しました。'
                : 'プロフィール、プロンプト、文書、チーム関係は削除しましたが、ログイン用アカウントを削除できませんでした。',
            status: '削除済み',
            partiallyDeleted: false,
        };
    }

    const committedBatchCount = result.committedBatchCount ?? 0;
    if (result.failedStage === 'commit' && committedBatchCount > 0) {
        const failedBatch = result.failedBatchNumber
            ? `第${result.failedBatchNumber}バッチ${result.totalBatchCount ? `（全${result.totalBatchCount}バッチ）` : ''}`
            : '後続バッチ';
        return {
            message: `Firestore の対象データは${committedBatchCount}バッチ分が削除済みです。${failedBatch}で削除処理に失敗し、残りの対象データは削除完了を確認できませんでした。ログイン用アカウントの削除は実行していません。`,
            status: `一部削除済み（${committedBatchCount}バッチ）`,
            partiallyDeleted: true,
        };
    }

    if (result.failedStage === 'commit') {
        const failedBatch = result.failedBatchNumber
            ? `第${result.failedBatchNumber}バッチ${result.totalBatchCount ? `（全${result.totalBatchCount}バッチ）` : ''}`
            : '削除バッチ';
        return {
            message: `Firestore の削除は${failedBatch}で失敗しました。完了を確認できた削除バッチはありません。ログイン用アカウントの削除は実行していません。`,
            status: '完了確認済みバッチなし',
            partiallyDeleted: false,
        };
    }

    const failureBeforeCommit = result.failedStage === 'scan'
        ? {
            reason: '削除対象の再走査に失敗したため',
            status: '削除バッチ未開始（再走査で失敗）',
        }
        : result.failedStage === 'audit'
            ? {
                reason: '削除前の監査ログ記録に失敗したため',
                status: '削除バッチ未開始（監査記録で失敗）',
            }
            : result.failedStage === 'verification' || result.failedStage === 'confirmation'
                ? {
                    reason: '削除対象の再確認を完了できなかったため',
                    status: '削除バッチ未開始（再確認で中断）',
                }
                : {
                    reason: 'Firestore の削除処理を開始できなかったため',
                    status: '削除バッチ未開始',
                };

    return {
        message: `${failureBeforeCommit.reason}、削除バッチとログイン用アカウントの削除は実行していません。`,
        status: failureBeforeCommit.status,
        partiallyDeleted: false,
    };
}

export function useAccountDeletionFlow(user: User | null) {
    const [flowState, setFlowState] = useState<FlowState>({ kind: 'closed' });
    const [confirmationText, setConfirmationText] = useState('');
    const [targetUserId, setTargetUserId] = useState<string | null>(null);
    const targetRef = useRef<DeletionTarget | null>(null);
    const operationTokenRef = useRef(0);

    const closeFlow = useCallback(() => {
        operationTokenRef.current += 1;
        targetRef.current = null;
        setTargetUserId(null);
        setConfirmationText('');
        setFlowState({ kind: 'closed' });
    }, []);

    const loadDeletionInfo = useCallback(async (target: DeletionTarget) => {
        const operationToken = operationTokenRef.current + 1;
        operationTokenRef.current = operationToken;
        setConfirmationText('');
        setFlowState({ kind: 'loading' });

        try {
            const info = await getUserDeletionInfo(target.uid);
            if (operationTokenRef.current !== operationToken) return;

            if (info.status === 'unavailable') {
                setFlowState({ kind: 'unavailable' });
                return;
            }

            setFlowState({ kind: 'confirmation', info });
        } catch (error) {
            if (operationTokenRef.current !== operationToken) return;

            accountDeletionFlowLogger.error('削除対象情報の取得に失敗', error, {
                userId: target.uid,
            });
            setFlowState({ kind: 'unavailable' });
        }
    }, []);

    const beginAccountDeletion = useCallback(async () => {
        if (!user) return;

        const target: DeletionTarget = {
            uid: user.uid,
            email: user.email || undefined,
        };
        targetRef.current = target;
        setTargetUserId(target.uid);
        await loadDeletionInfo(target);
    }, [loadDeletionInfo, user]);

    const retryDeletionInfo = () => {
        const target = targetRef.current;
        if (!target) {
            closeFlow();
            return;
        }

        void loadDeletionInfo(target);
    };

    const proceedToReauthentication = () => {
        if (confirmationText !== '削除' || flowState.kind !== 'confirmation') return;
        setFlowState({
            kind: 'reauth',
            confirmedInfo: flowState.info,
            deletionInProgress: false,
        });
    };

    const handleReauthenticationClose = (reason: ReauthenticationCloseReason) => {
        if (shouldCloseAccountDeletionFlow(reason)) {
            closeFlow();
        }
    };

    const handleReauthenticationSuccess = async () => {
        const target = targetRef.current;
        if (!target || flowState.kind !== 'reauth' || flowState.deletionInProgress) return;

        const confirmedInfo = flowState.confirmedInfo;
        setFlowState({
            kind: 'reauth',
            confirmedInfo,
            deletionInProgress: true,
        });

        const operationToken = operationTokenRef.current + 1;
        operationTokenRef.current = operationToken;
        const result = await deleteAccountInStages(target.uid, target.email, confirmedInfo);

        if (operationTokenRef.current === operationToken) {
            if (result.failedStage === 'confirmation' && result.latestDeletionInfo) {
                setConfirmationText('');
                setFlowState({
                    kind: 'confirmation',
                    info: result.latestDeletionInfo,
                    deletionTargetsChanged: true,
                });
                return;
            }
            setFlowState({ kind: 'result', result });
        }
    };

    const retryAfterResult = () => {
        if (flowState.kind !== 'result') return;
        // Auth 削除だけが失敗していても、再試行までに作成されたデータを拾うため必ず再走査します。
        retryDeletionInfo();
    };

    const deletionInProgress = flowState.kind === 'reauth'
        && flowState.deletionInProgress;
    const flowResult = flowState.kind === 'result' ? flowState.result : null;
    const flowDisposition = getAccountDeletionFlowDisposition({
        phase: flowState.kind,
        deletionInProgress,
        result: flowResult,
        targetUserId,
        userId: user?.uid ?? null,
        authenticatedUserId: auth.currentUser?.uid ?? null,
    });

    useEffect(() => {
        if (flowDisposition !== 'invalidate') return;

        queueMicrotask(closeFlow);
    }, [closeFlow, flowDisposition]);

    let accountDeletionDialog: ReactNode = null;

    if (flowDisposition !== 'show') {
        accountDeletionDialog = null;
    } else if (flowState.kind === 'loading') {
        accountDeletionDialog = (
            <DialogFrame title="削除対象を確認しています" onClose={closeFlow}>
                <p role="status" className="text-sm text-gray-700">
                    安全に削除できる状態か確認しています。しばらくお待ちください。
                </p>
                <button
                    type="button"
                    onClick={closeFlow}
                    className="mt-6 w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-700 transition-colors hover:bg-gray-50"
                >
                    キャンセル
                </button>
            </DialogFrame>
        );
    } else if (flowState.kind === 'unavailable') {
        accountDeletionDialog = (
            <DialogFrame title="削除対象を確認できませんでした" onClose={closeFlow}>
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                    安全のため削除は開始していません。通信状態を確認して、もう一度お試しください。
                </div>
                <div className="mt-6 flex gap-3">
                    <button
                        type="button"
                        onClick={closeFlow}
                        className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-gray-700 transition-colors hover:bg-gray-50"
                    >
                        キャンセル
                    </button>
                    <button
                        type="button"
                        onClick={retryDeletionInfo}
                        className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
                    >
                        再試行
                    </button>
                </div>
            </DialogFrame>
        );
    } else if (flowState.kind === 'confirmation') {
        accountDeletionDialog = (
            <DialogFrame title="アカウント削除の確認" onClose={closeFlow}>
                {flowState.deletionTargetsChanged && (
                    <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                        削除対象が確認後に変わりました。最新の削除対象を確認し、もう一度「削除」と入力してください。
                    </div>
                )}
                <p className="text-sm text-gray-700">
                    この操作は取り消せません。削除対象と残るデータを確認してください。
                </p>

                <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
                    <h3 className="font-semibold text-red-900">削除されるもの</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-900">
                        <li>ログイン用アカウント</li>
                        <li>Firestore のユーザープロフィール</li>
                        <li>所有しているプロンプト {flowState.info.promptCount}件</li>
                        <li>所有している文書 {flowState.info.documentCount}件</li>
                        <li>上司・部下として登録されたチーム関係</li>
                    </ul>
                </div>

                <div className="mt-3">
                    <RemainingData />
                </div>

                <label htmlFor="account-deletion-confirmation" className="mt-5 block text-sm font-medium text-gray-800">
                    削除するには「削除」と入力してください。
                </label>
                <input
                    id="account-deletion-confirmation"
                    type="text"
                    value={confirmationText}
                    onChange={event => setConfirmationText(event.target.value)}
                    autoComplete="off"
                    className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
                />

                <div className="mt-6 flex gap-3">
                    <button
                        type="button"
                        onClick={closeFlow}
                        className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-gray-700 transition-colors hover:bg-gray-50"
                    >
                        キャンセル
                    </button>
                    <button
                        type="button"
                        onClick={proceedToReauthentication}
                        disabled={confirmationText !== '削除'}
                        className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                    >
                        再認証へ進む
                    </button>
                </div>
            </DialogFrame>
        );
    } else if (flowState.kind === 'reauth') {
        accountDeletionDialog = (
            <ReauthModal
                isOpen
                onClose={handleReauthenticationClose}
                onSuccess={handleReauthenticationSuccess}
            />
        );
    } else if (flowState.kind === 'result') {
        const { result } = flowState;
        const completed = result.dataDeleted && result.authDeleted;
        const dataPresentation = getDataDeletionResultPresentation(result);
        const partiallyCompleted = (result.dataDeleted && !result.authDeleted)
            || dataPresentation.partiallyDeleted;
        const resultTitle = completed
            ? 'アカウント削除が完了しました'
            : dataPresentation.partiallyDeleted
                ? '対象データの一部のみ削除されました'
                : partiallyCompleted
                    ? 'アカウントの一部のみ削除されました'
                    : 'アカウントを削除できませんでした';

        accountDeletionDialog = (
            <DialogFrame
                title={resultTitle}
                onClose={closeFlow}
            >
                <div
                    role="status"
                    className={`rounded-lg border p-4 text-sm ${completed
                        ? 'border-green-200 bg-green-50 text-green-900'
                        : partiallyCompleted
                            ? 'border-amber-200 bg-amber-50 text-amber-900'
                            : 'border-red-200 bg-red-50 text-red-800'
                        }`}
                >
                    {dataPresentation.message}
                </div>

                <dl className="mt-4 divide-y divide-gray-200 rounded-lg border border-gray-200 text-sm">
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <dt className="text-gray-700">Firestore の対象データ</dt>
                        <dd className={result.dataDeleted
                            ? 'font-semibold text-green-700'
                            : dataPresentation.partiallyDeleted
                                ? 'font-semibold text-amber-700'
                                : 'font-semibold text-red-700'}
                        >
                            {dataPresentation.status}
                        </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <dt className="text-gray-700">ログイン用アカウント</dt>
                        <dd className={result.authDeleted ? 'font-semibold text-green-700' : 'font-semibold text-red-700'}>
                            {result.authDeleted
                                ? '削除済み'
                                : result.failedStage === 'auth'
                                    ? '削除に失敗'
                                    : '削除は未実行'}
                        </dd>
                    </div>
                </dl>

                <div className="mt-3">
                    <RemainingData resultView />
                </div>

                <div className="mt-6 flex gap-3">
                    {!completed && (
                        <button
                            type="button"
                            onClick={retryAfterResult}
                            className="flex-1 rounded-lg border border-red-300 px-4 py-2 text-red-700 transition-colors hover:bg-red-50"
                        >
                            削除対象を再確認
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={closeFlow}
                        className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-white transition-colors hover:bg-gray-800"
                    >
                        閉じる
                    </button>
                </div>
            </DialogFrame>
        );
    }

    return { beginAccountDeletion, accountDeletionDialog };
}

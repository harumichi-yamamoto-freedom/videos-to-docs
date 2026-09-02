'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { Timestamp } from 'firebase/firestore';
import { Prompt, getPromptsByOwnerId } from '@/lib/prompts';
import { Transcription, getTranscriptionsByOwnerId } from '@/lib/firestore';
import {
    Relationship,
    fetchSubordinateRelationships,
    fetchSupervisorRelationships,
    requestSupervisorRelationship,
    approveRelationship,
    rejectRelationship,
    removeSubordinate,
    cancelRelationshipAsSubordinate,
    isLegacyRelationship,
} from '@/lib/relationships';
import { Inbox, Loader2 } from 'lucide-react';
import { ContentEditModal } from '@/components/ContentEditModal';
import AuthModal from '@/components/AuthModal';
import { Button } from '@/components/ui/Button';
import { SIGN_IN_LABEL } from '@/components/ui/labels';
import { createLogger } from '@/lib/logger';

interface TeamPanelProps {
    user: User | null;
    view: 'subordinates' | 'supervisors';
    /** 認証状態の確定前(true)はログイン誘導を出さずに待機表示にする */
    authLoading?: boolean;
}

const teamPanelLogger = createLogger('TeamPanel');

type ResourceStatus = 'loading' | 'success' | 'error';

interface LaneResource<T> {
    status: ResourceStatus;
    data: T[];
}

type RelationshipLane = 'subordinates' | 'subordinateRequests' | 'supervisors' | 'supervisorRequests';

const RELATIONSHIP_LANES: RelationshipLane[] = [
    'subordinates',
    'subordinateRequests',
    'supervisors',
    'supervisorRequests',
];

const RELATIONSHIP_FETCHERS: Record<RelationshipLane, (uid: string) => Promise<Relationship[]>> = {
    subordinates: (uid) => fetchSubordinateRelationships(uid, 'approved'),
    subordinateRequests: (uid) => fetchSubordinateRelationships(uid, 'pending'),
    supervisors: (uid) => fetchSupervisorRelationships(uid, 'approved'),
    supervisorRequests: (uid) => fetchSupervisorRelationships(uid, 'pending'),
};

const RELATIONSHIP_LANE_ERROR: Record<RelationshipLane, string> = {
    subordinates: '部下一覧の取得に失敗しました。',
    subordinateRequests: '申請一覧の取得に失敗しました。',
    supervisors: '上司一覧の取得に失敗しました。',
    supervisorRequests: '申請状況の取得に失敗しました。',
};

function initialRelationshipLanes(): Record<RelationshipLane, LaneResource<Relationship>> {
    return {
        subordinates: { status: 'loading', data: [] },
        subordinateRequests: { status: 'loading', data: [] },
        supervisors: { status: 'loading', data: [] },
        supervisorRequests: { status: 'loading', data: [] },
    };
}

const EMPTY_DETAIL_LANE = { status: 'success' as ResourceStatus, data: [] };

const LaneSpinner: React.FC<{ label?: string }> = ({ label = '読み込み中...' }) => (
    <div role="status" className="flex items-center justify-center py-8 text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        {label}
    </div>
);

const LaneError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
    <div role="alert" className="py-6 text-center">
        <p className="text-sm text-red-600">{message}</p>
        <div className="mt-3 flex justify-center">
            <Button variant="secondary" onClick={onRetry}>
                再試行
            </Button>
        </div>
    </div>
);

export const TeamPanel: React.FC<TeamPanelProps> = ({ user, view, authLoading = false }) => {
    const [relationshipLanes, setRelationshipLanes] = useState(initialRelationshipLanes);
    const [subordinatePrompts, setSubordinatePrompts] = useState<LaneResource<Prompt>>(EMPTY_DETAIL_LANE);
    const [subordinateDocuments, setSubordinateDocuments] = useState<LaneResource<Transcription>>(EMPTY_DETAIL_LANE);
    const [selectedSubordinateId, setSelectedSubordinateId] = useState<string | null>(null);
    const [sectionErrors, setSectionErrors] = useState<Partial<Record<RelationshipLane, string>>>({});
    const [supervisorFormNotice, setSupervisorFormNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
    const [supervisorEmailInput, setSupervisorEmailInput] = useState('');
    const [isSubmittingSupervisor, setIsSubmittingSupervisor] = useState(false);
    const [promptModal, setPromptModal] = useState<Prompt | null>(null);
    const [documentModal, setDocumentModal] = useState<Transcription | null>(null);
    const [showAuthModal, setShowAuthModal] = useState(false);

    /* 世代トークン: UID切替(relationshipWorld)・部下切替(detailWorld)のたびに
       新しいオブジェクトを作り、応答の採否は「開始時に掴んだトークンが今も現行か」
       (同一性)で照合する。トークンには対象uidも刻む — await から戻ってきた
       古いハンドラ閉包が世代refを「読み直す」と現行トークンを掴めてしまうため、
       閉包側のuidとトークンのuidの一致を入口で要求し、旧closure経由の再取得を
       単なる照合すり抜けにさせない。 */
    const relationshipWorldRef = useRef<{ uid: string | null }>({ uid: null });
    const detailWorldRef = useRef<{ subordinateUid: string | null }>({ subordinateUid: null });
    const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);

    const activeUid = user?.uid ?? null;

    const loadRelationshipLane = useCallback(
        async (lane: RelationshipLane, uid: string, world: { uid: string | null }) => {
            // 旧closure検出: このトークンが担うuidと引数uidが食い違う呼出は何もしない
            if (world !== relationshipWorldRef.current || world.uid !== uid) return;
            setRelationshipLanes((prev) => ({ ...prev, [lane]: { status: 'loading', data: prev[lane].data } }));
            try {
                const data = await RELATIONSHIP_FETCHERS[lane](uid);
                if (world !== relationshipWorldRef.current) return;
                setRelationshipLanes((prev) => ({ ...prev, [lane]: { status: 'success', data } }));
            } catch (error) {
                teamPanelLogger.error('チーム情報の取得に失敗', error, { lane, userId: uid });
                if (world !== relationshipWorldRef.current) return;
                setRelationshipLanes((prev) => ({ ...prev, [lane]: { status: 'error', data: [] } }));
            }
        },
        [],
    );

    /* 4レーンは個別に settle させる(allSettled)。1本の失敗が他レーンの
       取得済みデータを道連れにしない。 */
    useEffect(() => {
        const world = { uid: activeUid };
        relationshipWorldRef.current = world;
        setSelectedSubordinateId(null);
        setSectionErrors({});
        setSupervisorFormNotice(null);
        setRelationshipLanes(initialRelationshipLanes());
        if (!activeUid) return;
        void Promise.allSettled(
            RELATIONSHIP_LANES.map((lane) => loadRelationshipLane(lane, activeUid, world)),
        );
    }, [activeUid, loadRelationshipLane]);

    const reloadRelationshipLanes = useCallback(
        (lanes: RelationshipLane[]) => {
            if (!activeUid) return;
            // 現行トークンを渡す。閉包の activeUid が古い場合(操作 await 中のUID切替)、
            // loadRelationshipLane の入口照合(world.uid !== uid)で棄却される。
            const world = relationshipWorldRef.current;
            setSectionErrors((prev) => {
                const next = { ...prev };
                lanes.forEach((lane) => delete next[lane]);
                return next;
            });
            void Promise.allSettled(lanes.map((lane) => loadRelationshipLane(lane, activeUid, world)));
        },
        [activeUid, loadRelationshipLane],
    );

    /* 選択はIDで持ち、実体は常に最新の部下一覧から引き直す。
       一覧の更新で消えた部下が選択されたまま残らない。 */
    const selectedSubordinate = selectedSubordinateId
        ? relationshipLanes.subordinates.data.find((rel) => rel.id === selectedSubordinateId) ?? null
        : null;
    /* 旧形式(ランダムID)の関係は Rules のアドレス解決に掛からず、詳細取得が
       必ず permission-denied になる。fetch する前にゲートし(uid を null に落とす)、
       詳細側では再試行の行き止まりではなく説明を出す。 */
    const selectedIsLegacy = selectedSubordinate ? isLegacyRelationship(selectedSubordinate) : false;
    const selectedSubordinateUid =
        selectedSubordinate && !selectedIsLegacy ? selectedSubordinate.subordinateId : null;

    const loadPromptsLane = useCallback(
        async (subordinateUid: string, world: { subordinateUid: string | null }) => {
            if (world !== detailWorldRef.current || world.subordinateUid !== subordinateUid) return;
            setSubordinatePrompts({ status: 'loading', data: [] });
            try {
                const data = await getPromptsByOwnerId(subordinateUid);
                if (world !== detailWorldRef.current) return;
                setSubordinatePrompts({ status: 'success', data });
            } catch (error) {
                teamPanelLogger.error('部下プロンプトの取得に失敗', error, { subordinateId: subordinateUid });
                if (world !== detailWorldRef.current) return;
                setSubordinatePrompts({ status: 'error', data: [] });
            }
        },
        [],
    );

    const loadDocumentsLane = useCallback(
        async (subordinateUid: string, world: { subordinateUid: string | null }) => {
            if (world !== detailWorldRef.current || world.subordinateUid !== subordinateUid) return;
            setSubordinateDocuments({ status: 'loading', data: [] });
            try {
                const data = await getTranscriptionsByOwnerId(subordinateUid, 50);
                if (world !== detailWorldRef.current) return;
                setSubordinateDocuments({ status: 'success', data });
            } catch (error) {
                teamPanelLogger.error('部下文書の取得に失敗', error, { subordinateId: subordinateUid });
                if (world !== detailWorldRef.current) return;
                setSubordinateDocuments({ status: 'error', data: [] });
            }
        },
        [],
    );

    useEffect(() => {
        const world = { subordinateUid: selectedSubordinateUid };
        detailWorldRef.current = world;
        if (!selectedSubordinateUid) {
            setSubordinatePrompts(EMPTY_DETAIL_LANE);
            setSubordinateDocuments(EMPTY_DETAIL_LANE);
            return;
        }
        void Promise.allSettled([
            loadPromptsLane(selectedSubordinateUid, world),
            loadDocumentsLane(selectedSubordinateUid, world),
        ]);
    }, [selectedSubordinateUid, loadPromptsLane, loadDocumentsLane]);

    /* xl(1280px)未満では一覧と詳細が縦積みになるため、部下を選択したら
       詳細見出しへスクロールし、フォーカスも移す。 */
    useEffect(() => {
        if (!selectedSubordinateId) return;
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        if (window.matchMedia('(min-width: 1280px)').matches) return;
        const heading = detailHeadingRef.current;
        if (!heading) return;
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        heading.focus({ preventScroll: true });
    }, [selectedSubordinateId]);

    const setSectionError = (lane: RelationshipLane, message: string) => {
        setSectionErrors((prev) => ({ ...prev, [lane]: message }));
    };

    const clearSectionError = (lane: RelationshipLane) => {
        setSectionErrors((prev) => {
            if (!(lane in prev)) return prev;
            const next = { ...prev };
            delete next[lane];
            return next;
        });
    };

    const handleApproveRequest = async (relationshipId: string) => {
        if (!user?.uid) return;
        clearSectionError('subordinateRequests');
        try {
            await approveRelationship(relationshipId, user.uid);
            reloadRelationshipLanes(['subordinates', 'subordinateRequests']);
        } catch (error) {
            teamPanelLogger.error('部下申請の承認に失敗', error, { relationshipId });
            setSectionError('subordinateRequests', '申請の承認に失敗しました。時間をおいて再度お試しください。');
        }
    };

    const handleRejectRequest = async (relationshipId: string) => {
        if (!user?.uid) return;
        if (!confirm('この申請を拒否しますか？')) return;
        clearSectionError('subordinateRequests');
        try {
            await rejectRelationship(relationshipId, user.uid);
            reloadRelationshipLanes(['subordinateRequests']);
        } catch (error) {
            teamPanelLogger.error('部下申請の拒否に失敗', error, { relationshipId });
            setSectionError('subordinateRequests', '申請の拒否に失敗しました。時間をおいて再度お試しください。');
        }
    };

    const handleRemoveSubordinate = async (relationshipId: string) => {
        if (!user?.uid) return;
        if (!confirm('この部下との関係を解除しますか？')) return;
        clearSectionError('subordinates');
        try {
            await removeSubordinate(relationshipId, user.uid);
            reloadRelationshipLanes(['subordinates']);
        } catch (error) {
            teamPanelLogger.error('部下リレーションの削除に失敗', error, { relationshipId });
            setSectionError('subordinates', '部下の解除に失敗しました。時間をおいて再度お試しください。');
        }
    };

    const handleRemoveSupervisor = async (relationshipId: string) => {
        if (!user?.uid) return;
        if (!confirm('この上司との関係を解除しますか？')) return;
        clearSectionError('supervisors');
        try {
            await cancelRelationshipAsSubordinate(relationshipId, user.uid);
            reloadRelationshipLanes(['supervisors']);
        } catch (error) {
            teamPanelLogger.error('上司リレーションの削除に失敗', error, { relationshipId });
            setSectionError('supervisors', '上司の解除に失敗しました。時間をおいて再度お試しください。');
        }
    };

    const handleCancelSupervisorRequest = async (relationshipId: string) => {
        if (!user?.uid) return;
        if (!confirm('この申請を取り消しますか？')) return;
        clearSectionError('supervisorRequests');
        try {
            await cancelRelationshipAsSubordinate(relationshipId, user.uid);
            reloadRelationshipLanes(['supervisorRequests']);
        } catch (error) {
            teamPanelLogger.error('上司申請の取り消しに失敗', error, { relationshipId });
            setSectionError('supervisorRequests', '申請の取り消しに失敗しました。時間をおいて再度お試しください。');
        }
    };

    const handleAddSupervisor = async () => {
        if (!user?.uid || !user.email) {
            setSupervisorFormNotice({ kind: 'error', text: 'ログイン状態を確認してください。' });
            return;
        }
        const email = supervisorEmailInput.trim();
        if (!email) {
            setSupervisorFormNotice({ kind: 'error', text: 'メールアドレスを入力してください。' });
            return;
        }
        setSupervisorFormNotice(null);
        try {
            setIsSubmittingSupervisor(true);
            await requestSupervisorRelationship(user.uid, email);
            setSupervisorFormNotice({ kind: 'success', text: '上司に申請を送信しました。' });
            setSupervisorEmailInput('');
            reloadRelationshipLanes(['supervisorRequests']);
        } catch (error) {
            teamPanelLogger.error('上司申請の送信に失敗', error, {
                userId: user.uid,
                supervisorEmail: email,
            });
            const text = error instanceof Error ? error.message : '上司申請に失敗しました。';
            setSupervisorFormNotice({ kind: 'error', text });
        } finally {
            setIsSubmittingSupervisor(false);
        }
    };

    if (!user) {
        return (
            <div className="bg-white rounded-xl shadow-lg p-8 text-center">
                {authLoading ? (
                    <div role="status" className="flex items-center justify-center py-4 text-gray-500">
                        <Loader2 className="w-5 h-5 animate-spin mr-2" />
                        ログイン状態を確認しています...
                    </div>
                ) : (
                    <>
                        <p className="text-gray-600">チーム機能を利用するにはログインしてください。</p>
                        <p className="text-sm text-gray-500 mt-2">
                            ログインすると、上司・部下の登録や、承認された相手の記録の閲覧ができます。
                        </p>
                        <div className="mt-6 flex justify-center">
                            <Button onClick={() => setShowAuthModal(true)}>{SIGN_IN_LABEL}</Button>
                        </div>
                        <AuthModal
                            isOpen={showAuthModal}
                            onClose={() => setShowAuthModal(false)}
                            onSuccess={() => setShowAuthModal(false)}
                        />
                    </>
                )}
            </div>
        );
    }

    const formatDateTime = (value: Date | Timestamp): string => {
        if (value instanceof Date) {
            return value.toLocaleString();
        }
        if (value && typeof value.toDate === 'function') {
            return value.toDate().toLocaleString();
        }
        return '';
    };

    const subordinatesLane = relationshipLanes.subordinates;
    const subordinateRequestsLane = relationshipLanes.subordinateRequests;
    const supervisorsLane = relationshipLanes.supervisors;
    const supervisorRequestsLane = relationshipLanes.supervisorRequests;

    return (
        <div className="space-y-6">
            {view === 'subordinates' ? (
                <div className="grid grid-cols-1 xl:grid-cols-6 gap-6">
                    <div className="xl:col-span-2 space-y-6">
                        <div className="bg-white rounded-xl shadow-lg p-4">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="text-lg font-semibold text-gray-900">部下一覧</h3>
                            </div>
                            {sectionErrors.subordinates && (
                                <p role="alert" className="text-sm text-red-600 mb-3">
                                    {sectionErrors.subordinates}
                                </p>
                            )}
                            {subordinatesLane.status === 'loading' ? (
                                <LaneSpinner />
                            ) : subordinatesLane.status === 'error' ? (
                                <LaneError
                                    message={RELATIONSHIP_LANE_ERROR.subordinates}
                                    onRetry={() => reloadRelationshipLanes(['subordinates'])}
                                />
                            ) : subordinatesLane.data.length === 0 ? (
                                <div className="text-sm text-gray-500 py-6 text-center">部下が登録されていません</div>
                            ) : (
                                <div className="space-y-3">
                                    {subordinatesLane.data.map((rel) => (
                                        <div
                                            key={rel.id}
                                            className={`group p-3 rounded-lg border transition-all cursor-pointer ${selectedSubordinate?.id === rel.id
                                                ? 'border-blue-500 bg-blue-50'
                                                : 'border-gray-200 bg-white hover:border-blue-200'
                                                }`}
                                            onClick={() => setSelectedSubordinateId(rel.id)}
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div>
                                                    <p className="text-sm font-semibold text-gray-900">
                                                        {rel.subordinateName || rel.subordinateEmail}
                                                    </p>
                                                    <p className="text-xs text-gray-500">{rel.subordinateEmail}</p>
                                                </div>
                                                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRemoveSubordinate(rel.id);
                                                        }}
                                                        className="px-4 py-2 text-sm font-semibold text-red-600 border border-red-200 rounded-lg bg-red-50 hover:bg-red-100 transition-colors"
                                                    >
                                                        解除
                                                    </button>
                                                </div>
                                            </div>
                                            {isLegacyRelationship(rel) && (
                                                <p className="text-xs text-amber-700 mt-2">
                                                    旧形式の登録のため、この部下の記録を閲覧できません。お手数ですが関係を解除のうえ、部下の方から再申請いただいてください。
                                                </p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="bg-white rounded-xl shadow-lg p-4">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="text-lg font-semibold text-gray-900">申請一覧</h3>
                            </div>
                            {sectionErrors.subordinateRequests && (
                                <p role="alert" className="text-sm text-red-600 mb-3">
                                    {sectionErrors.subordinateRequests}
                                </p>
                            )}
                            {subordinateRequestsLane.status === 'loading' ? (
                                <LaneSpinner />
                            ) : subordinateRequestsLane.status === 'error' ? (
                                <LaneError
                                    message={RELATIONSHIP_LANE_ERROR.subordinateRequests}
                                    onRetry={() => reloadRelationshipLanes(['subordinateRequests'])}
                                />
                            ) : subordinateRequestsLane.data.length === 0 ? (
                                <div className="text-sm text-gray-500 py-6 text-center">申請はありません</div>
                            ) : (
                                <div className="space-y-3">
                                    {subordinateRequestsLane.data.map((rel) => {
                                        const legacyRequest = isLegacyRelationship(rel);
                                        return (
                                            <div key={rel.id} className="p-3 rounded-lg border border-gray-200 bg-gray-50">
                                                <p className="text-sm font-semibold text-gray-900">
                                                    {rel.subordinateName || rel.subordinateEmail}
                                                </p>
                                                <p className="text-xs text-gray-500 mb-3">{rel.subordinateEmail}</p>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleApproveRequest(rel.id)}
                                                        disabled={legacyRequest}
                                                        className="flex-1 px-3 py-1.5 text-sm bg-green-100 text-green-700 rounded-lg hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed"
                                                    >
                                                        追加
                                                    </button>
                                                    <button
                                                        onClick={() => handleRejectRequest(rel.id)}
                                                        className="flex-1 px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200"
                                                    >
                                                        拒否
                                                    </button>
                                                </div>
                                                {legacyRequest && (
                                                    <p className="text-xs text-amber-700 mt-2">
                                                        旧形式の申請のため承認できません。お手数ですが拒否のうえ、部下の方に再申請を依頼してください。
                                                    </p>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="xl:col-span-4 space-y-6">
                        {selectedSubordinate ? (
                            <>
                                <div className="bg-white rounded-xl shadow-lg p-6">
                                    <h3
                                        ref={detailHeadingRef}
                                        tabIndex={-1}
                                        className="text-xl font-bold text-gray-900 focus:outline-none"
                                    >
                                        {selectedSubordinate.subordinateName || selectedSubordinate.subordinateEmail}
                                    </h3>
                                    <p className="text-sm text-gray-500">{selectedSubordinate.subordinateEmail}</p>
                                </div>

                                {selectedIsLegacy ? (
                                    <div className="bg-white rounded-xl shadow-lg p-6">
                                        <p role="status" className="text-sm text-amber-700">
                                            この部下は旧形式で登録されているため、記録を閲覧できません。お手数ですが「解除」で関係を解除のうえ、部下の方から再申請いただいてください。
                                        </p>
                                    </div>
                                ) : (
                                    <>
                                <div className="bg-white rounded-xl shadow-lg p-6">
                                    <div className="flex items-center justify-between mb-3">
                                        <h4 className="text-lg font-semibold text-gray-900">プロンプト一覧</h4>
                                        {subordinatePrompts.status === 'loading' && (
                                            <div role="status" className="flex items-center text-sm text-gray-500">
                                                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                                読み込み中...
                                            </div>
                                        )}
                                    </div>
                                    {subordinatePrompts.status === 'loading' ? (
                                        <div className="text-sm text-gray-500 py-6 text-center">部下データを取得しています</div>
                                    ) : subordinatePrompts.status === 'error' ? (
                                        <LaneError
                                            message="プロンプト一覧の取得に失敗しました。"
                                            onRetry={() => {
                                                if (selectedSubordinateUid) {
                                                    void loadPromptsLane(selectedSubordinateUid, detailWorldRef.current);
                                                }
                                            }}
                                        />
                                    ) : subordinatePrompts.data.length === 0 ? (
                                        <p className="text-sm text-gray-500">プロンプトがありません</p>
                                    ) : (
                                        <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                                            {subordinatePrompts.data.map((prompt) => (
                                                <button
                                                    key={prompt.id}
                                                    onClick={() => setPromptModal(prompt)}
                                                    className="w-full text-left border border-gray-200 rounded-lg p-3 bg-gray-50 hover:border-blue-300 hover:bg-blue-50 transition-colors"
                                                >
                                                    <p className="text-sm font-semibold text-gray-900">{prompt.name}</p>
                                                    <p className="text-xs text-gray-500 mt-1 line-clamp-2">{prompt.content}</p>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="bg-white rounded-xl shadow-lg p-6">
                                    <div className="flex items-center justify-between mb-3">
                                        <h4 className="text-lg font-semibold text-gray-900">生成された文書</h4>
                                        {subordinateDocuments.status === 'loading' && (
                                            <div role="status" className="flex items-center text-sm text-gray-500">
                                                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                                読み込み中...
                                            </div>
                                        )}
                                    </div>
                                    {subordinateDocuments.status === 'loading' ? (
                                        <div className="text-sm text-gray-500 py-6 text-center">部下データを取得しています</div>
                                    ) : subordinateDocuments.status === 'error' ? (
                                        <LaneError
                                            message="文書一覧の取得に失敗しました。"
                                            onRetry={() => {
                                                if (selectedSubordinateUid) {
                                                    void loadDocumentsLane(selectedSubordinateUid, detailWorldRef.current);
                                                }
                                            }}
                                        />
                                    ) : subordinateDocuments.data.length === 0 ? (
                                        <p className="text-sm text-gray-500">文書がありません</p>
                                    ) : (
                                        <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                                            {subordinateDocuments.data.map((doc) => (
                                                <button
                                                    key={doc.id}
                                                    onClick={() => setDocumentModal(doc)}
                                                    className="w-full text-left border border-gray-200 rounded-lg p-3 bg-gray-50 hover:border-blue-300 hover:bg-blue-50 transition-colors"
                                                >
                                                    <p className="text-sm font-semibold text-gray-900">{doc.title}</p>
                                                    <p className="text-xs text-gray-500 mt-1">
                                                        {doc.promptName} ・ {formatDateTime(doc.createdAt)}
                                                    </p>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                    </>
                                )}
                            </>
                        ) : (
                            <div className="bg-white rounded-xl shadow-lg p-6 h-full flex flex-col items-center justify-center text-gray-400 text-sm">
                                <Inbox className="w-12 h-12 mb-3" />
                                部下を選択すると詳細が表示されます
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="space-y-6">
                    <div className="bg-white rounded-xl shadow-lg p-6">
                        <h3 className="text-lg font-semibold text-gray-900 mb-3">上司を追加</h3>
                        <div className="flex flex-col md:flex-row gap-3">
                            <input
                                type="email"
                                value={supervisorEmailInput}
                                onChange={(e) => setSupervisorEmailInput(e.target.value)}
                                placeholder="メールアドレスを入力"
                                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            />
                            <button
                                onClick={handleAddSupervisor}
                                disabled={isSubmittingSupervisor}
                                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                            >
                                {isSubmittingSupervisor ? '送信中...' : '申請する'}
                            </button>
                        </div>
                        {supervisorFormNotice && (
                            <p
                                role={supervisorFormNotice.kind === 'error' ? 'alert' : 'status'}
                                className={`text-sm mt-2 ${supervisorFormNotice.kind === 'error' ? 'text-red-600' : 'text-green-700'}`}
                            >
                                {supervisorFormNotice.text}
                            </p>
                        )}
                        <p className="text-xs text-gray-500 mt-2">
                            申請先のユーザーが承認すると、閲覧権限が付与されます。
                        </p>
                    </div>

                    <div className="bg-white rounded-xl shadow-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-lg font-semibold text-gray-900">上司一覧</h3>
                        </div>
                        {sectionErrors.supervisors && (
                            <p role="alert" className="text-sm text-red-600 mb-3">
                                {sectionErrors.supervisors}
                            </p>
                        )}
                        {supervisorsLane.status === 'loading' ? (
                            <LaneSpinner />
                        ) : supervisorsLane.status === 'error' ? (
                            <LaneError
                                message={RELATIONSHIP_LANE_ERROR.supervisors}
                                onRetry={() => reloadRelationshipLanes(['supervisors'])}
                            />
                        ) : supervisorsLane.data.length === 0 ? (
                            <div className="text-sm text-gray-500 py-6 text-center">上司が登録されていません</div>
                        ) : (
                            <div className="space-y-3">
                                {supervisorsLane.data.map((rel) => (
                                    <div key={rel.id} className="group p-3 rounded-lg border border-gray-200 bg-white">
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">
                                                    {rel.supervisorName || rel.supervisorEmail}
                                                </p>
                                                <p className="text-xs text-gray-500">{rel.supervisorEmail}</p>
                                            </div>
                                            <div className="flex items-center">
                                                <button
                                                    onClick={() => handleRemoveSupervisor(rel.id)}
                                                    className="px-4 py-2 text-sm font-semibold text-red-600 border border-red-200 rounded-lg bg-red-50 hover:bg-red-100 transition-colors"
                                                >
                                                    解除
                                                </button>
                                            </div>
                                        </div>
                                        {isLegacyRelationship(rel) && (
                                            <p className="text-xs text-amber-700 mt-2">
                                                旧形式の登録のため、上司に閲覧権限が反映されません。お手数ですが解除のうえ、再度申請してください。
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="bg-white rounded-xl shadow-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-lg font-semibold text-gray-900">申請状況</h3>
                        </div>
                        {sectionErrors.supervisorRequests && (
                            <p role="alert" className="text-sm text-red-600 mb-3">
                                {sectionErrors.supervisorRequests}
                            </p>
                        )}
                        {supervisorRequestsLane.status === 'loading' ? (
                            <LaneSpinner />
                        ) : supervisorRequestsLane.status === 'error' ? (
                            <LaneError
                                message={RELATIONSHIP_LANE_ERROR.supervisorRequests}
                                onRetry={() => reloadRelationshipLanes(['supervisorRequests'])}
                            />
                        ) : supervisorRequestsLane.data.length === 0 ? (
                            <div className="text-sm text-gray-500 py-6 text-center">申請中の上司はいません</div>
                        ) : (
                            <div className="space-y-3">
                                {supervisorRequestsLane.data.map((rel) => (
                                    <div key={rel.id} className="p-3 rounded-lg border border-gray-200 bg-white">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <p className="text-sm font-semibold text-gray-900">
                                                    {rel.supervisorName || rel.supervisorEmail}
                                                </p>
                                                <p className="text-xs text-gray-500">承認待ち</p>
                                            </div>
                                            <button
                                                onClick={() => handleCancelSupervisorRequest(rel.id)}
                                                className="px-4 py-2 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 rounded-lg shadow-sm"
                                            >
                                                申請取消
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            <ContentEditModal
                isOpen={!!promptModal}
                onClose={() => setPromptModal(null)}
                title={promptModal?.name || ''}
                content={promptModal?.content || ''}
                isEditable={false}
                showDownload={false}
                contentLabel="プロンプト内容"
            />

            <ContentEditModal
                isOpen={!!documentModal}
                onClose={() => setDocumentModal(null)}
                title={documentModal?.title || ''}
                content={documentModal?.text || ''}
                isEditable={false}
                showDownload={false}
                contentLabel="文書内容"
            />
        </div>
    );
};

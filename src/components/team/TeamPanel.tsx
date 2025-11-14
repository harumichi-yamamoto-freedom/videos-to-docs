'use client';

import React, { useState, useEffect } from 'react';
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
} from '@/lib/relationships';
import { Inbox, Loader2 } from 'lucide-react';
import { ContentEditModal } from '@/components/ContentEditModal';
import { createLogger } from '@/lib/logger';

interface TeamPanelProps {
    user: User | null;
    view: 'subordinates' | 'supervisors';
}

const teamPanelLogger = createLogger('TeamPanel');

export const TeamPanel: React.FC<TeamPanelProps> = ({ user, view }) => {
    const [subordinates, setSubordinates] = useState<Relationship[]>([]);
    const [subordinateRequests, setSubordinateRequests] = useState<Relationship[]>([]);
    const [supervisors, setSupervisors] = useState<Relationship[]>([]);
    const [supervisorRequests, setSupervisorRequests] = useState<Relationship[]>([]);
    const [selectedSubordinate, setSelectedSubordinate] = useState<Relationship | null>(null);
    const [subordinatePrompts, setSubordinatePrompts] = useState<Prompt[]>([]);
    const [subordinateDocuments, setSubordinateDocuments] = useState<Transcription[]>([]);
    const [isLoadingRelationships, setIsLoadingRelationships] = useState(true);
    const [isLoadingDetails, setIsLoadingDetails] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const [supervisorEmailInput, setSupervisorEmailInput] = useState('');
    const [isSubmittingSupervisor, setIsSubmittingSupervisor] = useState(false);
    const [promptModal, setPromptModal] = useState<Prompt | null>(null);
    const [documentModal, setDocumentModal] = useState<Transcription | null>(null);

    useEffect(() => {
        const loadRelationships = async () => {
            if (!user?.uid) {
                setIsLoadingRelationships(false);
                return;
            }
            setIsLoadingRelationships(true);
            try {
                const [
                    subordinateList,
                    pendingSubordinateRequests,
                    supervisorList,
                    pendingSupervisorRequests,
                ] = await Promise.all([
                    fetchSubordinateRelationships(user.uid, 'approved'),
                    fetchSubordinateRelationships(user.uid, 'pending'),
                    fetchSupervisorRelationships(user.uid, 'approved'),
                    fetchSupervisorRelationships(user.uid, 'pending'),
                ]);
                setSubordinates(subordinateList);
                setSubordinateRequests(pendingSubordinateRequests);
                setSupervisors(supervisorList);
                setSupervisorRequests(pendingSupervisorRequests);

                if (selectedSubordinate) {
                    const stillExists = subordinateList.find((rel) => rel.id === selectedSubordinate.id);
                    if (!stillExists) {
                        setSelectedSubordinate(null);
                        setSubordinatePrompts([]);
                        setSubordinateDocuments([]);
                    }
                }
            } catch (error) {
                teamPanelLogger.error('チーム情報の取得に失敗', error, { userId: user?.uid });
                alert('チーム情報の取得に失敗しました');
            } finally {
                setIsLoadingRelationships(false);
            }
        };

        loadRelationships();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.uid, refreshKey]);

    useEffect(() => {
        const loadSubordinateDetails = async () => {
            if (!selectedSubordinate) {
                setSubordinatePrompts([]);
                setSubordinateDocuments([]);
                return;
            }
            setIsLoadingDetails(true);
            try {
                const [prompts, docs] = await Promise.all([
                    getPromptsByOwnerId(selectedSubordinate.subordinateId),
                    getTranscriptionsByOwnerId(selectedSubordinate.subordinateId, 50),
                ]);
                setSubordinatePrompts(prompts);
                setSubordinateDocuments(docs);
            } catch (error) {
                teamPanelLogger.error('部下データの取得に失敗', error, {
                    subordinateId: selectedSubordinate.subordinateId,
                });
                alert('部下のデータ取得に失敗しました');
            } finally {
                setIsLoadingDetails(false);
            }
        };

        loadSubordinateDetails();
    }, [selectedSubordinate]);

    const handleApproveRequest = async (relationshipId: string) => {
        if (!user?.uid) return;
        try {
            await approveRelationship(relationshipId, user.uid);
            setRefreshKey((prev) => prev + 1);
        } catch (error) {
            teamPanelLogger.error('部下申請の承認に失敗', error, { relationshipId });
            alert('申請の承認に失敗しました');
        }
    };

    const handleRejectRequest = async (relationshipId: string) => {
        if (!user?.uid) return;
        if (!confirm('この申請を拒否しますか？')) return;
        try {
            await rejectRelationship(relationshipId, user.uid);
            setRefreshKey((prev) => prev + 1);
        } catch (error) {
            teamPanelLogger.error('部下申請の拒否に失敗', error, { relationshipId });
            alert('申請の拒否に失敗しました');
        }
    };

    const handleRemoveSubordinate = async (relationshipId: string) => {
        if (!user?.uid) return;
        if (!confirm('この部下との関係を解除しますか？')) return;
        try {
            await removeSubordinate(relationshipId, user.uid);
            setRefreshKey((prev) => prev + 1);
        } catch (error) {
            teamPanelLogger.error('部下リレーションの削除に失敗', error, { relationshipId });
            alert('部下の削除に失敗しました');
        }
    };

    const handleRemoveSupervisor = async (relationshipId: string) => {
        if (!user?.uid) return;
        if (!confirm('この上司との関係を解除しますか？')) return;
        try {
            await cancelRelationshipAsSubordinate(relationshipId, user.uid);
            setRefreshKey((prev) => prev + 1);
        } catch (error) {
            teamPanelLogger.error('上司リレーションの削除に失敗', error, { relationshipId });
            alert('上司の削除に失敗しました');
        }
    };

    const handleCancelSupervisorRequest = async (relationshipId: string) => {
        if (!user?.uid) return;
        if (!confirm('この申請を取り消しますか？')) return;
        try {
            await cancelRelationshipAsSubordinate(relationshipId, user.uid);
            setRefreshKey((prev) => prev + 1);
        } catch (error) {
            teamPanelLogger.error('上司申請の取り消しに失敗', error, { relationshipId });
            alert('申請の取り消しに失敗しました');
        }
    };

    const handleAddSupervisor = async () => {
        if (!user?.uid || !user.email) {
            alert('ログイン状態を確認してください');
            return;
        }
        if (!supervisorEmailInput.trim()) {
            alert('メールアドレスを入力してください');
            return;
        }
        try {
            setIsSubmittingSupervisor(true);
            await requestSupervisorRelationship(user.uid, supervisorEmailInput.trim());
            alert('上司に申請を送信しました');
            setSupervisorEmailInput('');
            setRefreshKey((prev) => prev + 1);
        } catch (error) {
            teamPanelLogger.error('上司申請の送信に失敗', error, {
                userId: user.uid,
                supervisorEmail: supervisorEmailInput.trim(),
            });
            const message = error instanceof Error ? error.message : '上司申請に失敗しました';
            alert(message);
        } finally {
            setIsSubmittingSupervisor(false);
        }
    };

    if (!user) {
        return (
            <div className="bg-white rounded-xl shadow-lg p-8 text-center text-gray-600">
                チーム機能を利用するにはログインしてください。
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

    return (
        <div className="space-y-6">
            {view === 'subordinates' ? (
                <div className="grid grid-cols-1 xl:grid-cols-6 gap-6">
                    <div className="xl:col-span-2 space-y-6">
                        <div className="bg-white rounded-xl shadow-lg p-4">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="text-lg font-semibold text-gray-900">部下一覧</h3>
                            </div>
                            {isLoadingRelationships ? (
                                <div className="flex items-center justify-center py-8 text-gray-500">
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                                    読み込み中...
                                </div>
                            ) : subordinates.length === 0 ? (
                                <div className="text-sm text-gray-500 py-6 text-center">部下が登録されていません</div>
                            ) : (
                                <div className="space-y-3">
                                    {subordinates.map((rel) => (
                                        <div
                                            key={rel.id}
                                            className={`group p-3 rounded-lg border transition-all cursor-pointer ${selectedSubordinate?.id === rel.id
                                                ? 'border-blue-500 bg-blue-50'
                                                : 'border-gray-200 bg-white hover:border-blue-200'
                                                }`}
                                            onClick={() => setSelectedSubordinate(rel)}
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
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="bg-white rounded-xl shadow-lg p-4">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="text-lg font-semibold text-gray-900">申請一覧</h3>
                            </div>
                            {isLoadingRelationships ? (
                                <div className="flex items-center justify-center py-8 text-gray-500">
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                                    読み込み中...
                                </div>
                            ) : subordinateRequests.length === 0 ? (
                                <div className="text-sm text-gray-500 py-6 text-center">申請はありません</div>
                            ) : (
                                <div className="space-y-3">
                                    {subordinateRequests.map((rel) => (
                                        <div key={rel.id} className="p-3 rounded-lg border border-gray-200 bg-gray-50">
                                            <p className="text-sm font-semibold text-gray-900">
                                                {rel.subordinateName || rel.subordinateEmail}
                                            </p>
                                            <p className="text-xs text-gray-500 mb-3">{rel.subordinateEmail}</p>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => handleApproveRequest(rel.id)}
                                                    className="flex-1 px-3 py-1.5 text-sm bg-green-100 text-green-700 rounded-lg hover:bg-green-200"
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
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="xl:col-span-4 space-y-6">
                        {selectedSubordinate ? (
                            <>
                                <div className="bg-white rounded-xl shadow-lg p-6">
                                    <h3 className="text-xl font-bold text-gray-900">
                                        {selectedSubordinate.subordinateName || selectedSubordinate.subordinateEmail}
                                    </h3>
                                    <p className="text-sm text-gray-500">{selectedSubordinate.subordinateEmail}</p>
                                </div>

                                <div className="bg-white rounded-xl shadow-lg p-6">
                                    <div className="flex items-center justify-between mb-3">
                                        <h4 className="text-lg font-semibold text-gray-900">プロンプト一覧</h4>
                                        {isLoadingDetails && (
                                            <div className="flex items-center text-sm text-gray-500">
                                                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                                読み込み中...
                                            </div>
                                        )}
                                    </div>
                                    {isLoadingDetails ? (
                                        <div className="text-sm text-gray-500 py-6 text-center">部下データを取得しています</div>
                                    ) : subordinatePrompts.length === 0 ? (
                                        <p className="text-sm text-gray-500">プロンプトがありません</p>
                                    ) : (
                                        <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                                            {subordinatePrompts.map((prompt) => (
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
                                        {isLoadingDetails && (
                                            <div className="flex items-center text-sm text-gray-500">
                                                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                                読み込み中...
                                            </div>
                                        )}
                                    </div>
                                    {isLoadingDetails ? (
                                        <div className="text-sm text-gray-500 py-6 text-center">部下データを取得しています</div>
                                    ) : subordinateDocuments.length === 0 ? (
                                        <p className="text-sm text-gray-500">文書がありません</p>
                                    ) : (
                                        <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                                            {subordinateDocuments.map((doc) => (
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
                        <p className="text-xs text-gray-500 mt-2">
                            申請先のユーザーが承認すると、閲覧権限が付与されます。
                        </p>
                    </div>

                    <div className="bg-white rounded-xl shadow-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-lg font-semibold text-gray-900">上司一覧</h3>
                        </div>
                        {isLoadingRelationships ? (
                            <div className="flex items-center justify-center py-8 text-gray-500">
                                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                                読み込み中...
                            </div>
                        ) : supervisors.length === 0 ? (
                            <div className="text-sm text-gray-500 py-6 text-center">上司が登録されていません</div>
                        ) : (
                            <div className="space-y-3">
                                {supervisors.map((rel) => (
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
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="bg-white rounded-xl shadow-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-lg font-semibold text-gray-900">申請状況</h3>
                        </div>
                        {isLoadingRelationships ? (
                            <div className="flex items-center justify-center py-8 text-gray-500">
                                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                                読み込み中...
                            </div>
                        ) : supervisorRequests.length === 0 ? (
                            <div className="text-sm text-gray-500 py-6 text-center">申請中の上司はいません</div>
                        ) : (
                            <div className="space-y-3">
                                {supervisorRequests.map((rel) => (
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


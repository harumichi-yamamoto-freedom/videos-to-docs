'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Download, ChevronDown, ChevronRight, CheckSquare, Square } from 'lucide-react';
import {
    getAllAudioTranscriptions,
    groupByAudioPath,
    filterGroups,
    getDefaultTemplateNames,
    AudioFileGroup,
    FilterMode,
} from '@/lib/adminAudioFiles';
import { getAudioDownloadURL } from '@/lib/storage';
import { createLogger } from '@/lib/logger';
import JSZip from 'jszip';

const logger = createLogger('AudioFilesPanel');

type DownloadContent = 'audio_only' | 'audio_and_docs';
type DownloadFormat = 'zip' | 'individual';

export default function AudioFilesPanel() {
    const [groups, setGroups] = useState<AudioFileGroup[]>([]);
    const [filteredGroups, setFilteredGroups] = useState<AudioFileGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [filterMode, setFilterMode] = useState<FilterMode>('all');
    const [templateNames, setTemplateNames] = useState<string[]>([]);
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [showDownloadModal, setShowDownloadModal] = useState(false);
    const [downloading, setDownloading] = useState(false);

    const loadData = useCallback(async () => {
        try {
            setLoading(true);
            const [docs, names] = await Promise.all([
                getAllAudioTranscriptions(),
                getDefaultTemplateNames(),
            ]);
            const grouped = groupByAudioPath(docs);
            setGroups(grouped);
            setTemplateNames(names);

            const filtered = await filterGroups(grouped, filterMode);
            setFilteredGroups(filtered);
        } catch (error) {
            logger.error('データの読み込みに失敗', error);
            alert('データの読み込みに失敗しました');
        } finally {
            setLoading(false);
        }
    }, [filterMode]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    useEffect(() => {
        const applyFilter = async () => {
            const filtered = await filterGroups(groups, filterMode);
            setFilteredGroups(filtered);
            // フィルタ変更時に選択をリセット
            setSelectedPaths(new Set());
        };
        if (groups.length > 0) {
            applyFilter();
        }
    }, [filterMode, groups]);

    const toggleSelect = (path: string) => {
        setSelectedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    };

    const toggleSelectAll = () => {
        if (selectedPaths.size === filteredGroups.length) {
            setSelectedPaths(new Set());
        } else {
            setSelectedPaths(new Set(filteredGroups.map((g) => g.audioStoragePath)));
        }
    };

    const toggleExpand = (path: string) => {
        setExpandedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    };

    const selectedGroups = filteredGroups.filter((g) => selectedPaths.has(g.audioStoragePath));

    const handleDownload = async (content: DownloadContent, format: DownloadFormat) => {
        setShowDownloadModal(false);
        setDownloading(true);

        try {
            if (format === 'zip') {
                await downloadAsZip(selectedGroups, content);
            } else {
                await downloadIndividually(selectedGroups, content);
            }
        } catch (error) {
            logger.error('ダウンロードに失敗', error);
            alert('ダウンロードに失敗しました');
        } finally {
            setDownloading(false);
        }
    };

    return (
        <div>
            {/* ヘッダー */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-gray-900">音声ファイル</h2>
                    <p className="text-gray-600 text-sm mt-1">全ユーザーの音声ファイル一覧</p>
                </div>
                <div className="flex items-center gap-3">
                    <select
                        value={filterMode}
                        onChange={(e) => setFilterMode(e.target.value)}
                        className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                        <option value="all">すべて</option>
                        <option value="default_all">デフォルトプロンプト（全種類）</option>
                        {templateNames.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                    <button
                        onClick={loadData}
                        disabled={loading}
                        className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        更新
                    </button>
                </div>
            </div>

            {/* ツールバー */}
            <div className="flex items-center gap-4 mb-4 px-4 py-3 bg-gray-50 rounded-lg">
                <button onClick={toggleSelectAll} className="flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900">
                    {selectedPaths.size === filteredGroups.length && filteredGroups.length > 0 ? (
                        <CheckSquare className="w-4 h-4 text-purple-600" />
                    ) : (
                        <Square className="w-4 h-4" />
                    )}
                    全選択
                </button>
                <span className="text-sm text-gray-500">
                    {selectedPaths.size > 0 ? `${selectedPaths.size}件選択中` : `${filteredGroups.length}件`}
                </span>
                {selectedPaths.size > 0 && (
                    <button
                        onClick={() => setShowDownloadModal(true)}
                        disabled={downloading}
                        className="ml-auto px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2 disabled:opacity-50 text-sm"
                    >
                        <Download className="w-4 h-4" />
                        {downloading ? 'ダウンロード中...' : 'ダウンロード'}
                    </button>
                )}
            </div>

            {/* テーブル */}
            {loading ? (
                <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
                    <p className="text-gray-600">読み込み中...</p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-10"></th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ファイル名</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">オーナーID</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">作成日時</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">関連文書</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-10"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {filteredGroups.map((group) => (
                                <React.Fragment key={group.audioStoragePath}>
                                    <tr className="hover:bg-gray-50">
                                        <td className="px-4 py-3">
                                            <button onClick={() => toggleSelect(group.audioStoragePath)}>
                                                {selectedPaths.has(group.audioStoragePath) ? (
                                                    <CheckSquare className="w-4 h-4 text-purple-600" />
                                                ) : (
                                                    <Square className="w-4 h-4 text-gray-400" />
                                                )}
                                            </button>
                                        </td>
                                        <td className="px-4 py-3 text-sm text-gray-900 max-w-xs truncate" title={group.fileName}>
                                            {group.fileName}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-gray-600">
                                            {group.ownerId.slice(0, 12)}{group.ownerId.length > 12 ? '...' : ''}
                                        </td>
                                        <td className="px-4 py-3 text-sm text-gray-600">
                                            {group.createdAt.toLocaleString('ja-JP')}
                                        </td>
                                        <td className="px-4 py-3 text-sm">
                                            <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">
                                                {group.documents.length}件
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <button
                                                onClick={() => toggleExpand(group.audioStoragePath)}
                                                className="text-gray-500 hover:text-gray-700"
                                            >
                                                {expandedPaths.has(group.audioStoragePath) ? (
                                                    <ChevronDown className="w-4 h-4" />
                                                ) : (
                                                    <ChevronRight className="w-4 h-4" />
                                                )}
                                            </button>
                                        </td>
                                    </tr>
                                    {expandedPaths.has(group.audioStoragePath) && (
                                        <tr>
                                            <td colSpan={6} className="px-8 py-3 bg-gray-50">
                                                <div className="space-y-2">
                                                    {group.documents.map((doc) => (
                                                        <div key={doc.id} className="flex items-center gap-4 text-sm text-gray-600">
                                                            <span className="font-medium text-gray-800">{doc.title}</span>
                                                            <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">
                                                                {doc.promptName}
                                                            </span>
                                                            <span className="text-gray-400">
                                                                {doc.createdAt.toLocaleString('ja-JP')}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                    {filteredGroups.length === 0 && (
                        <div className="text-center py-12 text-gray-500">
                            音声ファイルがありません
                        </div>
                    )}
                </div>
            )}

            {/* ダウンロードモーダル */}
            {showDownloadModal && (
                <DownloadModal
                    selectedCount={selectedPaths.size}
                    onDownload={handleDownload}
                    onClose={() => setShowDownloadModal(false)}
                />
            )}
        </div>
    );
}

function DownloadModal({
    selectedCount,
    onDownload,
    onClose,
}: {
    selectedCount: number;
    onDownload: (content: DownloadContent, format: DownloadFormat) => void;
    onClose: () => void;
}) {
    const [content, setContent] = useState<DownloadContent>('audio_only');
    const [format, setFormat] = useState<DownloadFormat>('zip');

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-bold text-gray-900 mb-4">
                    ダウンロード設定（{selectedCount}件）
                </h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">ダウンロード内容</label>
                        <div className="space-y-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="content"
                                    checked={content === 'audio_only'}
                                    onChange={() => setContent('audio_only')}
                                    className="text-purple-600"
                                />
                                <span className="text-sm">音声ファイルのみ</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="content"
                                    checked={content === 'audio_and_docs'}
                                    onChange={() => setContent('audio_and_docs')}
                                    className="text-purple-600"
                                />
                                <span className="text-sm">音声ファイル＋関連文書</span>
                            </label>
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">ダウンロード形式</label>
                        <div className="space-y-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="format"
                                    checked={format === 'zip'}
                                    onChange={() => setFormat('zip')}
                                    className="text-purple-600"
                                />
                                <span className="text-sm">ZIPにまとめる</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="format"
                                    checked={format === 'individual'}
                                    onChange={() => setFormat('individual')}
                                    className="text-purple-600"
                                />
                                <span className="text-sm">個別ダウンロード</span>
                            </label>
                        </div>
                    </div>
                </div>

                <div className="flex justify-end gap-3 mt-6">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                        キャンセル
                    </button>
                    <button
                        onClick={() => onDownload(content, format)}
                        className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
                    >
                        <Download className="w-4 h-4" />
                        ダウンロード
                    </button>
                </div>
            </div>
        </div>
    );
}

// --- ダウンロードヘルパー ---

async function fetchAudioBlob(storagePath: string): Promise<Blob> {
    const url = await getAudioDownloadURL(storagePath);
    const res = await fetch(url);
    return res.blob();
}

function triggerDownload(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
}

async function downloadAsZip(groups: AudioFileGroup[], content: DownloadContent) {
    const zip = new JSZip();

    for (const group of groups) {
        const audioBlob = await fetchAudioBlob(group.audioStoragePath);

        if (content === 'audio_only') {
            zip.file(group.fileName, audioBlob);
        } else {
            // サブフォルダに音声＋文書
            const folderName = group.fileName.replace(/\.[^.]+$/, '');
            const folder = zip.folder(folderName)!;
            folder.file(group.fileName, audioBlob);
            for (const doc of group.documents) {
                const txtName = `${doc.title}_${doc.promptName}.txt`;
                folder.file(txtName, doc.transcription);
            }
        }
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(blob, `audio_files_${new Date().toISOString().slice(0, 10)}.zip`);
}

async function downloadIndividually(groups: AudioFileGroup[], content: DownloadContent) {
    for (const group of groups) {
        if (content === 'audio_only') {
            const audioBlob = await fetchAudioBlob(group.audioStoragePath);
            triggerDownload(audioBlob, group.fileName);
        } else {
            // 各グループを個別ZIPにする
            const zip = new JSZip();
            const audioBlob = await fetchAudioBlob(group.audioStoragePath);
            zip.file(group.fileName, audioBlob);
            for (const doc of group.documents) {
                const txtName = `${doc.title}_${doc.promptName}.txt`;
                zip.file(txtName, doc.transcription);
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            const zipName = group.fileName.replace(/\.[^.]+$/, '') + '.zip';
            triggerDownload(blob, zipName);
        }

        // ブラウザのダウンロード制限を避けるため少し待つ
        await new Promise((r) => setTimeout(r, 500));
    }
}

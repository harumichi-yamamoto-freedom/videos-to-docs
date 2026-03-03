/**
 * 管理者向け音声ファイル管理ロジック
 */

import { db } from './firebase';
import { collection, getDocs, query, where, orderBy } from 'firebase/firestore';
import { getAdminSettings } from './adminSettings';
import { audioExists } from './storage';
import { createLogger } from './logger';

const logger = createLogger('adminAudioFiles');

export interface AudioTranscriptionDoc {
    id: string;
    title: string;
    fileName: string;
    transcription: string;
    promptName: string;
    ownerType: string;
    ownerId: string;
    createdAt: Date;
    audioStoragePath: string;
}

export interface AudioFileGroup {
    audioStoragePath: string;
    fileName: string;
    ownerId: string;
    createdAt: Date;
    documents: AudioTranscriptionDoc[];
}

/**
 * audioStoragePath を持つ全文書を取得（管理者用）
 */
export async function getAllAudioTranscriptions(): Promise<AudioTranscriptionDoc[]> {
    try {
        const q = query(
            collection(db, 'transcriptions'),
            where('audioStoragePath', '!=', null),
            orderBy('audioStoragePath'),
            orderBy('createdAt', 'desc')
        );

        const snapshot = await getDocs(q);
        const docs: AudioTranscriptionDoc[] = [];

        snapshot.forEach((docSnapshot) => {
            const data = docSnapshot.data();
            const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();

            docs.push({
                id: docSnapshot.id,
                title: data.title || data.fileName,
                fileName: data.fileName,
                transcription: data.transcription,
                promptName: data.promptName || '不明',
                ownerType: data.ownerType || 'guest',
                ownerId: data.ownerId || 'GUEST',
                createdAt,
                audioStoragePath: data.audioStoragePath,
            });
        });

        return docs;
    } catch (error) {
        logger.error('音声付き文書の取得に失敗', error);
        throw new Error('音声付き文書の取得に失敗しました');
    }
}

/**
 * audioStoragePath でグループ化
 */
export function groupByAudioPath(docs: AudioTranscriptionDoc[]): AudioFileGroup[] {
    const map = new Map<string, AudioTranscriptionDoc[]>();

    for (const doc of docs) {
        const existing = map.get(doc.audioStoragePath);
        if (existing) {
            existing.push(doc);
        } else {
            map.set(doc.audioStoragePath, [doc]);
        }
    }

    const groups: AudioFileGroup[] = [];
    for (const [path, groupDocs] of map) {
        // 最古の作成日時を使用
        const earliest = groupDocs.reduce((min, d) => (d.createdAt < min ? d.createdAt : min), groupDocs[0].createdAt);
        // パスからファイル名を抽出
        const fileName = path.split('/').pop() || path;

        groups.push({
            audioStoragePath: path,
            fileName,
            ownerId: groupDocs[0].ownerId,
            createdAt: earliest,
            documents: groupDocs,
        });
    }

    // 新しい順にソート
    groups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return groups;
}

/**
 * Storage に実在するグループのみを返す
 */
export async function filterExistingInStorage(groups: AudioFileGroup[]): Promise<AudioFileGroup[]> {
    const results = await Promise.all(
        groups.map(async (group) => {
            const exists = await audioExists(group.audioStoragePath);
            if (!exists) {
                logger.info('Storage にファイルが存在しないため除外', { path: group.audioStoragePath });
            }
            return { group, exists };
        })
    );
    return results.filter((r) => r.exists).map((r) => r.group);
}

/**
 * プロンプト名がテンプレート名に一致するか判定
 * 完全一致 or "テンプレート名 (数字)" パターン
 */
export function matchesTemplateName(promptName: string, templateName: string): boolean {
    if (promptName === templateName) return true;
    const pattern = new RegExp(`^${escapeRegExp(templateName)} \\(\\d+\\)$`);
    return pattern.test(promptName);
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type FilterMode = 'all' | 'default_all' | string;

/**
 * グループにフィルタを適用
 * - 'all': フィルタなし
 * - 'default_all': デフォルトプロンプトのいずれかに一致するグループ
 * - その他: 特定のテンプレート名に一致するグループ
 */
export async function filterGroups(
    groups: AudioFileGroup[],
    filterMode: FilterMode
): Promise<AudioFileGroup[]> {
    if (filterMode === 'all') return groups;

    const settings = await getAdminSettings();
    const templateNames = (settings.defaultPrompts || []).map((p) => p.name);

    if (filterMode === 'default_all') {
        return groups.filter((group) =>
            group.documents.some((doc) =>
                templateNames.some((name) => matchesTemplateName(doc.promptName, name))
            )
        );
    }

    // 特定テンプレート名でフィルタ
    return groups.filter((group) =>
        group.documents.some((doc) => matchesTemplateName(doc.promptName, filterMode))
    );
}

/**
 * デフォルトプロンプトのテンプレート名一覧を取得
 */
export async function getDefaultTemplateNames(): Promise<string[]> {
    const settings = await getAdminSettings();
    return (settings.defaultPrompts || []).map((p) => p.name);
}

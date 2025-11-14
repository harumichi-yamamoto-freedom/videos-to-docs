'use client';

import {
    collection,
    query,
    where,
    getDocs,
    getDoc,
    addDoc,
    serverTimestamp,
    updateDoc,
    doc,
    deleteDoc,
    onSnapshot,
    Timestamp,
    QueryDocumentSnapshot,
    DocumentData,
    Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import { getUserByEmail, getUserProfile, UserProfile } from './userManagement';
import { createLogger } from './logger';

export type RelationshipStatus = 'pending' | 'approved';

export interface Relationship {
    id: string;
    supervisorId: string;
    supervisorEmail: string;
    supervisorName?: string;
    subordinateId: string;
    subordinateEmail: string;
    subordinateName?: string;
    status: RelationshipStatus;
    createdAt: Date | Timestamp | null;
    updatedAt: Date | Timestamp | null;
}

const relationshipsCol = collection(db, 'relationships');
const relationshipsLogger = createLogger('relationships');

function convertRelationshipDoc(docSnap: QueryDocumentSnapshot<DocumentData>): Relationship {
    const data = docSnap.data();
    return {
        id: docSnap.id,
        supervisorId: data.supervisorId,
        supervisorEmail: data.supervisorEmail,
        supervisorName: data.supervisorName,
        subordinateId: data.subordinateId,
        subordinateEmail: data.subordinateEmail,
        subordinateName: data.subordinateName,
        status: data.status,
        createdAt: data.createdAt?.toDate?.() ?? data.createdAt ?? null,
        updatedAt: data.updatedAt?.toDate?.() ?? data.updatedAt ?? null,
    };
}

async function attachLatestDisplayNames(relationships: Relationship[]): Promise<Relationship[]> {
    const ids = new Set<string>();
    relationships.forEach((rel) => {
        if (rel.supervisorId) ids.add(rel.supervisorId);
        if (rel.subordinateId) ids.add(rel.subordinateId);
    });

    const idList = Array.from(ids);
    const profiles = await Promise.all(idList.map((id) => getUserProfile(id)));
    const profileMap = new Map<string, UserProfile>();
    profiles.forEach((profile, index) => {
        if (profile) {
            profileMap.set(idList[index], profile);
        }
    });

    return relationships.map((rel) => ({
        ...rel,
        supervisorName: profileMap.get(rel.supervisorId)?.displayName ?? rel.supervisorName ?? rel.supervisorEmail,
        subordinateName: profileMap.get(rel.subordinateId)?.displayName ?? rel.subordinateName ?? rel.subordinateEmail,
    }));
}

export async function fetchSubordinateRelationships(supervisorId: string, status?: RelationshipStatus): Promise<Relationship[]> {
    const constraints = [where('supervisorId', '==', supervisorId)];
    if (status) {
        constraints.push(where('status', '==', status));
    }
    const q = query(relationshipsCol, ...constraints);
    const snapshot = await getDocs(q);
    const relationships = snapshot.docs.map(convertRelationshipDoc);
    return attachLatestDisplayNames(relationships);
}

export async function fetchSupervisorRelationships(subordinateId: string, status?: RelationshipStatus): Promise<Relationship[]> {
    const constraints = [where('subordinateId', '==', subordinateId)];
    if (status) {
        constraints.push(where('status', '==', status));
    }
    const q = query(relationshipsCol, ...constraints);
    const snapshot = await getDocs(q);
    const relationships = snapshot.docs.map(convertRelationshipDoc);
    return attachLatestDisplayNames(relationships);
}

export function subscribeToPendingSubordinateRelationships(
    supervisorId: string,
    callback: (relationships: Relationship[]) => void,
    onError?: (error: Error) => void
): Unsubscribe {
    const q = query(relationshipsCol, where('supervisorId', '==', supervisorId), where('status', '==', 'pending'));
    return onSnapshot(
        q,
        (snapshot) => {
            const relationships = snapshot.docs.map(convertRelationshipDoc);
            callback(relationships);
        },
        (error) => {
            relationshipsLogger.error('未処理リレーションの購読に失敗', error, { supervisorId });
            if (onError) {
                onError(error as Error);
            }
        }
    );
}

export async function requestSupervisorRelationship(subordinateId: string, supervisorEmail: string, subordinateUser?: UserProfile | null): Promise<void> {
    relationshipsLogger.info('上司申請を開始', { subordinateId, supervisorEmail });
    const supervisorProfile = await getUserByEmail(supervisorEmail);
    if (!supervisorProfile) {
        relationshipsLogger.warn('メールアドレスに一致する上司が存在しません', { supervisorEmail });
        throw new Error('指定されたメールアドレスのユーザーが見つかりません');
    }
    if (supervisorProfile.uid === subordinateId) {
        throw new Error('自分自身を上司に登録することはできません');
    }

    const subordinateProfile = subordinateUser ?? (await getUserProfile(subordinateId));
    if (!subordinateProfile) {
        relationshipsLogger.error('部下のユーザープロファイルが見つかりません', undefined, { subordinateId });
        throw new Error('部下のユーザープロファイルが見つかりません');
    }

    // 既存の関係をチェック
    const existing = await getDocs(
        query(
            relationshipsCol,
            where('supervisorId', '==', supervisorProfile.uid),
            where('subordinateId', '==', subordinateId)
        )
    );
    if (!existing.empty) {
        const existingStatus = existing.docs[0].data().status as RelationshipStatus;
        relationshipsLogger.info('既存のリレーションシップが見つかりました', {
            relationshipId: existing.docs[0].id,
            existingStatus,
        });
        if (existingStatus === 'pending') {
            throw new Error('このユーザーにはすでに申請済みです');
        }
        if (existingStatus === 'approved') {
            throw new Error('このユーザーはすでに上司として登録されています');
        }
    }

    await addDoc(relationshipsCol, {
        supervisorId: supervisorProfile.uid,
        supervisorEmail: supervisorProfile.email,
        supervisorName: supervisorProfile.displayName || '',
        subordinateId,
        subordinateEmail: subordinateProfile.email,
        subordinateName: subordinateProfile.displayName || '',
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    relationshipsLogger.info('上司申請を作成しました', {
        supervisorId: supervisorProfile.uid,
        subordinateId,
    });
}

export async function approveRelationship(relationshipId: string, supervisorId: string): Promise<void> {
    const ref = doc(db, 'relationships', relationshipId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
        throw new Error('リレーションシップが見つかりません');
    }
    if (snapshot.data().supervisorId !== supervisorId) {
        throw new Error('このリレーションシップを承認する権限がありません');
    }
    await updateDoc(ref, {
        status: 'approved',
        updatedAt: serverTimestamp(),
    });
}

export async function rejectRelationship(relationshipId: string, supervisorId: string): Promise<void> {
    const ref = doc(db, 'relationships', relationshipId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
        throw new Error('リレーションシップが見つかりません');
    }
    if (snapshot.data().supervisorId !== supervisorId) {
        throw new Error('このリレーションシップを拒否する権限がありません');
    }
    await deleteDoc(ref);
}

export async function removeSubordinate(relationshipId: string, supervisorId: string): Promise<void> {
    const ref = doc(db, 'relationships', relationshipId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
        throw new Error('リレーションシップが見つかりません');
    }
    if (snapshot.data().supervisorId !== supervisorId) {
        throw new Error('このリレーションシップを削除する権限がありません');
    }
    await deleteDoc(ref);
}

export async function cancelRelationshipAsSubordinate(relationshipId: string, subordinateId: string): Promise<void> {
    const ref = doc(db, 'relationships', relationshipId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
        throw new Error('リレーションシップが見つかりません');
    }
    if (snapshot.data().subordinateId !== subordinateId) {
        throw new Error('このリレーションシップを操作する権限がありません');
    }
    await deleteDoc(ref);
}


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
    Timestamp,
    QueryDocumentSnapshot,
    DocumentData,
} from 'firebase/firestore';
import { db } from './firebase';
import { getUserByEmail, getUserProfile, UserProfile } from './userManagement';

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

export async function fetchSubordinateRelationships(supervisorId: string, status?: RelationshipStatus): Promise<Relationship[]> {
    const constraints = [where('supervisorId', '==', supervisorId)];
    if (status) {
        constraints.push(where('status', '==', status));
    }
    const q = query(relationshipsCol, ...constraints);
    const snapshot = await getDocs(q);
    return snapshot.docs.map(convertRelationshipDoc);
}

export async function fetchSupervisorRelationships(subordinateId: string, status?: RelationshipStatus): Promise<Relationship[]> {
    const constraints = [where('subordinateId', '==', subordinateId)];
    if (status) {
        constraints.push(where('status', '==', status));
    }
    const q = query(relationshipsCol, ...constraints);
    const snapshot = await getDocs(q);
    return snapshot.docs.map(convertRelationshipDoc);
}

export async function requestSupervisorRelationship(subordinateId: string, supervisorEmail: string, subordinateUser?: UserProfile | null): Promise<void> {
    console.log('[Relationships] Supervisor request start', { subordinateId, supervisorEmail });
    const supervisorProfile = await getUserByEmail(supervisorEmail);
    if (!supervisorProfile) {
        console.warn('[Relationships] Supervisor not found by email', { supervisorEmail });
        throw new Error('指定されたメールアドレスのユーザーが見つかりません');
    }
    if (supervisorProfile.uid === subordinateId) {
        throw new Error('自分自身を上司に登録することはできません');
    }

    const subordinateProfile = subordinateUser ?? (await getUserProfile(subordinateId));
    if (!subordinateProfile) {
        console.error('[Relationships] Subordinate profile missing', { subordinateId });
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
        console.log('[Relationships] Existing relationship found', { relationshipId: existing.docs[0].id, existingStatus });
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
    console.log('[Relationships] Supervisor request created', { supervisorId: supervisorProfile.uid, subordinateId });
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


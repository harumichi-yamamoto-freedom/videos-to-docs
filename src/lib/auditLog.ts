/**
 * 監査ログシステム
 * すべての重要な操作を記録
 */

import { db } from './firebase';
import { collection, addDoc, query, orderBy, limit, getDocs, where, serverTimestamp, Timestamp } from 'firebase/firestore';
import { getCurrentUserId, getOwnerType } from './auth';

export type AuditAction =
    | 'prompt_create'
    | 'prompt_update'
    | 'prompt_delete'
    | 'document_create'
    | 'document_delete'
    | 'user_login'
    | 'user_logout'
    | 'user_signup'
    | 'user_delete'
    | 'user_password_change'
    | 'admin_settings_update'
    | 'admin_user_view';

export interface AuditLog {
    id?: string;
    userId: string; // "GUEST" または Auth UID
    userEmail?: string;
    action: AuditAction;
    resourceType: string; // 'prompt', 'document', 'user', 'settings'
    resourceId?: string;
    details?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
    timestamp: Date | Timestamp;
}

/**
 * 監査ログを記録
 */
export async function logAudit(
    action: AuditAction,
    resourceType: string,
    resourceId?: string,
    details?: Record<string, any>
): Promise<void> {
    try {
        const userId = getCurrentUserId();
        const ownerType = getOwnerType();

        // ブラウザ情報を取得
        const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : undefined;

        // Firestoreに保存するデータ（undefinedは除外）
        const logData: any = {
            userId,
            action,
            resourceType,
            timestamp: serverTimestamp(),
        };

        // オプショナルフィールドはundefinedでない場合のみ追加
        if (ownerType === 'user' && details?.userEmail) {
            logData.userEmail = details.userEmail;
        }
        if (resourceId) {
            logData.resourceId = resourceId;
        }
        if (details) {
            logData.details = details;
        }
        if (userAgent) {
            logData.userAgent = userAgent;
        }

        await addDoc(collection(db, 'auditLogs'), logData);
    } catch (error) {
        // 監査ログの記録失敗はサイレントに処理（メイン処理に影響を与えない）
        console.error('監査ログ記録エラー:', error);
    }
}

/**
 * 監査ログを取得（管理者用）
 */
export async function getAuditLogs(
    limitCount: number = 100,
    filterUserId?: string,
    filterAction?: AuditAction
): Promise<AuditLog[]> {
    try {
        let q = query(
            collection(db, 'auditLogs'),
            orderBy('timestamp', 'desc'),
            limit(limitCount)
        );

        // ユーザーIDでフィルタ
        if (filterUserId) {
            q = query(
                collection(db, 'auditLogs'),
                where('userId', '==', filterUserId),
                orderBy('timestamp', 'desc'),
                limit(limitCount)
            );
        }

        // アクションでフィルタ
        if (filterAction) {
            q = query(
                collection(db, 'auditLogs'),
                where('action', '==', filterAction),
                orderBy('timestamp', 'desc'),
                limit(limitCount)
            );
        }

        const snapshot = await getDocs(q);
        const logs: AuditLog[] = [];

        snapshot.forEach((doc) => {
            const data = doc.data();
            logs.push({
                id: doc.id,
                userId: data.userId,
                userEmail: data.userEmail,
                action: data.action,
                resourceType: data.resourceType,
                resourceId: data.resourceId,
                details: data.details,
                ipAddress: data.ipAddress,
                userAgent: data.userAgent,
                timestamp: data.timestamp.toDate(),
            });
        });

        return logs;
    } catch (error) {
        console.error('監査ログ取得エラー:', error);
        throw new Error('監査ログの取得に失敗しました');
    }
}

/**
 * 特定リソースの監査ログを取得
 */
export async function getAuditLogsByResource(
    resourceType: string,
    resourceId: string,
    limitCount: number = 50
): Promise<AuditLog[]> {
    try {
        const q = query(
            collection(db, 'auditLogs'),
            where('resourceType', '==', resourceType),
            where('resourceId', '==', resourceId),
            orderBy('timestamp', 'desc'),
            limit(limitCount)
        );

        const snapshot = await getDocs(q);
        const logs: AuditLog[] = [];

        snapshot.forEach((doc) => {
            const data = doc.data();
            logs.push({
                id: doc.id,
                userId: data.userId,
                userEmail: data.userEmail,
                action: data.action,
                resourceType: data.resourceType,
                resourceId: data.resourceId,
                details: data.details,
                ipAddress: data.ipAddress,
                userAgent: data.userAgent,
                timestamp: data.timestamp.toDate(),
            });
        });

        return logs;
    } catch (error) {
        console.error('監査ログ取得エラー:', error);
        throw new Error('監査ログの取得に失敗しました');
    }
}


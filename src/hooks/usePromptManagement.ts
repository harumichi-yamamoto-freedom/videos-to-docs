import { useCallback, useEffect, useRef, useState } from 'react';
import { withTranscriptPrompt } from '@/lib/transcriptPrompt';
import { Prompt, getPrompts } from '@/lib/prompts';
import { useAuth } from './useAuth';
import { createLogger } from '@/lib/logger';

const promptManagementLogger = createLogger('usePromptManagement');

export type PromptLoadStatus = 'idle' | 'loading' | 'success' | 'error';

interface PromptLoadResult {
    /** この結果がどの認証状態のものか。現在の認証と異なる結果は表示に使わない */
    authKey: string | null;
    prompts: Prompt[];
    status: PromptLoadStatus;
    error: string | null;
}

/** 認証状態の変化や後発リクエストによって破棄された読み込みを表す */
class StalePromptLoadError extends Error {
    constructor() {
        super('認証状態が変更されたため、プロンプトの読み込みを中止しました。');
        this.name = 'StalePromptLoadError';
    }
}

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : 'プロンプト一覧の読み込みに失敗しました。';

/**
 * 一覧に出すプロンプト。
 *
 * 🔴 「全文文字起こし」は**組み込み**として先頭に差し込む (設計 §6.2)。
 * Firestore には保存しない — 利用者が編集・削除できる普通のプロンプトにすると、
 * 中身を書き換えられたときに分割パイプラインの前提が崩れる。
 *
 * 🔴 **取得が成功したときだけ差し込む。** 読み込み中や失敗時に差し込むと、
 * 「一覧が空なのに1件だけある」状態になり、利用者は他のプロンプトが消えたと読む。
 */
export function resolveAvailablePrompts(
    loadedPrompts: readonly Prompt[],
    status: PromptLoadStatus,
): Prompt[] {
    if (status !== 'success') return [...loadedPrompts];
    return withTranscriptPrompt(loadedPrompts);
}

export const usePromptManagement = () => {
    const { user, loading } = useAuth();
    const authKey = loading ? null : (user?.uid ?? 'GUEST');

    const [result, setResult] = useState<PromptLoadResult>({
        authKey: null,
        prompts: [],
        status: 'idle',
        error: null,
    });
    const [bulkSelectedPromptIds, setBulkSelectedPromptIds] = useState<string[]>([]);
    // 認証が変わるたびに effect のクリーンアップが番号を進めるので、
    // 古い認証で始まった読み込みは番号の不一致で判別できる
    const requestSequenceRef = useRef(0);
    const selectionTouchedForAuthRef = useRef(false);

    // 別の認証状態で取得した一覧は表示しない（他ユーザーのプロンプトを残さない）
    const isResultCurrent = result.authKey === authKey;
    const loadedPrompts = authKey === null || !isResultCurrent ? [] : result.prompts;
    const availablePrompts = resolveAvailablePrompts(
        loadedPrompts,
        isResultCurrent ? result.status : 'loading',
    );
    // V5: 認証が未解決の間は結果が確定していない。idle と言い切らず読み込み中として扱う
    const status: PromptLoadStatus = authKey === null
        ? 'loading'
        : (isResultCurrent ? result.status : 'loading');
    const error = authKey !== null && isResultCurrent ? result.error : null;

    const loadPrompts = useCallback(async (): Promise<Prompt[]> => {
        if (authKey === null) {
            throw new StalePromptLoadError();
        }

        const requestSequence = ++requestSequenceRef.current;

        let prompts: Prompt[];
        try {
            prompts = await getPrompts();
        } catch (loadError) {
            // H10: 取得失敗を空配列の成功として扱わない。選択は触らずエラーとして残す
            if (requestSequence === requestSequenceRef.current) {
                setResult({
                    authKey,
                    prompts: [],
                    status: 'error',
                    error: getErrorMessage(loadError),
                });
                promptManagementLogger.error('プロンプト一覧の読み込みに失敗', loadError, {
                    userId: user?.uid,
                });
            }
            throw loadError;
        }

        if (requestSequence !== requestSequenceRef.current) {
            throw new StalePromptLoadError();
        }

        setResult({ authKey, prompts, status: 'success', error: null });

        // 成功したときだけ選択を整理する
        setBulkSelectedPromptIds(previousIds => {
            const validIds = new Set(prompts.flatMap(prompt => (prompt.id ? [prompt.id] : [])));
            const nextIds = previousIds.filter(id => validIds.has(id));

            // 既定で選ぶのは管理テンプレート由来 (isDefault) の先頭だけ。
            // 一覧は作成日時の新しい順なので、先頭 (prompts[0]) を選ぶと
            // ゲストが最後に作った任意のプロンプトが全員の既定になってしまう。
            // isDefault が 1 つも無ければ勝手に選ばず未選択のままにする。
            const defaultPromptId = prompts.find(prompt => prompt.isDefault && prompt.id)?.id;
            if (nextIds.length === 0 && !selectionTouchedForAuthRef.current && defaultPromptId) {
                return [defaultPromptId];
            }

            return nextIds;
        });

        return prompts;
    }, [authKey, user?.uid]);

    useEffect(() => {
        if (authKey === null) return;

        // 認証が変わったら、既定プロンプトの自動選択をやり直せる状態に戻す
        selectionTouchedForAuthRef.current = false;

        // loadPrompts は await の後でしか状態を更新しないため、同期的な再レンダリングは起きない
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void loadPrompts().catch(() => {
            // 状態は loadPrompts が設定済み。ここでは未処理の Promise 拒否だけを防ぐ
        });

        return () => {
            requestSequenceRef.current += 1;
        };
    }, [authKey, loadPrompts]);

    /** 例外を投げずに結果だけ返す再試行。失敗時は null */
    const retry = useCallback(async (): Promise<Prompt[] | null> => {
        // 認証が変わった直後は表示側が既に loading と解釈しているため、
        // 同じ認証状態での再試行だけを「読み込み中」に落とす
        setResult(previous =>
            previous.authKey === authKey
                ? { ...previous, status: 'loading', error: null }
                : previous
        );

        try {
            return await loadPrompts();
        } catch {
            return null;
        }
    }, [authKey, loadPrompts]);

    const toggleBulkPrompt = useCallback((promptId: string) => {
        selectionTouchedForAuthRef.current = true;
        setBulkSelectedPromptIds(previousIds =>
            previousIds.includes(promptId)
                ? previousIds.filter(id => id !== promptId)
                : [...previousIds, promptId]
        );
    }, []);

    return {
        data: availablePrompts,
        status,
        error,
        retry,
        availablePrompts,
        bulkSelectedPromptIds,
        toggleBulkPrompt,
        /** 成功時のみプロンプト配列を返す。失敗時は null（空配列を成功として扱わない） */
        reloadPrompts: retry,
    };
};

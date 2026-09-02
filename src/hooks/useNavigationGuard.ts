'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * S2-2: 処理中の画面から離脱するときに確認を挟む。
 * `documents/page.tsx` の未保存ガード (beforeunload + SPA内クリック監視 + popstate の sentinel 保留) を
 * 汎用化して移したもの。加えて、画面遷移ではない離脱 (ログイン/ログアウト/退会) を
 * requestGuardedAction 経由で問い合わせられるようにしている。
 */

export const NAVIGATION_INTENT_EVENT = 'app:navigation-intent';

export type GuardedActionKind = 'signin' | 'signout' | 'account-deletion';

export interface NavigationIntentDetail {
    kind: GuardedActionKind;
    proceed: () => void;
}

/**
 * 画面遷移ではない離脱 (認証の変更など) を、ガード中の画面に問い合わせてから実行する。
 * 誰も preventDefault しなければその場で proceed する。ガード中の画面が止めたときは、
 * 利用者が承認した時点でその画面が proceed を呼ぶ。
 */
export function requestGuardedAction(kind: GuardedActionKind, proceed: () => void): void {
    if (typeof window === 'undefined') {
        proceed();
        return;
    }
    const event = new CustomEvent<NavigationIntentDetail>(NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { kind, proceed },
    });
    if (window.dispatchEvent(event)) proceed();
}

type HistoryGuardRole = 'base' | 'sentinel';

type HistoryGuardSession = {
    id: string;
    originalState: unknown;
    url: string;
};

type HistoryExitApproval = 'none' | 'history' | 'router';

export type LeaveConfirmationRequest =
    | { kind: 'history' }
    | { kind: 'router'; target: HTMLElement }
    | { kind: 'action'; detail: NavigationIntentDetail };

type LeaveConfirmationActions = {
    approve: () => void;
    deny: () => void;
};

export interface UseNavigationGuardOptions {
    /** true の間だけ離脱を確認する。false になった時点で保留中の確認も閉じる */
    active: boolean;
    /** history.state に埋める印のキー。画面ごとに固有の名前にする */
    stateKey: string;
}

export interface NavigationGuardHandle {
    leaveConfirmation: LeaveConfirmationRequest | null;
    approveLeave: () => void;
    denyLeave: () => void;
}

export function useNavigationGuard({ active, stateKey }: UseNavigationGuardOptions): NavigationGuardHandle {
    const pathname = usePathname();
    const historyGuardId = useId();
    const [leaveConfirmation, setLeaveConfirmation] = useState<LeaveConfirmationRequest | null>(null);
    const leaveConfirmationActionsRef = useRef<LeaveConfirmationActions | null>(null);
    const historyGuardSessionRef = useRef<HistoryGuardSession | null>(null);
    const historyExitApprovalRef = useRef<HistoryExitApproval>('none');
    const routerExitStartPathnameRef = useRef<string | null>(null);
    const componentMountedRef = useRef(false);
    const activeRef = useRef(active);

    useLayoutEffect(() => {
        activeRef.current = active;
    }, [active]);

    useEffect(() => {
        componentMountedRef.current = true;
        return () => {
            componentMountedRef.current = false;
            routerExitStartPathnameRef.current = null;
        };
    }, []);

    useEffect(() => {
        const navigationStartPathname = routerExitStartPathnameRef.current;
        if (navigationStartPathname === null || pathname === navigationStartPathname) return;

        routerExitStartPathnameRef.current = null;
        historyExitApprovalRef.current = 'none';
    }, [pathname]);

    useEffect(() => {
        if (!active) return;

        const guardId = historyGuardId;
        const readGuardRole = (state: unknown): HistoryGuardRole | null => {
            if (!state || typeof state !== 'object') return null;
            const marker = (state as Record<string, unknown>)[stateKey];
            if (!marker || typeof marker !== 'object') return null;
            const markerRecord = marker as Record<string, unknown>;
            if (markerRecord.id !== guardId) return null;
            return markerRecord.role === 'base' || markerRecord.role === 'sentinel'
                ? markerRecord.role
                : null;
        };
        const createGuardedState = (
            originalState: unknown,
            role: HistoryGuardRole,
        ): Record<string, unknown> => ({
            ...(originalState && typeof originalState === 'object' ? originalState : {}),
            [stateKey]: { id: guardId, role },
        });

        const installGuardSession = (): HistoryGuardSession | null => {
            const currentSession = historyGuardSessionRef.current;
            const existingRole = readGuardRole(window.history.state);
            if (currentSession?.id === guardId && existingRole) return currentSession;

            const originalState: unknown = window.history.state;
            const url = window.location.href;
            const nextSession = { id: guardId, originalState, url };
            try {
                window.history.replaceState(createGuardedState(originalState, 'base'), '', url);
                window.history.pushState(createGuardedState(originalState, 'sentinel'), '', url);
                historyGuardSessionRef.current = nextSession;
                return nextSession;
            } catch {
                historyGuardSessionRef.current = null;
                try {
                    window.history.replaceState(originalState, '', url);
                } catch {
                    // 履歴を変更できない環境でもbeforeunloadとクリック監視は有効にする。
                }
                return null;
            }
        };

        const restoreBaseState = (session: HistoryGuardSession): void => {
            try {
                window.history.replaceState(session.originalState, '', session.url);
            } finally {
                if (historyGuardSessionRef.current === session) {
                    historyGuardSessionRef.current = null;
                }
            }
        };

        const cleanupGuardSession = (session: HistoryGuardSession): void => {
            const currentRole = readGuardRole(window.history.state);
            if (currentRole === 'base') {
                restoreBaseState(session);
                return;
            }
            if (currentRole !== 'sentinel') {
                if (historyGuardSessionRef.current === session) {
                    historyGuardSessionRef.current = null;
                }
                return;
            }

            const handleSentinelCleanup = (event: PopStateEvent): void => {
                if (readGuardRole(event.state) !== 'base') return;
                window.removeEventListener('popstate', handleSentinelCleanup);
                restoreBaseState(session);
            };
            window.addEventListener('popstate', handleSentinelCleanup);
            window.history.back();
        };

        installGuardSession();
        historyExitApprovalRef.current = 'none';
        let isRecoveringToSentinel = false;
        let historyExitTraversalObserved = false;
        let bypassNextRouterClick = false;
        let pendingRouterTarget: HTMLElement | null = null;
        let historyExitFallbackTimer: number | null = null;
        let pendingLeaveRequest: LeaveConfirmationRequest | null = null;
        let pendingHistoryExitDelta = 0;
        let approveHistoryExitAfterRecovery = false;

        // タブを閉じる・リロードする離脱は、ページ破棄前に出せるUIがブラウザ標準の
        // 確認ダイアログしか存在しない（カスタムUIは描画される前に破棄される）ため、
        // beforeunloadだけはネイティブ挙動を温存する。
        // 承認状態では免除しない: 承認されたのはSPA内遷移であってリロード/クローズ
        // ではなく、遷移が完了すればunmountでこのlistenerごと消える。時間ではなく
        // 「activeでmountされている」という状態だけで判定する。
        const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
            event.preventDefault();
            (event as unknown as { returnValue: boolean }).returnValue = true;
        };

        const requestLeaveConfirmation = (request: LeaveConfirmationRequest): void => {
            pendingLeaveRequest = request;
            setLeaveConfirmation(request);
        };

        const closeLeaveConfirmation = (): void => {
            pendingLeaveRequest = null;
            setLeaveConfirmation(null);
        };

        const scheduleFailedHistoryExitRecovery = (session: HistoryGuardSession): void => {
            if (historyExitFallbackTimer !== null) {
                window.clearTimeout(historyExitFallbackTimer);
            }
            historyExitFallbackTimer = window.setTimeout(() => {
                historyExitFallbackTimer = null;
                if (
                    !componentMountedRef.current
                    || !activeRef.current
                    || historyExitApprovalRef.current !== 'history'
                ) {
                    return;
                }

                if (historyExitTraversalObserved) {
                    // 遷移は観測されたがcomponentが残っている。ただし着地先が別pathnameなら
                    // 旧pageのunmountが遅れているだけであり、そこへ再武装するとpushStateが
                    // Forward側の履歴を切り落として他routeのentryを汚染する。再武装は
                    // query/hash違いの同一route着地（unmountが来ない=承認が恒久残留する
                    // ケース）に限る。trailing slashの揺れは同一routeとして比較する。
                    const normalizePathname = (value: string): string =>
                        value.replace(/\/+$/, '') || '/';
                    let guardedPathname: string | null = null;
                    try {
                        guardedPathname = normalizePathname(new URL(session.url).pathname);
                    } catch {
                        guardedPathname = null;
                    }
                    if (normalizePathname(window.location.pathname) !== guardedPathname) return;

                    historyExitApprovalRef.current = 'none';
                    installGuardSession();
                    return;
                }

                if (
                    window.location.href === session.url
                    && readGuardRole(window.history.state) === 'sentinel'
                ) {
                    // 履歴前項目が足りずgo()が何も遷移しなかった場合。承認前にsentinelへ
                    // 復帰済みなので、承認状態だけを解除してガードを再武装する。
                    historyExitApprovalRef.current = 'none';
                }
            }, 250);
        };

        const replayRouterNavigation = (
            session: HistoryGuardSession | null,
            target: HTMLElement,
        ): void => {
            pendingRouterTarget = null;
            if (session && readGuardRole(window.history.state) === 'base') {
                restoreBaseState(session);
            } else if (session && historyGuardSessionRef.current === session) {
                historyGuardSessionRef.current = null;
            }

            window.queueMicrotask(() => {
                if (!componentMountedRef.current) {
                    historyExitApprovalRef.current = 'none';
                    return;
                }
                if (!target.isConnected) {
                    // replay対象が再描画で消えた。遷移は起こせないので、承認を残して
                    // beforeunloadと以後のBackが恒久的に確認を迂回する状態にせず、
                    // その場でガードを再武装して留まる。
                    historyExitApprovalRef.current = 'none';
                    if (activeRef.current) installGuardSession();
                    return;
                }
                bypassNextRouterClick = true;
                routerExitStartPathnameRef.current = window.location.pathname;
                target.click();
                // 遷移の完了は時間でなく状態で観測する: pathnameが変われば上のeffectが
                // 承認を解除し、unmountすれば承認はrefごと消える。
            });
        };

        const performApprovedHistoryExit = (): void => {
            const session = historyGuardSessionRef.current;
            historyExitApprovalRef.current = 'history';
            historyExitTraversalObserved = false;
            window.history.go(pendingHistoryExitDelta);
            if (session) scheduleFailedHistoryExitRecovery(session);
        };

        const handlePopState = (event: PopStateEvent): void => {
            const role = readGuardRole(event.state);

            if (historyExitApprovalRef.current === 'router' && pendingRouterTarget) {
                if (role === 'base') {
                    replayRouterNavigation(historyGuardSessionRef.current, pendingRouterTarget);
                    return;
                }
                // replayの往路以外のtraversalが来た(承認直後のBack等)。承認を解除して
                // このtraversalは素通しする(sentinelは承認時に消費済みで保留できない)。
                historyExitApprovalRef.current = 'none';
                pendingRouterTarget = null;
                return;
            }

            if (isRecoveringToSentinel) {
                if (role === 'sentinel') {
                    isRecoveringToSentinel = false;
                    if (approveHistoryExitAfterRecovery) {
                        // 復帰完了前に押された「移動する」をここで実行する
                        approveHistoryExitAfterRecovery = false;
                        performApprovedHistoryExit();
                    }
                } else {
                    // sentinelへ戻る一段ごとに、承認時へ引き継ぐ離脱の深さを積む。
                    pendingHistoryExitDelta -= 1;
                    window.history.forward();
                }
                return;
            }

            if (historyExitApprovalRef.current === 'history') {
                historyExitTraversalObserved = true;
                return;
            }
            if (role === 'sentinel') return;

            // sentinelを設置できなかった環境では遷移を保留できない。
            // popstate経由の離脱は素通しし、beforeunloadとクリック監視だけで守る。
            if (!historyGuardSessionRef.current) return;

            // 画面内ダイアログは非同期なので、先に同期でsentinelへの復帰を開始して遷移を
            // 保留し、意思確認をダイアログへ委ねる。承認時は保留中に積んだ深さぶんだけ
            // history.go()で本来の離脱をやり直す（baseは同一URLの人工entryなので+1深い）。
            //
            // 【既知制約】複数entryを飛び越えるBackで、routerのpopstate listenerが別routeの
            // commitを先に完了させると、この保留は挟めずunmountで確認なしに離脱する。
            pendingHistoryExitDelta = role === 'base' ? -2 : -1;
            isRecoveringToSentinel = true;
            approveHistoryExitAfterRecovery = false;
            window.history.forward();
            requestLeaveConfirmation({ kind: 'history' });
        };

        const handleRouterNavigation = (event: MouseEvent): void => {
            if (bypassNextRouterClick) {
                bypassNextRouterClick = false;
                return;
            }
            if (
                event.defaultPrevented
                || event.button !== 0
                || event.metaKey
                || event.ctrlKey
                || event.shiftKey
                || event.altKey
            ) {
                return;
            }

            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;

            const anchor = target.closest<HTMLAnchorElement>('a[href]');
            if (
                !anchor
                || anchor.hasAttribute('download')
                || (anchor.target && anchor.target !== '_self')
            ) {
                return;
            }

            let isInternalNavigation = false;
            try {
                const destination = new URL(anchor.href, window.location.href);
                isInternalNavigation = destination.origin === window.location.origin
                    && destination.href !== window.location.href;
            } catch {
                isInternalNavigation = false;
            }
            if (!isInternalNavigation) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            // クリックは既に握り潰してあるので履歴は動いていない。承認されたときだけ
            // approve側でclickをreplayする。
            requestLeaveConfirmation({ kind: 'router', target: anchor });
        };

        // ログイン/ログアウト/退会のように遷移を伴わない離脱は、AppHeader が
        // requestGuardedAction で問い合わせてくる。止めたら承認時にこちらが proceed する。
        const handleNavigationIntent = (event: Event): void => {
            const detail = (event as CustomEvent<NavigationIntentDetail>).detail;
            if (!detail || typeof detail.proceed !== 'function') return;
            event.preventDefault();
            requestLeaveConfirmation({ kind: 'action', detail });
        };

        leaveConfirmationActionsRef.current = {
            approve: () => {
                const request = pendingLeaveRequest;
                if (!request) return;

                if (request.kind === 'history') {
                    closeLeaveConfirmation();
                    // sentinelへの復帰走行が終わるまで離脱の深さが確定しない。完了前の承認は
                    // 捨てずに予約し、復帰完了(popstateのsentinel到達)で実行する。
                    if (isRecoveringToSentinel) {
                        approveHistoryExitAfterRecovery = true;
                        return;
                    }
                    performApprovedHistoryExit();
                    return;
                }

                if (request.kind === 'action') {
                    closeLeaveConfirmation();
                    request.detail.proceed();
                    return;
                }

                closeLeaveConfirmation();
                historyExitApprovalRef.current = 'router';
                pendingRouterTarget = request.target;
                const session = historyGuardSessionRef.current;
                if (session && readGuardRole(window.history.state) === 'sentinel') {
                    window.history.back();
                } else {
                    replayRouterNavigation(session, request.target);
                }
            },
            deny: () => {
                // 履歴経由の離脱は既にsentinelへ復帰済み、クリック経由は握り潰し済み、
                // action は proceed を呼ばなければ何も起きない。閉じるだけで「残る」が成立する。
                closeLeaveConfirmation();
            },
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('popstate', handlePopState);
        window.addEventListener(NAVIGATION_INTENT_EVENT, handleNavigationIntent);
        window.document.addEventListener('click', handleRouterNavigation, true);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            window.removeEventListener('popstate', handlePopState);
            window.removeEventListener(NAVIGATION_INTENT_EVENT, handleNavigationIntent);
            window.document.removeEventListener('click', handleRouterNavigation, true);
            leaveConfirmationActionsRef.current = null;
            setLeaveConfirmation(null);
            if (historyExitFallbackTimer !== null) {
                window.clearTimeout(historyExitFallbackTimer);
            }
            routerExitStartPathnameRef.current = null;

            const activeSession = historyGuardSessionRef.current;
            if (!activeSession || activeSession.id !== guardId) return;

            if (activeRef.current) {
                // Strict Modeのeffect再実行では直後にmountedへ戻る。実unmount時だけ
                // 次taskでmarkerを除去し、router承認後の履歴を汚染させない。
                window.setTimeout(() => {
                    if (!componentMountedRef.current) cleanupGuardSession(activeSession);
                }, 0);
                return;
            }

            historyExitApprovalRef.current = 'none';
            cleanupGuardSession(activeSession);
        };
    }, [active, historyGuardId, stateKey]);

    const approveLeave = useCallback(() => {
        leaveConfirmationActionsRef.current?.approve();
    }, []);

    const denyLeave = useCallback(() => {
        leaveConfirmationActionsRef.current?.deny();
        // ガードeffect解体後に閉じ損ねたダイアログも、表示だけは確実に畳む。
        setLeaveConfirmation(null);
    }, []);

    return { leaveConfirmation, approveLeave, denyLeave };
}

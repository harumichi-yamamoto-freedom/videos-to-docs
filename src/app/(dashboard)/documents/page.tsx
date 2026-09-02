'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FilePlus2, FileText } from 'lucide-react';
import { DocumentListSidebar } from '@/components/DocumentListSidebar';
import { Dialog } from '@/components/ui/Dialog';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  DocumentDetailPanel,
  type DocumentDetailPanelHandle,
  type DocumentUpdateMeta,
  type DocumentUpdatePatch,
} from '@/components/DocumentDetailPanel';
import {
  restoreTranscription,
  Transcription,
  updateTranscription,
} from '@/lib/firestore';
import { useAuth } from '@/hooks/useAuth';

type DocumentListState = {
  status: 'loading' | 'success' | 'error';
  count?: number;
};

type DocumentTitlePatch = {
  title: string;
};

const HISTORY_GUARD_STATE_KEY = '__documentsUnsavedChangesGuard';

type HistoryGuardRole = 'base' | 'sentinel';

type HistoryGuardSession = {
  id: string;
  originalState: unknown;
  url: string;
};

type HistoryExitApproval = 'none' | 'history' | 'router';

type LeaveConfirmationRequest =
  | { kind: 'history' }
  | { kind: 'router'; target: HTMLElement };

type LeaveConfirmationActions = {
  approve: () => void;
  deny: () => void;
};

// pageのdocuments[]へ書き戻す全経路の不変条件:
// 確定していない版印(readBackがnullを返した/そもそも版を検証していない経路)は、
// 必ず updatedAt: undefined へ剥がして未確定に落とす。1経路でも現在entryの
// updatedAt(pollで他者版へ前進していることがある)を温存すると、「自分の内容+
// 他者の版印」の捏造版が生まれ、panelがその版をpinして次の保存が無警告上書きになる。
// documents[]への合成は必ずこのヘルパを通すこと。
function withCertifiedVersion<T extends Transcription>(
  document: T,
  patch: Partial<Pick<Transcription, 'title' | 'text'>>,
  certifiedUpdatedAt: Transcription['updatedAt'] | null,
): T {
  return {
    ...document,
    ...patch,
    updatedAt: certifiedUpdatedAt ?? undefined,
  };
}

export default function DocumentsPage() {
  const { user, loading: authLoading } = useAuth();
  const pathname = usePathname();
  const ownerKey = authLoading
    ? null
    : JSON.stringify([user ? 'user' : 'guest', user?.uid ?? 'GUEST']);
  const [documents, setDocuments] = useState<Transcription[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [documentUpdateTrigger, setDocumentUpdateTrigger] = useState(0);
  const [listState, setListState] = useState<DocumentListState>({ status: 'loading' });
  const [isDirty, setIsDirty] = useState(false);
  const [pendingDocumentId, setPendingDocumentId] = useState<string | null>(null);
  const [isResolvingSwitch, setIsResolvingSwitch] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [missingDirtyDocument, setMissingDirtyDocument] = useState<Transcription | null>(null);
  const [isResolvingMissingDocument, setIsResolvingMissingDocument] = useState(false);
  const [missingDocumentError, setMissingDocumentError] = useState<string | null>(null);
  const [ownerChangeDraft, setOwnerChangeDraft] = useState<DocumentUpdatePatch | null>(null);
  // 版を確定できなかった保存(readBack null)の警告。文書ごとに保持し、畳むのは
  // 「版印つきの取得成功が届いた時」か「同じ文書の確定保存」だけ。ボタン押下や
  // 別文書の保存で消すと、取得失敗時に最新確認済みという誤認が生まれる。
  const [staleSaveDocumentIds, setStaleSaveDocumentIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [activeOwnerKey, setActiveOwnerKey] = useState(ownerKey);
  const detailPanelRef = useRef<DocumentDetailPanelHandle>(null);
  const listSectionRef = useRef<HTMLDivElement>(null);
  const detailSectionRef = useRef<HTMLDivElement>(null);
  const saveAndSwitchButtonRef = useRef<HTMLButtonElement>(null);
  const switchDialogRef = useRef<HTMLDivElement>(null);
  const switchReturnFocusRef = useRef<HTMLElement | null>(null);
  const switchAttemptRef = useRef(0);
  const missingDocumentAttemptRef = useRef(0);
  const historyGuardId = useId();
  const leaveDialogTitleId = useId();
  const leaveDialogDescriptionId = useId();
  const [leaveConfirmation, setLeaveConfirmation] = useState<LeaveConfirmationRequest | null>(null);
  const leaveConfirmationActionsRef = useRef<LeaveConfirmationActions | null>(null);
  const leaveStayButtonRef = useRef<HTMLButtonElement>(null);
  const historyGuardSessionRef = useRef<HistoryGuardSession | null>(null);
  const historyExitApprovalRef = useRef<HistoryExitApproval>('none');
  const routerExitStartPathnameRef = useRef<string | null>(null);
  const componentMountedRef = useRef(false);
  const hasUnsavedChanges = isDirty || ownerChangeDraft !== null;
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);

  const isOwnerContextChanged = activeOwnerKey !== ownerKey;

  const selectedDocument = useMemo(
    () => isOwnerContextChanged
      ? null
      : documents.find(document => document.id === selectedDocumentId)
        ?? (missingDirtyDocument?.id === selectedDocumentId ? missingDirtyDocument : null),
    [documents, isOwnerContextChanged, missingDirtyDocument, selectedDocumentId],
  );
  const isSelectedDocumentMissing = Boolean(
    !isOwnerContextChanged
    &&
    missingDirtyDocument?.id && missingDirtyDocument.id === selectedDocumentId,
  );

  const focusDetailOnMobile = useCallback(() => {
    if (!window.matchMedia('(max-width: 1023px)').matches) return;

    window.requestAnimationFrame(() => {
      detailSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      detailPanelRef.current?.focus();
    });
  }, []);

  const selectDocument = useCallback((documentId: string) => {
    setSelectedDocumentId(documentId);
    focusDetailOnMobile();
  }, [focusDetailOnMobile]);

  const handleDocumentClick = useCallback((document: Transcription) => {
    if (!document.id) return;

    if (document.id === selectedDocumentId) {
      focusDetailOnMobile();
      return;
    }

    if (isDirty) {
      const activeElement = window.document?.activeElement;
      switchReturnFocusRef.current = typeof HTMLElement !== 'undefined' && activeElement instanceof HTMLElement
        ? activeElement
        : null;
      switchAttemptRef.current += 1;
      setPendingDocumentId(document.id);
      setSwitchError(null);
      return;
    }

    selectDocument(document.id);
  }, [focusDetailOnMobile, isDirty, selectDocument, selectedDocumentId]);

  const handleDocumentsChange = useCallback((nextDocuments: Transcription[]) => {
    setDocuments(nextDocuments);

    // 版印つきの取得成功が届いた文書は「最新を確認できる状態になった」ので、
    // 版未確定警告を畳む(ローカルで剥がしたentryはupdatedAt undefinedのため
    // サーバ由来の版印と区別できる)。
    setStaleSaveDocumentIds(currentIds => {
      if (currentIds.size === 0) return currentIds;
      let nextIds: Set<string> | null = null;
      for (const warnedDocumentId of currentIds) {
        const refreshedDocument = nextDocuments.find(
          document => document.id === warnedDocumentId,
        );
        if (refreshedDocument && refreshedDocument.updatedAt !== undefined) {
          (nextIds ??= new Set(currentIds)).delete(warnedDocumentId);
        }
      }
      return nextIds ?? currentIds;
    });

    const selectedDocumentStillExists = Boolean(
      selectedDocumentId && nextDocuments.some(document => document.id === selectedDocumentId),
    );
    const pendingDocumentStillExists = Boolean(
      pendingDocumentId && nextDocuments.some(document => document.id === pendingDocumentId),
    );

    if (selectedDocumentId && !selectedDocumentStillExists && isDirty && selectedDocument) {
      setMissingDirtyDocument(selectedDocument);
      setMissingDocumentError(null);
    } else {
      setMissingDirtyDocument(null);
      setSelectedDocumentId(currentId => {
        if (!currentId) return null;
        return nextDocuments.some(document => document.id === currentId) ? currentId : null;
      });
    }

    if (pendingDocumentId && (!pendingDocumentStillExists || !selectedDocumentStillExists)) {
      switchAttemptRef.current += 1;
      switchReturnFocusRef.current = null;
      setPendingDocumentId(null);
      setIsResolvingSwitch(false);
      setSwitchError(null);
      window.requestAnimationFrame(() => {
        if (selectedDocumentStillExists) detailPanelRef.current?.focus();
      });
    }
  }, [isDirty, pendingDocumentId, selectedDocument, selectedDocumentId]);

  const handleDocumentUpdated = useCallback((
    documentId: string,
    patch: DocumentTitlePatch,
  ) => {
    if (!documentId) return;
    // 改名通知は版を検証しない経路なので、不変条件どおり版印は未確定に落とす
    // (サイドバー側が予約する静かな再取得が実状態を埋め戻す)。
    setDocuments(currentDocuments => currentDocuments.map(document =>
      document.id === documentId
        ? withCertifiedVersion(document, { title: patch.title }, null)
        : document,
    ));
    setMissingDirtyDocument(currentDocument =>
      currentDocument?.id === documentId
        ? withCertifiedVersion(currentDocument, { title: patch.title }, null)
        : currentDocument,
    );
  }, []);

  const handleDocumentDeleted = useCallback((documentId: string) => {
    if (selectedDocumentId === documentId) {
      missingDocumentAttemptRef.current += 1;
      detailPanelRef.current?.discard();
      setIsDirty(false);
      setMissingDirtyDocument(null);
      setIsResolvingMissingDocument(false);
      setMissingDocumentError(null);
    }
    setDocuments(currentDocuments => currentDocuments.filter(document => document.id !== documentId));
    setSelectedDocumentId(currentId => currentId === documentId ? null : currentId);
    setPendingDocumentId(currentId => currentId === documentId ? null : currentId);
  }, [selectedDocumentId]);

  const handleDocumentUpdate = useCallback(async (
    documentId: string,
    patch: DocumentUpdatePatch,
    meta: DocumentUpdateMeta,
  ) => {
    const missingDocumentToRestore = missingDirtyDocument?.id === documentId
      ? missingDirtyDocument
      : null;

    const persistedPatch = {
      title: patch.title,
      transcription: patch.text,
    };
    let savedUpdatedAt: Awaited<ReturnType<typeof updateTranscription>> = null;
    if (missingDocumentToRestore) {
      savedUpdatedAt = await restoreTranscription(
        documentId,
        missingDocumentToRestore,
        persistedPatch,
        // 復元先に同IDが残っていた場合(圏外化)は、通常保存と同じ競合検査を課す。
        { expectedUpdatedAt: meta.expectedUpdatedAt },
      );
    } else {
      // 楽観的並行性制御: 期待値はポーリングで前進するdocuments[]からではなく、
      // エディタがdraftの根拠として固定した版(meta)から受け取る。ライブ値だと
      // 他者の更新へ勝手に追随し、競合検査が自己無効化する。
      savedUpdatedAt = await updateTranscription(documentId, persistedPatch, {
        expectedUpdatedAt: meta.expectedUpdatedAt,
      });
    }

    // savedUpdatedAt=null は「保存は通ったが自分の版を確定できなかった」信号。
    // 不変条件どおり withCertifiedVersion で合成し、未確定の版印は必ず剥がす。
    setDocuments(currentDocuments => {
      let didUpdateDocument = false;
      const nextDocuments = currentDocuments.map(document => {
        if (document.id !== documentId) return document;
        didUpdateDocument = true;
        return withCertifiedVersion(
          document,
          { title: patch.title, text: patch.text },
          savedUpdatedAt,
        );
      });

      if (didUpdateDocument || !missingDocumentToRestore) return nextDocuments;
      return [
        withCertifiedVersion(
          missingDocumentToRestore,
          { title: patch.title, text: patch.text },
          savedUpdatedAt,
        ),
        ...nextDocuments,
      ];
    });
    setStaleSaveDocumentIds(currentIds => {
      const nextIds = new Set(currentIds);
      if (savedUpdatedAt) nextIds.delete(documentId);
      else nextIds.add(documentId);
      return nextIds;
    });
    if (missingDocumentToRestore) {
      setMissingDirtyDocument(null);
      setMissingDocumentError(null);
    }
    setDocumentUpdateTrigger(current => current + 1);
  }, [missingDirtyDocument]);

  const restoreSwitchFocus = useCallback(() => {
    const returnFocusElement = switchReturnFocusRef.current;
    switchReturnFocusRef.current = null;
    window.requestAnimationFrame(() => returnFocusElement?.focus());
  }, []);

  const closeSwitchDialog = useCallback(() => {
    if (isResolvingSwitch) return;
    switchAttemptRef.current += 1;
    setPendingDocumentId(null);
    setSwitchError(null);
    restoreSwitchFocus();
  }, [isResolvingSwitch, restoreSwitchFocus]);

  const finishSwitch = useCallback(() => {
    const nextDocumentId = pendingDocumentId;
    switchAttemptRef.current += 1;
    missingDocumentAttemptRef.current += 1;
    setPendingDocumentId(null);
    setSwitchError(null);
    setMissingDirtyDocument(null);
    setIsResolvingMissingDocument(false);
    setMissingDocumentError(null);
    if (nextDocumentId && documents.some(document => document.id === nextDocumentId)) {
      selectDocument(nextDocumentId);
      window.requestAnimationFrame(() => detailPanelRef.current?.focus());
    } else {
      restoreSwitchFocus();
    }
    switchReturnFocusRef.current = null;
  }, [documents, pendingDocumentId, restoreSwitchFocus, selectDocument]);

  const handleSaveAndSwitch = useCallback(async () => {
    const switchAttempt = switchAttemptRef.current;
    setIsResolvingSwitch(true);
    setSwitchError(null);
    const saved = await detailPanelRef.current?.save();
    if (switchAttemptRef.current !== switchAttempt) return;
    setIsResolvingSwitch(false);

    if (!saved) {
      setSwitchError('保存できませんでした。内容を確認して、もう一度お試しください。');
      return;
    }

    finishSwitch();
  }, [finishSwitch]);

  const handleDiscardAndSwitch = useCallback(() => {
    detailPanelRef.current?.discard();
    finishSwitch();
  }, [finishSwitch]);

  const handleSaveMissingDocument = useCallback(async () => {
    const attempt = ++missingDocumentAttemptRef.current;
    setIsResolvingMissingDocument(true);
    setMissingDocumentError(null);
    const saved = await detailPanelRef.current?.save();
    if (missingDocumentAttemptRef.current !== attempt) return;

    setIsResolvingMissingDocument(false);
    if (!saved) {
      setMissingDocumentError('保存できませんでした。編集内容は保持されています。');
      return;
    }

    setIsDirty(false);
    setMissingDirtyDocument(null);
  }, []);

  const handleDiscardMissingDocument = useCallback(() => {
    missingDocumentAttemptRef.current += 1;
    detailPanelRef.current?.discard();
    setIsResolvingMissingDocument(false);
    setMissingDocumentError(null);
    setMissingDirtyDocument(null);
    setSelectedDocumentId(null);
    setIsDirty(false);
  }, []);

  const handleDiscardOwnerChangeDraft = useCallback(() => {
    setOwnerChangeDraft(null);
  }, []);

  const handleDetailDraftDiscarded = useCallback(() => {
    if (!missingDirtyDocument) return;
    // 詳細パネル側の破棄で編集は消えているのに、欠落バナーが次のポーリング（最大5秒）
    // まで「未保存の変更があります」と主張し続けるのを防ぎ、同期で畳んで選択も外す。
    missingDocumentAttemptRef.current += 1;
    setIsResolvingMissingDocument(false);
    setMissingDocumentError(null);
    setMissingDirtyDocument(null);
    setSelectedDocumentId(null);
  }, [missingDirtyDocument]);

  const handleRequestLatestDocument = useCallback(() => {
    setDocumentUpdateTrigger(current => current + 1);
  }, []);

  const handleReloadAfterStaleSave = useCallback(() => {
    // 押下は再取得の要求。警告は版印つきの取得成功が届いた時だけ畳む。
    setDocumentUpdateTrigger(current => current + 1);
  }, []);

  const handleBackToList = useCallback(() => {
    if (!window.matchMedia('(max-width: 1023px)').matches) return;
    listSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    listSectionRef.current?.focus({ preventScroll: true });
  }, []);

  const handleApproveLeave = useCallback(() => {
    leaveConfirmationActionsRef.current?.approve();
  }, []);

  const handleDenyLeave = useCallback(() => {
    leaveConfirmationActionsRef.current?.deny();
    // ガードeffect解体後に閉じ損ねたダイアログも、表示だけは確実に畳む。
    setLeaveConfirmation(null);
  }, []);

  useLayoutEffect(() => {
    if (!isOwnerContextChanged) return;

    if (isDirty) {
      const draft = detailPanelRef.current?.getDraft();
      if (draft) setOwnerChangeDraft(draft);
    }

    setActiveOwnerKey(ownerKey);
    setDocuments([]);
    setSelectedDocumentId(null);
    setDocumentUpdateTrigger(0);
    setListState({ status: 'loading' });
    setIsDirty(false);
    setPendingDocumentId(null);
    setIsResolvingSwitch(false);
    setSwitchError(null);
    setMissingDirtyDocument(null);
    setIsResolvingMissingDocument(false);
    setMissingDocumentError(null);
    setStaleSaveDocumentIds(new Set<string>());
  }, [isDirty, isOwnerContextChanged, ownerKey]);

  useLayoutEffect(() => {
    switchAttemptRef.current += 1;
    missingDocumentAttemptRef.current += 1;
    switchReturnFocusRef.current = null;
  }, [activeOwnerKey]);

  useLayoutEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

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
    if (!hasUnsavedChanges) return;

    const guardId = historyGuardId;
    const readGuardRole = (state: unknown): HistoryGuardRole | null => {
      if (!state || typeof state !== 'object') return null;
      const marker = (state as Record<string, unknown>)[HISTORY_GUARD_STATE_KEY];
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
      [HISTORY_GUARD_STATE_KEY]: { id: guardId, role },
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
    // 「dirtyでmountされている」という状態だけで判定する。
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
          || !hasUnsavedChangesRef.current
          || historyExitApprovalRef.current !== 'history'
        ) {
          return;
        }

        if (historyExitTraversalObserved) {
          // 遷移は観測されたがcomponentが残っている。ただし着地先が別pathnameなら
          // 旧pageのunmountが遅れているだけであり、そこへ再武装するとpushStateが
          // Forward側の履歴を切り落として他routeのentryを汚染する。再武装は
          // query/hash違いの同一route着地（unmountが来ない=承認が恒久残留する
          // ケース）に限る。
          // trailing slashの揺れ(/documents と /documents/)は同一routeとして
          // 比較する。厳密一致だと同一tree別表記への着地で再武装されず、
          // 承認状態が残って以後の確認を迂回してしまう。
          const normalizePathname = (pathname: string): string =>
            pathname.replace(/\/+$/, '') || '/';
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
          if (hasUnsavedChangesRef.current) installGuardSession();
          return;
        }
        bypassNextRouterClick = true;
        routerExitStartPathnameRef.current = window.location.pathname;
        target.click();
        // 遷移の完了は時間でなく状態で観測する: pathnameが変われば上のeffectが
        // 承認を解除し、unmountすれば承認はrefごと消える。250ms等の時刻でguardを
        // 履歴へ再挿入すると、prefetch無しの正常な遅い遷移が完了した後方に
        // base/sentinelが残り、Backで/documentsを二重に踏む。遷移が起こらない
        // 残留状態でも危険は無い: リロード/クローズはbeforeunloadが常時確認し、
        // 次のクリックは監視が改めて確認し、popstateは下の分岐が承認を解除する。
      });
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
            // 復帰完了前に押された「移動する」をここで実行する(無言で捨てると
            // 利用者には押しても効かないボタンになる)。
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

      // sentinelを設置できなかった環境では遷移を保留できない(存在しないsentinelへ
      // forwardで戻ろうとすると履歴末尾で復帰フラグが永久に立ったままになる)。
      // popstate経由の離脱は素通しし、beforeunloadとクリック監視だけで守る。
      if (!historyGuardSessionRef.current) return;

      // popstateの時点で答えが要るのはwindow.confirmだから成立していた同期判断。
      // 画面内ダイアログは非同期なので、先に同期でsentinelへの復帰を開始して遷移を
      // 保留し、意思確認をダイアログへ委ねる。承認時は保留中に積んだ深さぶんだけ
      // history.go()で本来の離脱をやり直す（baseは同一URLの人工entryなので+1深い）。
      //
      // 【既知制約】複数entryを飛び越えるBackで、routerのpopstate listener(登録が
      // このpageより先)が別routeのcommitを先に完了させると、この保留は挟めず
      // unmountで確認なしに離脱する(page.test.tsxの同名テストが記録)。一段Backは
      // sentinelが同一URLのためrouterが反応せず守れる。リロード/クローズは
      // beforeunload、SPA内クリックはクリック監視が守る。この窓だけは実ブラウザ
      // 検証を要する。
      pendingHistoryExitDelta = role === 'base' ? -2 : -1;
      isRecoveringToSentinel = true;
      approveHistoryExitAfterRecovery = false;
      window.history.forward();
      requestLeaveConfirmation({ kind: 'history' });
    };

    const performApprovedHistoryExit = (): void => {
      const session = historyGuardSessionRef.current;
      historyExitApprovalRef.current = 'history';
      historyExitTraversalObserved = false;
      window.history.go(pendingHistoryExitDelta);
      if (session) scheduleFailedHistoryExitRecovery(session);
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
      let isInternalNavigation = false;
      if (
        anchor
        && !anchor.hasAttribute('download')
        && (!anchor.target || anchor.target === '_self')
      ) {
        try {
          const destination = new URL(anchor.href, window.location.href);
          isInternalNavigation = destination.origin === window.location.origin
            && destination.href !== window.location.href;
        } catch {
          isInternalNavigation = false;
        }
      }

      const headerNavigationButton = target.closest<HTMLButtonElement>([
        'header nav > button',
        '#app-header-team-menu > button',
        '#app-header-mobile-team-menu > button',
      ].join(','));
      const isHeaderNavigation = Boolean(
        headerNavigationButton
        && headerNavigationButton.getAttribute('aria-current') !== 'page'
        && !headerNavigationButton.classList.contains('bg-blue-100')
        && !headerNavigationButton.classList.contains('bg-blue-50'),
      );

      if (!isInternalNavigation && !isHeaderNavigation) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // クリックは既に握り潰してあるので履歴は動いていない。承認されたときだけ
      // approve側でclickをreplayする。
      const navigationTarget = anchor ?? headerNavigationButton;
      if (!navigationTarget) return;
      requestLeaveConfirmation({ kind: 'router', target: navigationTarget });
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
        // 履歴経由の離脱は既にsentinelへ復帰済み、クリック経由は握り潰し済み。
        // どちらも閉じるだけで「このページに残る」が成立する。
        closeLeaveConfirmation();
      },
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('popstate', handlePopState);
    window.document.addEventListener('click', handleRouterNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('popstate', handlePopState);
      window.document.removeEventListener('click', handleRouterNavigation, true);
      leaveConfirmationActionsRef.current = null;
      setLeaveConfirmation(null);
      if (historyExitFallbackTimer !== null) {
        window.clearTimeout(historyExitFallbackTimer);
      }
      routerExitStartPathnameRef.current = null;

      const activeSession = historyGuardSessionRef.current;
      if (!activeSession || activeSession.id !== guardId) return;

      if (hasUnsavedChangesRef.current) {
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
  }, [hasUnsavedChanges, historyGuardId]);

  useEffect(() => {
    if (!pendingDocumentId) return;
    if (isResolvingSwitch) {
      switchDialogRef.current?.focus();
    } else {
      saveAndSwitchButtonRef.current?.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isResolvingSwitch) {
        closeSwitchDialog();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusableElements = Array.from(
        switchDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
      );
      if (focusableElements.length === 0) {
        event.preventDefault();
        switchDialogRef.current?.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && window.document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && window.document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeSwitchDialog, isResolvingSwitch, pendingDocumentId]);

  const isConfirmedEmpty = listState.status === 'success'
    && listState.count === 0
    && documents.length === 0
    && selectedDocument === null
    && !isSelectedDocumentMissing;

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        icon={FileText}
        title="文書"
        description="生成された文書の閲覧・編集・PDF出力を行います"
      />
      {ownerChangeDraft && (
        <section
          role="alert"
          aria-labelledby="owner-change-draft-title"
          className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 shadow-sm"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 id="owner-change-draft-title" className="text-sm font-bold">
                アカウント切替により未保存の変更は保存できません
              </h2>
              <p className="mt-1 text-xs leading-5 text-amber-800">
                切替前に編集中だった内容を退避しました。必要な内容をコピーしてから破棄してください。
              </p>
            </div>
            <button
              type="button"
              onClick={handleDiscardOwnerChangeDraft}
              className="min-h-11 shrink-0 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              退避内容を破棄
            </button>
          </div>
          <div className="mt-3 grid gap-3">
            <label className="grid gap-1 text-xs font-medium text-amber-900">
              編集中のタイトル
              <input
                readOnly
                value={ownerChangeDraft.title}
                className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900"
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-amber-900">
              編集中の本文（選択してコピーできます）
              <textarea
                readOnly
                value={ownerChangeDraft.text}
                rows={8}
                data-testid="owner-change-draft-body"
                className="max-h-64 resize-y rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-sm leading-6 text-gray-900"
              />
            </label>
          </div>
        </section>
      )}
      <div className="flex flex-col lg:flex-row gap-6">
        <div
          ref={listSectionRef}
          tabIndex={-1}
          className="lg:w-3/10 w-full scroll-mt-4 focus:outline-none"
        >
          <div className="bg-white rounded-xl shadow-lg overflow-hidden h-[calc(100vh-125px)] min-h-[532px]">
            <DocumentListSidebar
              onDocumentClick={handleDocumentClick}
              onDocumentUpdated={handleDocumentUpdated}
              onDocumentDeleted={handleDocumentDeleted}
              onDocumentsChange={handleDocumentsChange}
              onListStateChange={setListState}
              updateTrigger={documentUpdateTrigger}
              selectedDocumentId={isOwnerContextChanged ? null : selectedDocumentId}
              isSelectedDocumentDirty={!isOwnerContextChanged && isDirty}
            />
          </div>
        </div>
        <div
          ref={detailSectionRef}
          className="lg:w-7/10 w-full scroll-mt-4"
        >
          <div className="h-[calc(100vh-125px)] min-h-[532px]">
            {isConfirmedEmpty ? (
              <div className="bg-white rounded-xl shadow-lg p-10 h-full flex flex-col items-center justify-center text-center text-gray-500">
                <FilePlus2 className="w-12 h-12 mb-4 text-purple-300" />
                <p className="text-sm font-medium text-gray-700">生成された文書はまだありません。</p>
                <p className="text-xs mt-2 text-gray-500">ホームから動画や音声を変換して文書を生成できます。</p>
                <Link
                  href="/home"
                  className="mt-5 min-h-11 inline-flex items-center justify-center rounded-lg bg-purple-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
                >
                  ホームで文書を生成
                </Link>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col gap-3">
                {selectedDocumentId !== null
                  && staleSaveDocumentIds.has(selectedDocumentId)
                  && !isSelectedDocumentMissing && (
                  <section
                    role="alert"
                    aria-labelledby="stale-save-warning-title"
                    className="shrink-0 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h2 id="stale-save-warning-title" className="text-sm font-bold">
                          保存は完了しましたが、他の場所で更新された可能性があります
                        </h2>
                        <p className="mt-1 text-xs leading-5 text-amber-800">
                          最新の内容を読み込んで、保存結果をご確認ください。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleReloadAfterStaleSave}
                        className="min-h-11 shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
                      >
                        最新の内容を読み込む
                      </button>
                    </div>
                  </section>
                )}
                {isSelectedDocumentMissing && (
                  <section
                    role="alert"
                    aria-labelledby="missing-dirty-document-title"
                    className="shrink-0 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h2 id="missing-dirty-document-title" className="text-sm font-bold">
                          一覧から消えた文書に未保存の変更があります
                        </h2>
                        <p className="mt-1 text-xs leading-5 text-amber-800">
                          編集内容を保存して一覧へ復元するか、変更を破棄してください。
                        </p>
                        {missingDocumentError && (
                          <p className="mt-2 text-xs font-medium text-red-700">
                            {missingDocumentError}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handleDiscardMissingDocument}
                          disabled={isResolvingMissingDocument}
                          className="min-h-11 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                        >
                          変更を破棄
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveMissingDocument}
                          disabled={isResolvingMissingDocument}
                          className="min-h-11 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:opacity-50"
                        >
                          {isResolvingMissingDocument ? '保存中…' : '保存して復元'}
                        </button>
                      </div>
                    </div>
                  </section>
                )}
                <div className="min-h-0 flex-1">
                  <DocumentDetailPanel
                    ref={detailPanelRef}
                    document={selectedDocument}
                    onDocumentUpdate={handleDocumentUpdate}
                    onDirtyChange={setIsDirty}
                    onDraftDiscarded={handleDetailDraftDiscarded}
                    onRequestLatestDocument={handleRequestLatestDocument}
                    onBackToList={handleBackToList}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {pendingDocumentId && (
        <div
          ref={switchDialogRef}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unsaved-switch-title"
          aria-describedby="unsaved-switch-description"
        >
          <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl">
            <h2 id="unsaved-switch-title" className="text-lg font-bold text-gray-900">
              未保存の変更があります
            </h2>
            <p id="unsaved-switch-description" className="mt-2 text-sm leading-6 text-gray-600">
              別の文書へ切り替える前に、現在の変更を保存するか破棄するか選択してください。
            </p>
            {switchError && (
              <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {switchError}
              </p>
            )}
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeSwitchDialog}
                disabled={isResolvingSwitch}
                className="min-h-11 rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:opacity-50"
              >
                切り替えをキャンセル
              </button>
              <button
                type="button"
                onClick={handleDiscardAndSwitch}
                disabled={isResolvingSwitch}
                className="min-h-11 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
              >
                破棄して切り替える
              </button>
              <button
                ref={saveAndSwitchButtonRef}
                type="button"
                onClick={handleSaveAndSwitch}
                disabled={isResolvingSwitch}
                className="min-h-11 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 disabled:opacity-50"
              >
                {isResolvingSwitch ? '保存中…' : '保存して切り替える'}
              </button>
            </div>
          </div>
        </div>
      )}

      {leaveConfirmation && (
        <Dialog
          isOpen
          onClose={handleDenyLeave}
          initialFocusRef={leaveStayButtonRef}
          aria-labelledby={leaveDialogTitleId}
          aria-describedby={leaveDialogDescriptionId}
          className="w-[calc(100%-2rem)] max-w-md rounded-xl border-0 bg-white p-6 shadow-2xl"
        >
          <h2 id={leaveDialogTitleId} className="text-lg font-bold text-gray-900">
            未保存の変更があります
          </h2>
          <p id={leaveDialogDescriptionId} className="mt-2 text-sm leading-6 text-gray-600">
            このページから移動しますか？移動すると、保存されていない変更は失われます。
          </p>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              ref={leaveStayButtonRef}
              type="button"
              onClick={handleDenyLeave}
              className="min-h-11 rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            >
              このページに残る
            </button>
            <button
              type="button"
              onClick={handleApproveLeave}
              className="min-h-11 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
            >
              移動する
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

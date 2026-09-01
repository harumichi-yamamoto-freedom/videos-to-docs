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
import { PageHeader } from '@/components/ui/PageHeader';
import {
  DocumentDetailPanel,
  type DocumentDetailPanelHandle,
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

const UNSAVED_NAVIGATION_MESSAGE = '未保存の変更があります。このページから移動しますか？';
const HISTORY_GUARD_STATE_KEY = '__documentsUnsavedChangesGuard';

type HistoryGuardRole = 'base' | 'sentinel';

type HistoryGuardSession = {
  id: string;
  originalState: unknown;
  url: string;
};

type HistoryExitApproval = 'none' | 'history' | 'router';

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
  const historyGuardSessionRef = useRef<HistoryGuardSession | null>(null);
  const historyExitApprovalRef = useRef<HistoryExitApproval>('none');
  const routerExitFallbackTimerRef = useRef<number | null>(null);
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
    setDocuments(currentDocuments => currentDocuments.map(document =>
      document.id === documentId ? { ...document, title: patch.title } : document,
    ));
    setMissingDirtyDocument(currentDocument =>
      currentDocument?.id === documentId
        ? { ...currentDocument, title: patch.title }
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
  ) => {
    const missingDocumentToRestore = missingDirtyDocument?.id === documentId
      ? missingDirtyDocument
      : null;

    const persistedPatch = {
      title: patch.title,
      transcription: patch.text,
    };
    if (missingDocumentToRestore) {
      await restoreTranscription(documentId, missingDocumentToRestore, persistedPatch);
    } else {
      await updateTranscription(documentId, persistedPatch);
    }

    setDocuments(currentDocuments => {
      let didUpdateDocument = false;
      const nextDocuments = currentDocuments.map(document => {
        if (document.id !== documentId) return document;
        didUpdateDocument = true;
        return { ...document, title: patch.title, text: patch.text };
      });

      if (didUpdateDocument || !missingDocumentToRestore) return nextDocuments;
      return [
        { ...missingDocumentToRestore, title: patch.title, text: patch.text },
        ...nextDocuments,
      ];
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

  const handleBackToList = useCallback(() => {
    if (!window.matchMedia('(max-width: 1023px)').matches) return;
    listSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    listSectionRef.current?.focus({ preventScroll: true });
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
      if (routerExitFallbackTimerRef.current !== null) {
        window.clearTimeout(routerExitFallbackTimerRef.current);
        routerExitFallbackTimerRef.current = null;
      }
      routerExitStartPathnameRef.current = null;
    };
  }, []);

  useEffect(() => {
    const navigationStartPathname = routerExitStartPathnameRef.current;
    if (navigationStartPathname === null || pathname === navigationStartPathname) return;

    if (routerExitFallbackTimerRef.current !== null) {
      window.clearTimeout(routerExitFallbackTimerRef.current);
      routerExitFallbackTimerRef.current = null;
    }
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

    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (historyExitApprovalRef.current !== 'none') return;
      event.preventDefault();
      (event as unknown as { returnValue: boolean }).returnValue = true;
    };

    const recoverToSentinel = (): void => {
      historyExitApprovalRef.current = 'none';
      isRecoveringToSentinel = true;
      window.history.forward();
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
          || historyExitTraversalObserved
        ) {
          return;
        }

        if (
          window.location.href === session.url
          && readGuardRole(window.history.state) === 'base'
        ) {
          // baseが履歴先頭だった場合、二段目のbackは発火しない。
          // 承認状態を解除してsentinelへ戻り、ガードを再武装する。
          recoverToSentinel();
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
        if (!target.isConnected || !componentMountedRef.current) return;
        bypassNextRouterClick = true;
        const navigationStartPathname = window.location.pathname;
        routerExitStartPathnameRef.current = navigationStartPathname;
        target.click();

        if (routerExitFallbackTimerRef.current !== null) {
          window.clearTimeout(routerExitFallbackTimerRef.current);
        }
        routerExitFallbackTimerRef.current = window.setTimeout(() => {
          routerExitFallbackTimerRef.current = null;
          if (
            !componentMountedRef.current
            || !hasUnsavedChangesRef.current
            || historyExitApprovalRef.current !== 'router'
          ) {
            return;
          }

          if (
            routerExitStartPathnameRef.current !== navigationStartPathname
            || window.location.pathname !== navigationStartPathname
          ) {
            routerExitStartPathnameRef.current = null;
            historyExitApprovalRef.current = 'none';
            return;
          }

          // replay後も同じcomponentが残っているなら、遷移成否に関係なく
          // guardを再武装して承認状態を永久に残さない。
          routerExitStartPathnameRef.current = null;
          historyExitApprovalRef.current = 'none';
          installGuardSession();
        }, 250);
      });
    };

    const handlePopState = (event: PopStateEvent): void => {
      const role = readGuardRole(event.state);

      if (historyExitApprovalRef.current === 'router' && pendingRouterTarget) {
        if (role === 'base') {
          replayRouterNavigation(historyGuardSessionRef.current, pendingRouterTarget);
        }
        return;
      }

      if (isRecoveringToSentinel) {
        if (role === 'sentinel') {
          isRecoveringToSentinel = false;
        } else {
          window.history.forward();
        }
        return;
      }

      if (historyExitApprovalRef.current === 'history') {
        historyExitTraversalObserved = true;
        return;
      }
      if (role === 'sentinel') return;

      if (role === 'base') {
        if (window.confirm(UNSAVED_NAVIGATION_MESSAGE)) {
          const session = historyGuardSessionRef.current;
          historyExitApprovalRef.current = 'history';
          historyExitTraversalObserved = false;
          window.history.back();
          if (session) scheduleFailedHistoryExitRecovery(session);
        } else {
          isRecoveringToSentinel = true;
          window.history.forward();
        }
        return;
      }

      // 履歴メニュー等でsentinelを飛び越えた場合、キャンセル後は
      // confirmを繰り返さず、forwardを一段ずつ進めてsentinelへ戻す。
      if (window.confirm(UNSAVED_NAVIGATION_MESSAGE)) {
        historyExitApprovalRef.current = 'history';
      } else {
        isRecoveringToSentinel = true;
        window.history.forward();
      }
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

      if (!window.confirm(UNSAVED_NAVIGATION_MESSAGE)) return;

      const navigationTarget = anchor ?? headerNavigationButton;
      if (!navigationTarget) return;
      historyExitApprovalRef.current = 'router';
      pendingRouterTarget = navigationTarget;
      const session = historyGuardSessionRef.current;
      if (session && readGuardRole(window.history.state) === 'sentinel') {
        window.history.back();
      } else {
        replayRouterNavigation(session, navigationTarget);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('popstate', handlePopState);
    window.document.addEventListener('click', handleRouterNavigation, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('popstate', handlePopState);
      window.document.removeEventListener('click', handleRouterNavigation, true);
      if (historyExitFallbackTimer !== null) {
        window.clearTimeout(historyExitFallbackTimer);
      }
      if (routerExitFallbackTimerRef.current !== null) {
        window.clearTimeout(routerExitFallbackTimerRef.current);
        routerExitFallbackTimerRef.current = null;
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
    </div>
  );
}

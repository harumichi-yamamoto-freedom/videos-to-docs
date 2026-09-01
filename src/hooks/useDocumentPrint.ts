'use client';

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import type { Transcription } from '@/lib/firestore';
import { buildPdfFileStem } from '@/lib/pdfExport';

const PDF_EXPORT_ACTIVE_CLASS = 'pdf-export-active';

type PrintOperation = {
    isCancelled: boolean;
    cancelled: Promise<void>;
    cancel: () => void;
};

function waitForPrintLayout(): Promise<void> {
    return new Promise(resolve => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
        });
    });
}

export function useDocumentPrint(document: Transcription | null): {
    printPdf: () => Promise<void>;
    isPreparing: boolean;
} {
    const [isPreparing, setIsPreparing] = useState(false);
    const isMountedRef = useRef(false);
    const activeOperationRef = useRef<PrintOperation | null>(null);

    useEffect(() => {
        isMountedRef.current = true;

        return () => {
            isMountedRef.current = false;
            activeOperationRef.current?.cancel();
        };
    }, []);

    useLayoutEffect(() => {
        activeOperationRef.current?.cancel();
    }, [document]);

    const printPdf = useCallback(async (): Promise<void> => {
        if (!document || activeOperationRef.current) {
            return;
        }

        const domDocument = window.document;
        const bodyHadExportClass = domDocument.body.classList.contains(
            PDF_EXPORT_ACTIVE_CLASS,
        );
        const originalTitle = domDocument.title;
        let isRestored = false;
        let resolveCancellation = (): void => undefined;
        const cancellation = new Promise<void>(resolve => {
            resolveCancellation = resolve;
        });
        const operation: PrintOperation = {
            isCancelled: false,
            cancelled: cancellation,
            cancel: () => undefined,
        };

        const restore = (): void => {
            if (isRestored) {
                return;
            }

            isRestored = true;
            window.removeEventListener('afterprint', restore);

            if (bodyHadExportClass) {
                domDocument.body.classList.add(PDF_EXPORT_ACTIVE_CLASS);
            } else {
                domDocument.body.classList.remove(PDF_EXPORT_ACTIVE_CLASS);
            }

            domDocument.title = originalTitle;

            if (activeOperationRef.current === operation) {
                activeOperationRef.current = null;

                if (isMountedRef.current) {
                    setIsPreparing(false);
                }
            }
        };

        operation.cancel = (): void => {
            operation.isCancelled = true;
            resolveCancellation();
            restore();
        };

        activeOperationRef.current = operation;
        setIsPreparing(true);

        try {
            domDocument.body.classList.add(PDF_EXPORT_ACTIVE_CLASS);
            await Promise.race([waitForPrintLayout(), operation.cancelled]);

            if (
                operation.isCancelled ||
                activeOperationRef.current !== operation
            ) {
                return;
            }

            await Promise.race([
                domDocument.fonts.ready.then(() => undefined),
                operation.cancelled,
            ]);

            if (
                operation.isCancelled ||
                activeOperationRef.current !== operation
            ) {
                return;
            }

            domDocument.title = buildPdfFileStem(document);
            window.addEventListener('afterprint', restore);
            window.print();
        } finally {
            restore();
        }
    }, [document]);

    return { printPdf, isPreparing };
}

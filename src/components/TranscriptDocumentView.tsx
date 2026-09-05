'use client';

/**
 * 文字起こし文書だけに足される表示層。
 *
 * 🔴 **この2つを独立したコンポーネントに切り出しているのは意図的**。
 * `DocumentDetailPanel` のテストはコンポーネントを**素の関数として呼び出して**戻り値の木を歩く方式で、
 * React のディスパッチャが無い。そのためパネル本体で使えるのは、テストがモックしている
 * `useState` / `useEffect` / `useRef` / `useImperativeHandle` だけである。
 * ここに切り出せば、パネルからは「要素を1つ置く」だけになり、フックは実描画のときにしか走らない。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { MarkdownDocument } from '@/components/MarkdownDocument';
import { TranscriptPlayer, transcriptPlayback } from '@/components/TranscriptPlayer';
import { createTranscriptMarkdownComponents } from '@/components/transcriptMarkdownComponents';
import { useTranscriptTextHash } from '@/components/TranscriptReviewPanel';
import { getAudioDownloadURL } from '@/lib/storage';
import {
    hasTranscriptTimestampLinks,
    reviewAnchorsByLine,
    shouldEnableTranscriptUi,
    type TranscriptCandidateDocument,
} from '@/lib/transcriptDocument';
import type { TranscriptReview } from '@/lib/transcriptReviewContract';

export interface TranscriptAwareMarkdownProps {
    markdown: string;
    className?: string;
    /** 話者ラベルの改名。渡さなければラベルはただの強調のまま */
    onRenameSpeaker?: (from: string, to: string) => void;
    /**
     * 要確認候補の段落バッジ用（仕様 B3）。`documentId` と `review` が揃い、
     * **表示本文の SHA-256 が `review.sourceTextHash` と一致するときだけ**段落にバッジを描く。
     * 照合前・不一致（編集済み）・review 無しでは本文の描画は従来どおり。
     */
    documentId?: string;
    review?: TranscriptReview | null;
}

/**
 * 本文の描画。**時刻リンクを持つ文書のときだけ**上書きを当てる。
 * 持たない文書では `components` を渡さないので、描画は既定のまま 1px も変わらない。
 */
export function TranscriptAwareMarkdown({
    markdown,
    className,
    onRenameSpeaker,
    documentId,
    review,
}: TranscriptAwareMarkdownProps): React.ReactElement {
    const sourceHash = typeof review?.sourceTextHash === 'string' && review.sourceTextHash !== ''
        ? review.sourceTextHash
        : null;
    const bodyHash = useTranscriptTextHash(markdown, sourceHash !== null && Boolean(documentId));
    const anchorsEnabled = sourceHash !== null && bodyHash !== null && bodyHash === sourceHash && Boolean(documentId);
    const components = useMemo(
        () => {
            // 上書きは本文に時刻リンクがあるときだけ（段落アンカーはハッシュ一致＝生成本文のときにしか立たないので、この条件に含まれる）。
            // review の有無で本文の描画を変えない（音声 UI の有効化とは別の判定）。
            if (!hasTranscriptTimestampLinks({ text: markdown })) return undefined;
            return createTranscriptMarkdownComponents({
                markdown,
                ...(onRenameSpeaker && { onRename: onRenameSpeaker }),
                ...(anchorsEnabled && documentId && review
                    ? { reviewAnchors: { documentId, anchorsByLine: reviewAnchorsByLine(review.candidates) } }
                    : {}),
            });
        },
        [markdown, onRenameSpeaker, review, documentId, anchorsEnabled],
    );
    return <MarkdownDocument className={className} markdown={markdown} components={components} />;
}

export interface TranscriptAudioBarProps {
    document: TranscriptCandidateDocument | null | undefined;
}

/**
 * 音声 URL の解決結果。「どのパス・何回目の試行に対する結果か」と一緒に持つ（文書切替・再試行直後の取り違え防止）。
 * 結果が無い間（パス／試行が一致する結果が無い）は「読み込み中」と解釈する。
 */
type AudioResolution =
    | { path: string; attempt: number; status: 'ready'; url: string }
    | { path: string; attempt: number; status: 'url_failed' }
    | { path: string; attempt: number; status: 'media_failed' };

/** プレイヤーの帯と同じ位置・同じ大きさの状態表示（読み込み中／再生不可） */
function AudioStatusStrip({ children }: { children: React.ReactNode }): React.ReactElement {
    return (
        <div
            role="status"
            data-testid="transcript-audio-status"
            className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-gray-200 bg-white/95 px-3 py-1.5 text-xs text-gray-600 backdrop-blur-sm print:hidden"
        >
            {children}
        </div>
    );
}

/**
 * 文書の下辺に貼り付く音声の帯。
 *
 * 🔴 出す条件は「音声があるか」ではなく **「本文に時刻リンクがあるか」**（＋保存済み候補の有効時刻・仕様 B3）。
 * `audioStoragePath` は音声から生成した**すべての**文書に入っているため、
 * それを条件にすると既存の議事録文書にも帯が出て見た目が変わる (設計 §6.5-3)。
 *
 * 音声の状態は `transcriptPlayback.audio` に載せ、要確認カードの「音声を再生」の可否に使う（仕様 B3）:
 * URL 取得中は loading、取得失敗・音声要素のロード失敗は unavailable（再試行は URL の再取得だけ。submit は呼ばない）。
 */
export function TranscriptAudioBar({ document }: TranscriptAudioBarProps): React.ReactElement | null {
    const enabled = shouldEnableTranscriptUi(document);
    const storagePath = document?.audioStoragePath;
    // 🔴 解決した URL は「どのパスに対する URL か」と一緒に持つ。
    //    文書を切り替えた直後に、前の文書の音声が鳴るのを防ぐ (URL だけ持つと1描画ぶん古い値が残る)。
    const [resolution, setResolution] = useState<AudioResolution | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!enabled) return;
        if (!storagePath) {
            // 文字起こしだが音声参照が無い: 再生はできない（本文の確認・編集はできる）
            transcriptPlayback.setAudio('unavailable', 'no_audio');
            return () => transcriptPlayback.setAudio('none');
        }
        let cancelled = false;
        transcriptPlayback.setAudio('loading');
        void getAudioDownloadURL(storagePath)
            .then(url => {
                if (!cancelled) setResolution({ path: storagePath, attempt, status: 'ready', url });
            })
            // 音声が取れなくても本文は読める。帯を状態表示にするだけ（例外で文書を落とさない）
            .catch(() => {
                if (cancelled) return;
                setResolution({ path: storagePath, attempt, status: 'url_failed' });
                transcriptPlayback.setAudio('unavailable', 'url_failed');
            });
        return () => {
            cancelled = true;
            // 別文書・再試行へ移るとき、この解決の状態を残さない（次の effect が置き直す）
            transcriptPlayback.setAudio('none');
        };
    }, [enabled, storagePath, attempt]);

    // パスと試行が一致する結果だけを使う。切り替え・再試行の直後は null（＝読み込み中）になる。
    const current = storagePath && resolution?.path === storagePath && resolution.attempt === attempt
        ? resolution
        : null;

    // 音声要素のロード失敗でプレイヤーを外した後も「再生できない」を保つ（プレイヤーの離脱でストアが初期化されるため）
    useEffect(() => {
        if (!enabled || !current || current.status !== 'media_failed') return;
        transcriptPlayback.setAudio('unavailable', 'media_failed');
    }, [enabled, current]);

    if (!enabled) return null;
    if (!storagePath) return null;

    if (!current) {
        return <AudioStatusStrip>音声を読み込んでいます…</AudioStatusStrip>;
    }
    if (current.status === 'ready') {
        const { path: resolvedPath, attempt: resolvedAttempt } = current;
        return (
            <TranscriptPlayer
                key={`${resolvedPath}#${resolvedAttempt}`}
                audioUrl={current.url}
                onMediaError={() => {
                    setResolution(previous =>
                        previous
                            && previous.path === resolvedPath
                            && previous.attempt === resolvedAttempt
                            && previous.status === 'ready'
                            ? { path: resolvedPath, attempt: resolvedAttempt, status: 'media_failed' }
                            : previous);
                }}
            />
        );
    }
    return (
        <AudioStatusStrip>
            <span>音声を再生できません。本文の確認・編集はできます。</span>
            <button
                type="button"
                onClick={() => setAttempt(count => count + 1)}
                className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-purple-700 hover:bg-purple-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            >
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>音声の取得を再試行</span>
            </button>
        </AudioStatusStrip>
    );
}

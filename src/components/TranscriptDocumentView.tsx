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
import { MarkdownDocument } from '@/components/MarkdownDocument';
import { TranscriptPlayer } from '@/components/TranscriptPlayer';
import { createTranscriptMarkdownComponents } from '@/components/transcriptMarkdownComponents';
import { getAudioDownloadURL } from '@/lib/storage';
import { shouldEnableTranscriptUi, type TranscriptCandidateDocument } from '@/lib/transcriptDocument';

export interface TranscriptAwareMarkdownProps {
    markdown: string;
    className?: string;
    /** 話者ラベルの改名。渡さなければラベルはただの強調のまま */
    onRenameSpeaker?: (from: string, to: string) => void;
}

/**
 * 本文の描画。**時刻リンクを持つ文書のときだけ**上書きを当てる。
 * 持たない文書では `components` を渡さないので、描画は既定のまま 1px も変わらない。
 */
export function TranscriptAwareMarkdown({
    markdown,
    className,
    onRenameSpeaker,
}: TranscriptAwareMarkdownProps): React.ReactElement {
    const components = useMemo(
        () => (shouldEnableTranscriptUi({ text: markdown })
            ? createTranscriptMarkdownComponents({
                markdown,
                ...(onRenameSpeaker && { onRename: onRenameSpeaker }),
            })
            : undefined),
        [markdown, onRenameSpeaker],
    );
    return <MarkdownDocument className={className} markdown={markdown} components={components} />;
}

export interface TranscriptAudioBarProps {
    document: TranscriptCandidateDocument | null | undefined;
}

/**
 * 文書の下辺に貼り付く音声の帯。
 *
 * 🔴 出す条件は「音声があるか」ではなく **「本文に時刻リンクがあるか」**。
 * `audioStoragePath` は音声から生成した**すべての**文書に入っているため、
 * それを条件にすると既存の議事録文書にも帯が出て見た目が変わる (設計 §6.5-3)。
 */
export function TranscriptAudioBar({ document }: TranscriptAudioBarProps): React.ReactElement | null {
    const enabled = shouldEnableTranscriptUi(document);
    const storagePath = document?.audioStoragePath;
    // 🔴 解決した URL は「どのパスに対する URL か」と一緒に持つ。
    //    文書を切り替えた直後に、前の文書の音声が鳴るのを防ぐ (URL だけ持つと1描画ぶん古い値が残る)。
    const [resolved, setResolved] = useState<{ path: string; url: string } | null>(null);

    useEffect(() => {
        if (!enabled || !storagePath) return;
        let cancelled = false;
        void getAudioDownloadURL(storagePath)
            .then(url => { if (!cancelled) setResolved({ path: storagePath, url }); })
            // 音声が取れなくても本文は読める。帯が出ないだけにする (例外で文書を落とさない)。
            .catch(() => { if (!cancelled) setResolved(null); });
        return () => { cancelled = true; };
    }, [enabled, storagePath]);

    if (!enabled) return null;
    // パスが一致するときだけ使う。切り替え直後は null になり、帯は消える。
    const audioUrl = storagePath && resolved?.path === storagePath ? resolved.url : null;
    return <TranscriptPlayer audioUrl={audioUrl} />;
}

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BatchTranscriptionProgress, FileProcessingStatus } from '@/types/processing';
import {
    CANCEL_LOCAL_LABEL,
    ProcessingStatusList,
    RESUME_CONFIRMATION_LABEL,
    STOP_CONFIRMATION_LABEL,
} from './ProcessingStatusList';

const createStatus = (overrides: Partial<FileProcessingStatus> = {}): FileProcessingStatus => ({
    fileId: 'f1',
    fileName: 'sample.mp4',
    status: 'transcribing',
    phase: 'text_generation',
    audioConversionProgress: 0,
    transcriptionCount: 0,
    totalTranscriptions: 1,
    completedPromptIds: [],
    promptStates: {},
    savePendingPromptIds: [],
    segmentDuration: 30,
    segments: [],
    completedSegmentIndices: [],
    ...overrides,
});

const render = (
    statuses: FileProcessingStatus[],
    activeFileIds: string[] = []
) => renderToStaticMarkup(
    <ProcessingStatusList
        statuses={statuses}
        onResumeFile={vi.fn()}
        onCancelFile={vi.fn()}
        activeFileIds={activeFileIds}
    />
);

const CANCEL_LABEL = 'このファイルの処理を中止する';

describe('ProcessingStatusList cancel affordance (U7)', () => {
    it('offers cancel for a file that actually holds a job', () => {
        expect(render([createStatus()], ['f1'])).toContain(CANCEL_LABEL);
    });

    it('hides cancel when no job holds the file, so the button is never inert', () => {
        // 占有していないファイルに中止ボタンを出しても押して何も起きない
        expect(render([createStatus()], [])).not.toContain(CANCEL_LABEL);
    });

    it('hides cancel for a file whose job belongs to a different file', () => {
        expect(render([createStatus()], ['other-file'])).not.toContain(CANCEL_LABEL);
    });

    it.each(['completed', 'error', 'canceled'] as const)(
        'never offers cancel for a %s file even if it is still listed as active',
        (status) => {
            expect(render([createStatus({ status })], ['f1'])).not.toContain(CANCEL_LABEL);
        }
    );
});

describe('ProcessingStatusList terminal rendering (H9)', () => {
    it('stops the spinner once the file has failed', () => {
        const markup = render([createStatus({ status: 'error', failedPhase: 'saving', error: '保存に失敗' })]);

        expect(markup).toContain('エラーが発生しました');
        expect(markup).not.toContain('animate-spin');
    });

    it('shows a resume affordance for a canceled file (R6)', () => {
        const markup = render([createStatus({
            status: 'canceled',
            phase: 'canceled',
            savePendingPromptIds: ['prompt-a'],
        })]);

        expect(markup).toContain('再開する');
        expect(markup).toContain('生成済みで保存待ち: 1 件');
    });
});

describe('全文文字起こし（バッチ）の段階表示（仕様 §A1・A4）', () => {
    const createBatch = (overrides: Partial<BatchTranscriptionProgress> = {}): BatchTranscriptionProgress => ({
        jobId: 'job-1',
        docId: 'doc-1',
        promptId: '__builtin_transcript__',
        stage: 'transcribing',
        confirmation: 'polling',
        ...overrides,
    });

    it('🔴 提出後はバッチ段階を出し、「生成 0/1」「区間」「チャンク」を処理率として出さない', () => {
        const markup = render([createStatus({ phase: 'text_generation', batch: createBatch() })], ['f1']);

        expect(markup).toContain('全文文字起こし: 文字起こし中');
        expect(markup).not.toContain('文書を生成しています: 0/1');
        expect(markup).not.toContain('0/1');
        expect(markup).not.toContain('区間');
        expect(markup).not.toContain('チャンク');
        expect(markup).not.toContain('role="progressbar"');
        expect(markup).not.toContain('aria-valuenow');
    });

    it('段階だけを role=status/aria-live=polite の領域に置き、鮮度（時刻）は別要素に出す', () => {
        const markup = render([createStatus({
            phase: 'text_generation',
            batch: createBatch({ stage: 'queued', lastCheckedAtMs: Date.UTC(2026, 8, 5, 3, 4, 5) }),
        })]);

        expect(markup).toMatch(/<span role="status" aria-live="polite">全文文字起こし: 開始待ち<\/span>/);
        expect(markup).toContain('最終確認');
        // 鮮度の要素は live 領域の外
        expect(markup).not.toMatch(/aria-live="polite">[^<]*最終確認/);
    });

    it.each([
        ['checking', '受付済み・状態を確認しています'],
        ['queued', '開始待ち'],
        ['transcribing', '文字起こし中'],
        ['importing', '結果を文書に取り込んでいます'],
    ] as const)('段階 %s は「%s」と表示する', (stage, label) => {
        const markup = render([createStatus({ phase: 'text_generation', batch: createBatch({ stage }) })]);
        expect(markup).toContain(`全文文字起こし: ${label}`);
    });

    it('段階が届かない旧サーバ応答では「処理中・詳細を確認」', () => {
        const markup = render([createStatus({ phase: 'text_generation', batch: createBatch({ stage: undefined }) })]);
        expect(markup).toContain('全文文字起こし: 処理中・詳細を確認');
    });

    it('スピナーは装飾で、動きを減らす設定では静止する（motion-safe）', () => {
        const markup = render([createStatus({ phase: 'text_generation', batch: createBatch() })]);
        expect(markup).toContain('motion-safe:animate-spin');
        expect(markup).not.toMatch(/class="[^"]*(?<![-:])animate-spin/);
        expect(markup).toContain('aria-hidden="true"');
    });

    it('提出後の中止ボタンは「この画面での確認を停止」で、ローカル処理の中止とは分ける', () => {
        const markup = render([createStatus({ phase: 'text_generation', batch: createBatch() })], ['f1']);
        expect(markup).toContain(STOP_CONFIRMATION_LABEL);
        expect(markup).not.toContain(CANCEL_LOCAL_LABEL);
        expect(markup).toContain('この画面を離れても文字起こしは継続します');
    });

    it('🔴 確認待ち（pending_confirmation）は失敗として描かず、同じジョブの確認再開の導線を出す', () => {
        const markup = render([createStatus({
            status: 'pending_confirmation',
            phase: 'awaiting_confirmation',
            batch: createBatch({ confirmation: 'pending', stage: 'transcribing' }),
        })], ['f1']);

        expect(markup).toContain('確認待ち');
        expect(markup).toContain('文字起こしはサーバーで継続します');
        expect(markup).toContain('最終確認時は「文字起こし中」でした');
        expect(markup).toContain(RESUME_CONFIRMATION_LABEL);
        expect(markup).toContain('再提出はしません');
        expect(markup).not.toContain('エラーが発生しました');
        expect(markup).not.toContain('role="alert"');
        expect(markup).not.toContain('animate-spin');
        // ジョブは手放しているので中止ボタンは出さない
        expect(markup).not.toContain(STOP_CONFIRMATION_LABEL);
        expect(markup).not.toContain(CANCEL_LOCAL_LABEL);
    });

    it('確認待ちの「確認を再開する」は onResumeFile を呼ぶ（新規 submit の導線を別に作らない）', () => {
        const onResumeFile = vi.fn();
        const status = createStatus({
            status: 'pending_confirmation',
            phase: 'awaiting_confirmation',
            batch: createBatch({ confirmation: 'pending' }),
        });
        // 静的描画では onClick を辿れないので、描画木から該当ボタンを探して押す
        const tree = ProcessingStatusList({ statuses: [status], onResumeFile }) as React.ReactElement;
        const findButton = (node: React.ReactNode, label: string): React.ReactElement<{ onClick: () => void }> | null => {
            if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(node)) return null;
            const text = React.Children.toArray(node.props.children)
                .map(child => (typeof child === 'string' ? child : ''))
                .join('');
            if (node.type === 'button' && text.includes(label)) return node as React.ReactElement<{ onClick: () => void }>;
            for (const child of React.Children.toArray(node.props.children)) {
                const found = findButton(child, label);
                if (found) return found;
            }
            return null;
        };
        const button = findButton(tree, RESUME_CONFIRMATION_LABEL);
        expect(button).not.toBeNull();
        button!.props.onClick();
        expect(onResumeFile).toHaveBeenCalledExactlyOnceWith('f1');
    });

    it('提出後の中止は「この画面での確認を停止」として描き、サーバ継続と再開の意味を添える', () => {
        const markup = render([createStatus({
            status: 'canceled',
            phase: 'canceled',
            error: 'ユーザー操作により中止されました。',
            batch: createBatch({ confirmation: 'stopped' }),
        })]);

        expect(markup).toContain('この画面での確認を停止しました');
        expect(markup).toContain('文字起こしはサーバーで継続します');
        expect(markup).toContain('再開する');
        expect(markup).not.toContain('処理を中止しました');
    });

    it('複数プロンプトのファイルでは、他の文書の進捗を段階とは別行で出す', () => {
        const markup = render([createStatus({
            phase: 'text_generation',
            totalTranscriptions: 2,
            batch: createBatch(),
        })]);
        expect(markup).toContain('全文文字起こし: 文字起こし中');
        expect(markup).toContain('他の文書: 文書を生成しています');
    });

    it('提出前（batch なし）の表示は従来どおり', () => {
        const markup = render([createStatus({ phase: 'uploading' })], ['f1']);
        expect(markup).toContain('音声データをアップロードしています');
        expect(markup).toContain(CANCEL_LOCAL_LABEL);
        expect(markup).not.toContain('全文文字起こし:');
    });
});

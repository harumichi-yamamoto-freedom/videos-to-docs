import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FileProcessingStatus } from '@/types/processing';
import { ProcessingStatusList } from './ProcessingStatusList';

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

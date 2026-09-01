import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FileDropZone } from './FileDropZone';

const asFile = (name: string, type = 'video/mp4') =>
    ({ name, type, size: 1024 }) as File;

const render = (options: {
    isProcessing?: boolean;
    activeFileIds?: string[];
    withCancel?: boolean;
} = {}) => renderToStaticMarkup(
    <FileDropZone
        onFilesSelected={vi.fn()}
        selectedFiles={[asFile('clip.mp4'), asFile('talk.mp3', 'audio/mpeg')]}
        fileIds={['media-1', 'media-2']}
        onRemoveFile={vi.fn()}
        onRemoveFileById={vi.fn()}
        isProcessing={options.isProcessing ?? false}
        activeFileIds={options.activeFileIds ?? []}
        onCancelFile={options.withCancel === false ? undefined : vi.fn()}
    />
);

describe('FileDropZone cancel affordance (G4/H3)', () => {
    it('offers cancel only for the file that actually holds a job', () => {
        const markup = render({ isProcessing: true, activeFileIds: ['media-1'] });

        expect(markup).toContain('clip.mp4の処理を中止');
        expect(markup).not.toContain('talk.mp3の処理を中止');
    });

    it('offers no cancel while nothing is running', () => {
        const markup = render({ isProcessing: false, activeFileIds: [] });

        expect(markup).not.toContain('の処理を中止');
    });

    it('offers no cancel during processing when no file is named active', () => {
        // 実行中というだけで全ファイルに中止ボタンを出すと、押しても何も起きない
        const markup = render({ isProcessing: true, activeFileIds: [] });

        expect(markup).not.toContain('の処理を中止');
    });

    it('falls back to delete when no cancel handler is wired', () => {
        const markup = render({ isProcessing: true, activeFileIds: ['media-1'], withCancel: false });

        expect(markup).not.toContain('の処理を中止');
    });
});

describe('FileDropZone removal affordance (H3/H13)', () => {
    it('blocks deletion while processing and says why', () => {
        const markup = render({ isProcessing: true, activeFileIds: [] });

        expect(markup).toContain('は処理中のため削除できません');
        expect(markup).toContain('disabled');
    });

    it('allows deletion when idle', () => {
        const markup = render();

        expect(markup).toContain('clip.mp4を削除');
        expect(markup).not.toContain('は処理中のため削除できません');
    });
});

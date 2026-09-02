// @vitest-environment jsdom

/**
 * 音声ファイルパネルの失敗の伝え方の錠。
 * 読み込み失敗もダウンロード失敗も alert() ではなく画面内の role=alert
 * バナーで伝え、同じ指定でやり直せる導線を持つこと。
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAllAudioTranscriptions: vi.fn(),
    getDefaultTemplateNames: vi.fn(async () => [] as string[]),
    getAudioBlob: vi.fn(),
    loggerError: vi.fn(),
}));

vi.mock('@/lib/adminAudioFiles', () => ({
    getAllAudioTranscriptions: mocks.getAllAudioTranscriptions,
    getDefaultTemplateNames: mocks.getDefaultTemplateNames,
    // グルーピングとフィルタは実装の別テスト対象。ここでは素通しにする。
    groupByAudioPath: (docs: unknown[]) => docs,
    filterExistingInStorage: async (groups: unknown[]) => groups,
    filterGroups: async (groups: unknown[]) => groups,
}));

vi.mock('@/lib/storage', () => ({
    getAudioBlob: mocks.getAudioBlob,
}));

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.loggerError }),
}));

vi.mock('jszip', () => ({
    default: class FakeJSZip {
        file(): void {}
        folder(): { file: () => void } {
            return { file: () => undefined };
        }
        async generateAsync(): Promise<Blob> {
            return new Blob();
        }
    },
}));

import AudioFilesPanel from './AudioFilesPanel';

const GROUP = {
    audioStoragePath: 'audio/user-1/a.mp3',
    fileName: 'a.mp3',
    ownerId: 'user-000000001',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    documents: [{
        id: 'doc-1',
        title: '議事録',
        promptName: '標準',
        transcription: '本文',
        createdAt: new Date('2026-09-01T01:00:00Z'),
    }],
};

describe('AudioFilesPanel', () => {
    let container: HTMLDivElement;
    let root: Root;
    let confirmSpy: MockInstance<(message?: string) => boolean>;
    let alertSpy: MockInstance<(message?: string) => void>;

    beforeAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = false;
    });

    beforeEach(() => {
        mocks.getAllAudioTranscriptions.mockReset();
        mocks.getDefaultTemplateNames.mockReset();
        mocks.getDefaultTemplateNames.mockResolvedValue([]);
        mocks.getAudioBlob.mockReset();
        mocks.loggerError.mockClear();
        confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        // 失敗の伝達は画面内で完結する。ネイティブの confirm()/alert() へ
        // 退行したらどのテストでもここで落ちる。
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
        alertSpy.mockRestore();
    });

    async function renderPanel(): Promise<void> {
        await act(async () => {
            root.render(<AudioFilesPanel />);
        });
    }

    function findButton(name: string): HTMLButtonElement {
        const button = Array.from(container.querySelectorAll('button')).find(
            candidate => candidate.textContent?.trim() === name,
        );
        if (!button) throw new Error(`button not found: ${name}`);
        return button;
    }

    async function startZipDownload(): Promise<void> {
        await act(async () => {
            findButton('全選択').click();
        });
        await act(async () => {
            findButton('ダウンロード').click();
        });

        // モーダル内の実行ボタン（ツールバー側と同名なのでモーダルへスコープ）。
        const modal = container.querySelector('.fixed.inset-0');
        if (!modal) throw new Error('download modal not found');
        const startButton = Array.from(modal.querySelectorAll('button')).find(
            candidate => candidate.textContent?.trim() === 'ダウンロード',
        );
        if (!startButton) throw new Error('download start button not found');
        await act(async () => {
            startButton.click();
        });
    }

    it('読み込み失敗は画面内のrole=alertで伝え、再試行で復旧できる', async () => {
        mocks.getAllAudioTranscriptions
            .mockRejectedValueOnce(new Error('unavailable'))
            .mockResolvedValueOnce([GROUP]);

        await renderPanel();

        const banner = container.querySelector('[role="alert"]');
        expect(banner?.textContent).toContain('データを読み込めませんでした。');
        expect(mocks.loggerError).toHaveBeenCalledTimes(1);

        const retryButton = Array.from(banner!.querySelectorAll('button')).find(
            button => button.textContent?.trim() === '再試行',
        );
        await act(async () => {
            retryButton!.click();
        });

        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.textContent).toContain('a.mp3');
    });

    it('ダウンロード失敗は画面内のrole=alertで伝え、同じ指定でやり直せる', async () => {
        mocks.getAllAudioTranscriptions.mockResolvedValue([GROUP]);
        mocks.getAudioBlob.mockRejectedValue(new Error('storage unavailable'));

        await renderPanel();
        await startZipDownload();

        const banner = container.querySelector('[role="alert"]');
        expect(banner?.textContent).toContain('ダウンロードできませんでした。');
        expect(mocks.getAudioBlob).toHaveBeenCalledTimes(1);

        // 「もう一度試す」は保存済みの内容・形式で再実行する。
        const retryButton = Array.from(banner!.querySelectorAll('button')).find(
            button => button.textContent?.trim() === 'もう一度試す',
        );
        await act(async () => {
            retryButton!.click();
        });

        expect(mocks.getAudioBlob).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[role="alert"]')?.textContent)
            .toContain('ダウンロードできませんでした。');

        // 「閉じる」でバナーを畳める（行き止まりにしない）。
        const dismissButton = Array.from(
            container.querySelector('[role="alert"]')!.querySelectorAll('button'),
        ).find(button => button.textContent?.trim() === '閉じる');
        await act(async () => {
            dismissButton!.click();
        });
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });
});

import { describe, expect, it, vi } from 'vitest';
import {
    measureMediaDurationSec,
    type MediaDurationEnv,
} from './mediaDuration';

/** DOM を持たない実行環境で `HTMLMediaElement` の要る部分だけ真似る */
class FakeMediaElement {
    duration = 0;
    preload = '';
    private listeners = new Map<string, Set<() => void>>();
    private currentSrc = '';
    loadCalls = 0;

    constructor(private readonly behavior: (element: FakeMediaElement) => void) { }

    addEventListener(type: string, handler: () => void) {
        const set = this.listeners.get(type) ?? new Set();
        set.add(handler);
        this.listeners.set(type, set);
    }

    removeEventListener(type: string, handler: () => void) {
        this.listeners.get(type)?.delete(handler);
    }

    removeAttribute(name: string) {
        if (name === 'src') this.currentSrc = '';
    }

    load() {
        this.loadCalls += 1;
    }

    set src(value: string) {
        this.currentSrc = value;
        if (value) this.behavior(this);
    }

    get src() {
        return this.currentSrc;
    }

    emit(type: string) {
        [...(this.listeners.get(type) ?? [])].forEach(handler => handler());
    }

    /** 解放後にリスナーが残っていないこと（漏れの検出） */
    get listenerCount(): number {
        return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
    }
}

const createEnv = (behavior: (element: FakeMediaElement) => void) => {
    const revoked: string[] = [];
    const created: string[] = [];
    let element: FakeMediaElement | undefined;
    const env: MediaDurationEnv = {
        createObjectURL: () => {
            const url = `blob:synthetic-${created.length}`;
            created.push(url);
            return url;
        },
        revokeObjectURL: url => { revoked.push(url); },
        createElement: kind => {
            element = new FakeMediaElement(behavior);
            (element as unknown as { kind: string }).kind = kind;
            return element as unknown as HTMLMediaElement;
        },
    };
    return { env, revoked, created, get element() { return element; } };
};

const blob = (size = 1024, type = 'audio/mpeg') => ({ size, type }) as Blob;

describe('measureMediaDurationSec', () => {
    it('メタデータが読めたら実際の長さを返す', async () => {
        const harness = createEnv(element => {
            element.duration = 9000;
            element.emit('loadedmetadata');
        });

        await expect(measureMediaDurationSec(blob(), { env: harness.env })).resolves.toBe(9000);
    });

    it('🔴 成功しても失敗しても objectURL を解放する（数百MBを居座らせない）', async () => {
        const ok = createEnv(element => { element.duration = 120; element.emit('loadedmetadata'); });
        await measureMediaDurationSec(blob(), { env: ok.env });
        expect(ok.revoked).toEqual(ok.created);
        expect(ok.element?.listenerCount).toBe(0);

        const failed = createEnv(element => element.emit('error'));
        await measureMediaDurationSec(blob(), { env: failed.env });
        expect(failed.revoked).toEqual(failed.created);
        expect(failed.element?.listenerCount).toBe(0);
    });

    it('読み込みに失敗したら null（例外にしない）', async () => {
        const harness = createEnv(element => element.emit('error'));
        await expect(measureMediaDurationSec(blob(), { env: harness.env })).resolves.toBeNull();
    });

    it.each([
        ['Infinity（VBR mp3 で実際に起きる）', Number.POSITIVE_INFINITY],
        ['NaN', Number.NaN],
        ['0', 0],
        ['負', -1],
    ])('duration が %s なら測れなかったものとして null', async (_label, duration) => {
        const harness = createEnv(element => {
            element.duration = duration;
            element.emit('loadedmetadata');
        });

        await expect(measureMediaDurationSec(blob(), { env: harness.env })).resolves.toBeNull();
    });

    it('🔴 メタデータが来ないまま固まったらタイムアウトで null を返し、解放もする', async () => {
        vi.useFakeTimers();
        try {
            // loadedmetadata も error も発火しない（壊れたファイル）
            const harness = createEnv(() => { });
            const pending = measureMediaDurationSec(blob(), { env: harness.env, timeoutMs: 5_000 });

            await vi.advanceTimersByTimeAsync(5_001);

            await expect(pending).resolves.toBeNull();
            expect(harness.revoked).toEqual(harness.created);
        } finally {
            vi.useRealTimers();
        }
    });

    it('DOM が無い実行環境では測らずに null（新しい失敗経路を作らない）', async () => {
        await expect(measureMediaDurationSec(blob(), { env: null })).resolves.toBeNull();
    });

    it('中身の無い Blob は測らない', async () => {
        const harness = createEnv(element => { element.duration = 1; element.emit('loadedmetadata'); });
        await expect(measureMediaDurationSec(blob(0), { env: harness.env })).resolves.toBeNull();
        expect(harness.created).toEqual([]);
    });

    it('動画は video 要素で、音声は audio 要素で測る', async () => {
        const video = createEnv(element => { element.duration = 10; element.emit('loadedmetadata'); });
        await measureMediaDurationSec(blob(1024, 'video/mp4'), { env: video.env });
        expect((video.element as unknown as { kind: string }).kind).toBe('video');

        const audio = createEnv(element => { element.duration = 10; element.emit('loadedmetadata'); });
        await measureMediaDurationSec(blob(1024, 'audio/mpeg'), { env: audio.env });
        expect((audio.element as unknown as { kind: string }).kind).toBe('audio');
    });
});

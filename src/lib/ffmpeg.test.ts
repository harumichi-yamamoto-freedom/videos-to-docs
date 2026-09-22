/**
 * VideoConverter の錠（2026-09-22 の複数ファイル不具合の再発防止）。
 *
 *  - exec の回数を数え、予算に達したら prepareForInput() が worker を作り直す
 *  - wasm が死んだ exec は FfmpegWorkerDeadError になり、作り直すまでそのインスタンスを使わない
 *  - 入力は writeFile ではなく WORKERFS のマウントで渡す（2GB 超・メモリ峰の対策）
 *  - core の Blob URL は作り直しをまたいで 1 度しか取らない
 *
 * 🔴 崖そのもの（約 65 回目の exec で死ぬ）は wasm 実機でしか再現できない。
 *    それは e2e/ffmpeg-wasm/ で回す。ここはその前提の上に立つ制御の錠。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { message?: string; progress?: number }) => void;

const harness = vi.hoisted(() => ({
    instances: [] as Array<{
        load: ReturnType<typeof vi.fn>;
        exec: ReturnType<typeof vi.fn>;
        terminate: ReturnType<typeof vi.fn>;
        createDir: ReturnType<typeof vi.fn>;
        deleteDir: ReturnType<typeof vi.fn>;
        mount: ReturnType<typeof vi.fn>;
        unmount: ReturnType<typeof vi.fn>;
        readFile: ReturnType<typeof vi.fn>;
        deleteFile: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
        handlers: Map<string, Set<Handler>>;
    }>,
    /** 次の exec の振る舞い。省略時は rc=0 */
    execBehavior: null as null | ((args: string[], emit: (event: string, payload: object) => void) => Promise<number>),
    toBlobURL: vi.fn(),
    fetch: vi.fn(),
}));

vi.mock('@ffmpeg/ffmpeg', () => ({
    FFFSType: { WORKERFS: 'WORKERFS' },
    FFmpeg: class FFmpeg {
        handlers = new Map<string, Set<Handler>>();
        load = vi.fn().mockResolvedValue(true);
        terminate = vi.fn();
        createDir = vi.fn().mockResolvedValue(true);
        deleteDir = vi.fn().mockResolvedValue(true);
        mount = vi.fn().mockResolvedValue(true);
        unmount = vi.fn().mockResolvedValue(true);
        readFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
        deleteFile = vi.fn().mockResolvedValue(true);
        writeFile = vi.fn().mockResolvedValue(true);
        on = (event: string, handler: Handler) => {
            if (!this.handlers.has(event)) this.handlers.set(event, new Set());
            this.handlers.get(event)!.add(handler);
        };
        off = (event: string, handler: Handler) => {
            this.handlers.get(event)?.delete(handler);
        };
        exec = vi.fn(async (args: string[]) => {
            const emit = (event: string, payload: object) => {
                this.handlers.get(event)?.forEach(handler => handler(payload));
            };
            if (harness.execBehavior) return harness.execBehavior(args, emit);
            return 0;
        });
        constructor() {
            harness.instances.push(this);
        }
    },
}));

vi.mock('@ffmpeg/util', () => ({
    fetchFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    toBlobURL: harness.toBlobURL,
}));

vi.mock('./logger', () => ({
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import {
    FFMPEG_EXEC_BUDGET,
    isFfmpegWorkerDeadError,
    isWasmFatalError,
    resetCoreAssetsForTests,
    VideoConverter,
} from './ffmpeg';

const latest = () => harness.instances[harness.instances.length - 1];

const probeLogs = [
    '  Duration: 03:35:42.20, start: 0.000000, bitrate: 807 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637601), yuv420p, 1280x720',
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 32000 Hz, mono, fltp, 128 kb/s',
];

beforeEach(() => {
    harness.instances.length = 0;
    harness.execBehavior = null;
    harness.toBlobURL.mockReset().mockImplementation(async (url: string) => `blob:${url}`);
    harness.fetch.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', harness.fetch);
    resetCoreAssetsForTests();
});

describe('core の取得', () => {
    it('同一オリジンに core があればそこから取り、作り直しても再取得しない', async () => {
        const converter = new VideoConverter();
        await converter.load();
        expect(harness.toBlobURL).toHaveBeenCalledTimes(2);
        expect(harness.toBlobURL.mock.calls.map(call => call[0])).toEqual([
            '/ffmpeg/ffmpeg-core.js',
            '/ffmpeg/ffmpeg-core.wasm',
        ]);

        await converter.recycle();
        expect(harness.toBlobURL).toHaveBeenCalledTimes(2);
        expect(harness.instances).toHaveLength(2);
        expect(harness.instances[0].terminate).toHaveBeenCalledOnce();
        expect(harness.instances[1].load).toHaveBeenCalledWith({
            coreURL: 'blob:/ffmpeg/ffmpeg-core.js',
            wasmURL: 'blob:/ffmpeg/ffmpeg-core.wasm',
        });
    });

    it('同一オリジンに core が無ければ unpkg に落ちる', async () => {
        harness.fetch.mockResolvedValue({ ok: false });
        await new VideoConverter().load();
        expect(harness.toBlobURL.mock.calls[0][0]).toMatch(/^https:\/\/unpkg\.com\/@ffmpeg\/core@0\.12\.6\/dist\/umd\/ffmpeg-core\.js$/);
    });

    it('HEAD が例外でも unpkg に落ちる（fetch が使えない環境）', async () => {
        harness.fetch.mockRejectedValue(new TypeError('Invalid URL'));
        await new VideoConverter().load();
        expect(harness.toBlobURL.mock.calls[0][0]).toContain('unpkg.com');
    });
});

describe('exec の予算', () => {
    it('予算内なら worker を使い回し、越える直前に作り直す', async () => {
        const converter = new VideoConverter();
        await converter.load();

        for (let i = 0; i < FFMPEG_EXEC_BUDGET - 2; i += 1) {
            await converter.convertInputToMp3('/input/x.mp4');
        }
        expect(converter.getExecCount()).toBe(FFMPEG_EXEC_BUDGET - 2);

        // 残り 2 回分は予算内: 作り直さない
        await converter.prepareForInput(2);
        expect(converter.getGeneration()).toBe(0);
        expect(harness.instances).toHaveLength(1);

        await converter.convertInputToMp3('/input/x.mp4');
        // 残り 1 回では 2 回分を確保できない: 作り直す
        await converter.prepareForInput(2);
        expect(converter.getGeneration()).toBe(1);
        expect(converter.getExecCount()).toBe(0);
        expect(harness.instances).toHaveLength(2);
        expect(harness.instances[0].terminate).toHaveBeenCalledOnce();
    });

    it('未ロードなら prepareForInput が load する', async () => {
        const converter = new VideoConverter();
        await converter.prepareForInput();
        expect(latest().load).toHaveBeenCalledOnce();
        expect(converter.getGeneration()).toBe(0);
    });
});

describe('wasm が死んだとき', () => {
    it.each([
        'RuntimeError: memory access out of bounds',
        'RuntimeError: table index is out of bounds',
        'RuntimeError: null function or function signature mismatch',
    ])('%s は致命として扱う', (message) => {
        expect(isWasmFatalError(message)).toBe(true);
        expect(isWasmFatalError(new Error(message))).toBe(true);
    });

    it('通常の失敗（rc≠0・ファイル無し）は致命ではない', () => {
        expect(isWasmFatalError(new Error('FS error'))).toBe(false);
        expect(isWasmFatalError('ErrnoError: FS error')).toBe(false);
    });

    it('exec が死ぬと FfmpegWorkerDeadError になり、作り直すまで次の exec を拒む', async () => {
        const converter = new VideoConverter();
        await converter.load();
        harness.execBehavior = async () => { throw 'RuntimeError: memory access out of bounds'; };

        await expect(converter.convertInputToMp3('/input/x.mp4')).rejects.toSatisfy(isFfmpegWorkerDeadError);
        expect(converter.isDead()).toBe(true);
        // 死んだ worker にはクリーンアップも送らない
        expect(latest().deleteFile).not.toHaveBeenCalled();

        harness.execBehavior = null;
        await expect(converter.convertInputToMp3('/input/x.mp4')).rejects.toSatisfy(isFfmpegWorkerDeadError);
        expect(latest().exec).toHaveBeenCalledTimes(1);

        await converter.prepareForInput();
        expect(converter.isDead()).toBe(false);
        expect(converter.getGeneration()).toBe(1);
        await expect(converter.convertInputToMp3('/input/x.mp4')).resolves.toBeInstanceOf(Blob);
    });
});

describe('入力のマウントと probe', () => {
    it('WORKERFS に input.<ext> の名前でマウントし、unmount でディレクトリごと片付ける', async () => {
        const converter = new VideoConverter();
        const file = { name: '永島 正明-20240324_FB①:015.MP4', size: 10 } as File;
        const mounted = await converter.mountInput(file);

        expect(latest().createDir).toHaveBeenCalledWith('/input_0_1');
        expect(latest().mount).toHaveBeenCalledWith(
            'WORKERFS',
            { blobs: [{ name: 'input.MP4', data: file }] },
            '/input_0_1',
        );
        expect(mounted.path).toBe('/input_0_1/input.MP4');
        // 元ファイルを wasm に複製しない
        expect(latest().writeFile).not.toHaveBeenCalled();

        await mounted.unmount();
        expect(latest().unmount).toHaveBeenCalledWith('/input_0_1');
        expect(latest().deleteDir).toHaveBeenCalledWith('/input_0_1');
    });

    it('probeInput はログから長さと音声トラックを読む（exec 1 回）', async () => {
        const converter = new VideoConverter();
        await converter.load();
        harness.execBehavior = async (_args, emit) => {
            probeLogs.forEach(message => emit('log', { message }));
            return 1; // 出力無しなので rc≠0 が正常
        };
        await expect(converter.probeInput('/input_0_1/input.mp4')).resolves.toEqual({
            durationSec: 3 * 3600 + 35 * 60 + 42,
            hasAudioStream: true,
        });
        expect(converter.getExecCount()).toBe(1);
        expect(latest().exec).toHaveBeenCalledWith(['-i', '/input_0_1/input.mp4']);
    });

    it('音声トラックが無い動画は利用者向けの文言で失敗する', async () => {
        const converter = new VideoConverter();
        await converter.load();
        harness.execBehavior = async (_args, emit) => {
            emit('log', { message: probeLogs[0] });
            emit('log', { message: probeLogs[1] });
            return 1;
        };
        await expect(converter.probeInput('/input_0_1/input.mp4')).rejects.toThrow('音声トラックが含まれていません');
    });

    it('長さが読めなければ失敗する', async () => {
        const converter = new VideoConverter();
        await converter.load();
        harness.execBehavior = async () => 1;
        await expect(converter.probeInput('/input_0_1/input.mp4')).rejects.toThrow('動画の長さを取得できませんでした');
    });
});

describe('1 exec の変換', () => {
    it('区間を切らず、mono・指定ビットレート・字幕抜きで 1 回だけ exec する', async () => {
        const converter = new VideoConverter();
        await converter.load();
        const progress: number[] = [];
        harness.execBehavior = async (_args, emit) => {
            emit('progress', { progress: 0.5 });
            emit('progress', { progress: 1 });
            return 0;
        };

        const blob = await converter.convertInputToMp3('/input_0_1/input.mp4', {
            bitrate: '96k', sampleRate: 16000, onProgress: p => progress.push(p.ratio),
        });

        expect(blob.type).toBe('audio/mpeg');
        expect(progress).toEqual([0.5, 1]);
        expect(latest().exec).toHaveBeenCalledOnce();
        expect(latest().exec).toHaveBeenCalledWith([
            '-i', '/input_0_1/input.mp4',
            '-vn', '-sn',
            '-acodec', 'libmp3lame',
            '-ac', '1',
            '-ab', '96k',
            '-ar', '16000',
            '-y', expect.stringMatching(/^output_0_\d+\.mp3$/),
        ]);
        // 出力は読んだら消す
        expect(latest().deleteFile).toHaveBeenCalledWith(expect.stringMatching(/^output_0_\d+\.mp3$/));
    });

    it('rc≠0 は失敗（ログの末尾を文言に含める）', async () => {
        const converter = new VideoConverter();
        await converter.load();
        harness.execBehavior = async (_args, emit) => {
            emit('log', { message: 'Error opening output file' });
            return 1;
        };
        await expect(converter.convertInputToMp3('/input_0_1/input.mp4')).rejects.toThrow('FFmpeg実行失敗 (rc=1): Error opening output file');
        expect(converter.isDead()).toBe(false);
    });

    it('出力にストリームが無い失敗は音声トラック無しの文言にする', async () => {
        const converter = new VideoConverter();
        await converter.load();
        harness.execBehavior = async (_args, emit) => {
            emit('log', { message: 'Output file #0 does not contain any stream' });
            return 1;
        };
        await expect(converter.convertInputToMp3('/input_0_1/input.mp4')).rejects.toThrow('音声トラックが含まれていません');
    });
});

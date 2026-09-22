// ブラウザ内 FFmpeg.wasm の実機検査ハーネス。本番と同じ src/lib/ffmpeg.ts と
// src/lib/videoConversionService.ts を束ね、Playwright (run.js) から window.run* を呼ぶ。
// 使い方と合格線は README.md。
import { toBlobURL } from '@ffmpeg/util';
import { VideoConverter } from '@/lib/ffmpeg';
import { convertVideoToAudioSegments } from '@/lib/videoConversionService';
import type { FileWithPrompts, FileProcessingStatus, DebugErrorMode } from '@/types/processing';

const debugErrorMode: DebugErrorMode = { ffmpegError: false, geminiError: false, errorAtFileIndex: -1, errorAtSegmentIndex: -1 };

interface RunOptions {
  bitrate: string;
  sampleRate: number;
  /** ファイルごとに worker を作り直す対照腕 (本番経路は prepareForInput が予算で判断する) */
  terminateBetween: boolean;
  /** mount モードの区間長 (秒)。0 なら旧実装と同じ計画 (30 秒・最大 60 区間) */
  segLenOverride?: number;
  /** copy モード: 再エンコードせず音声トラックを m4a に抜く */
  copy?: boolean;
}

interface FileResult {
  name: string;
  sizeBytes: number;
  ok: boolean;
  outBytes: number | null;
  error: string | null;
  elapsedMs: number;
  durationSec?: number;
  lastStatus: unknown;
}

declare global {
  interface Window {
    reproLog: string[];
    /** 本番経路 (convertVideoToAudioSegments) で複数ファイルを直列変換 */
    runRepro: (opts: RunOptions) => Promise<FileResult[]>;
    /** 旧経路 (convertSegmentToMp3 を区間の数だけ exec) を mount 入力で回す = 崖の再現用 */
    runMountRepro: (opts: RunOptions) => Promise<FileResult[]>;
    /** 1 exec 変換 / remux の単体計測 */
    runSingleExec: (opts: RunOptions) => Promise<FileResult[]>;
  }
}

window.reproLog = [];
const log = (...a: unknown[]) => {
  const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  window.reproLog.push(s);
  console.log('[repro]', s);
};

// ハーネス都合: Next のバンドル外では worker が module 型になり UMD core を import できないので、
// 同版の ESM ビルドへ coreURL だけ差し替える (wasm は同一)。?core=<version> で版を変えられる。
const patchedInstances = new WeakSet<object>();
const patchLoad = (c: VideoConverter) => {
  const ff = c.getFfmpeg() as unknown as { load: (cfg: Record<string, string>) => Promise<boolean> };
  if (patchedInstances.has(ff)) return;
  patchedInstances.add(ff);
  const orig = ff.load.bind(ff);
  const coreVer = new URLSearchParams(location.search).get('core') || '0.12.6';
  ff.load = async (cfg) => orig({
    ...cfg,
    coreURL: await toBlobURL(`https://unpkg.com/@ffmpeg/core@${coreVer}/dist/esm/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`https://unpkg.com/@ffmpeg/core@${coreVer}/dist/esm/ffmpeg-core.wasm`, 'application/wasm'),
  });
};

// recycle() が new FFmpeg() → load() を行うので、load の入口で毎回 patch を当てる
const originalLoad = VideoConverter.prototype.load;
VideoConverter.prototype.load = async function patchedLoad(this: VideoConverter) {
  patchLoad(this);
  return originalLoad.call(this);
};

const patchedConverter = (): VideoConverter => new VideoConverter();

const selectedFiles = (): File[] => Array.from((document.getElementById('files') as HTMLInputElement).files ?? []);

const makeStatuses = (files: File[]): FileProcessingStatus[] => files.map((file, i) => ({
  fileId: `media-${i + 1}`, fileName: file.name, status: 'converting', phase: 'waiting',
  audioConversionProgress: 0, transcriptionCount: 0, totalTranscriptions: 1,
  completedPromptIds: [], promptStates: {}, segmentDuration: 0, segments: [], completedSegmentIndices: [],
}));

const summarize = (st: FileProcessingStatus) => ({
  status: st.status, phase: st.phase, failedPhase: st.failedPhase,
  done: st.completedSegmentIndices?.length, segs: st.segments?.length, totalDuration: st.totalDuration,
});

window.runRepro = async ({ bitrate, sampleRate, terminateBetween }) => {
  const files = selectedFiles();
  const converter = patchedConverter();
  await converter.load();
  log('ffmpeg loaded', { files: files.map(f => ({ name: f.name, size: f.size })), bitrate, sampleRate, terminateBetween });

  let statuses = makeStatuses(files);
  const setStatuses = (upd: FileProcessingStatus[] | ((p: FileProcessingStatus[]) => FileProcessingStatus[])) => {
    statuses = typeof upd === 'function' ? upd(statuses) : upd;
  };

  const results: FileResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const fwp: FileWithPrompts = { file: files[i], selectedPromptIds: ['p'] };
    const t0 = performance.now();
    let blob: Blob | null = null; let error: string | null = null;
    try {
      blob = await convertVideoToAudioSegments(fwp, i, converter, bitrate, sampleRate, debugErrorMode, setStatuses as never);
    } catch (e) { error = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
    const st = statuses[i];
    const r: FileResult = {
      name: files[i].name, sizeBytes: files[i].size, ok: !!blob, outBytes: blob ? blob.size : null,
      error: error ?? (blob ? null : (st.error ?? 'null returned without error text')),
      elapsedMs: Math.round(performance.now() - t0), durationSec: st.totalDuration, lastStatus: summarize(st),
    };
    results.push(r); log('file result', r, { execCount: converter.getExecCount(), generation: converter.getGeneration() });
    if (terminateBetween && i < files.length - 1) { await converter.recycle(); log('ffmpeg re-created'); }
  }
  return results;
};

const probeDuration = async (ff: { on: Function; off: Function; exec: Function }, path: string): Promise<number> => {
  let duration = 0;
  const h = ({ message }: { message: string }) => {
    const m = message.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (m) duration = +m[1] * 3600 + +m[2] * 60 + +m[3];
  };
  ff.on('log', h);
  try { await ff.exec(['-i', path]); } catch { /* 出力無しは正常にエラー */ } finally { ff.off('log', h); }
  return duration;
};

window.runMountRepro = async ({ bitrate, sampleRate, terminateBetween, segLenOverride }) => {
  const files = selectedFiles();
  const converter = patchedConverter();
  await converter.load();
  log('mount-mode ffmpeg loaded', { files: files.map(f => ({ name: f.name, size: f.size })), bitrate, sampleRate, terminateBetween, segLenOverride });
  const results: FileResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]; const t0 = performance.now();
    const ff = converter.getFfmpeg() as unknown as { createDir: Function; mount: Function; unmount: Function; on: Function; off: Function; exec: Function };
    const mountPoint = `/in${i}`; const mounted = `${mountPoint}/${file.name}`;
    let ok = false; let error: string | null = null; let done = 0; let segs = 0; let outBytes = 0; let duration = 0;
    try {
      await ff.createDir(mountPoint);
      await ff.mount('WORKERFS', { files: [file] }, mountPoint);
      duration = await probeDuration(ff, mounted);
      if (!duration) throw new Error('動画の長さを取得できませんでした');
      const segLen = segLenOverride || (Math.ceil(duration / 30) > 60 ? Math.ceil(duration / 60) : 30);
      segs = Math.ceil(duration / segLen);
      for (let s = 0; s < segs; s++) {
        const r = await converter.convertSegmentToMp3(file, s * segLen, Math.min((s + 1) * segLen, duration), s, { bitrate, sampleRate, inputFileName: mounted });
        if (!r.success || !r.outputBlob) throw new Error(`区間${s + 1}: ${r.error ?? '失敗'}`);
        outBytes += r.outputBlob.size; done++;
      }
      ok = true;
    } catch (e) { error = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
    try { await ff.unmount(mountPoint); } catch { /* ignore */ }
    const r: FileResult = { name: file.name, sizeBytes: file.size, durationSec: duration, ok, outBytes, error, elapsedMs: Math.round(performance.now() - t0), lastStatus: { done, segs, execCount: converter.getExecCount() } };
    results.push(r); log('mount file result', r);
    if (terminateBetween && i < files.length - 1) { await converter.recycle(); log('ffmpeg re-created'); }
  }
  return results;
};

window.runSingleExec = async ({ bitrate, sampleRate, copy }) => {
  const files = selectedFiles();
  const converter = patchedConverter();
  await converter.load();
  const ff = converter.getFfmpeg() as unknown as { createDir: Function; mount: Function; unmount: Function; exec: Function; readFile: Function; deleteFile: Function; on: Function; off: Function };
  const results: FileResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]; const t0 = performance.now(); const mp = `/one${i}`; const src = `${mp}/${file.name}`;
    const out = copy ? `out${i}.m4a` : `out${i}.mp3`;
    let ok = false; let error: string | null = null; let outBytes = 0; let lastProgress = 0;
    const ph = ({ progress }: { progress: number }) => { lastProgress = progress; };
    try {
      await ff.createDir(mp); await ff.mount('WORKERFS', { files: [file] }, mp);
      ff.on('progress', ph);
      const args = copy
        ? ['-i', src, '-vn', '-sn', '-c:a', 'copy', '-y', out]
        : ['-i', src, '-vn', '-sn', '-acodec', 'libmp3lame', '-ac', '1', '-ab', bitrate, '-ar', String(sampleRate), '-y', out];
      const rc = await ff.exec(args);
      if (rc !== 0) throw new Error(`ffmpeg rc=${rc}`);
      const data = await ff.readFile(out); outBytes = (data as Uint8Array).byteLength; await ff.deleteFile(out); ok = true;
    } catch (e) { error = e instanceof Error ? `${e.name}: ${e.message}` : String(e); }
    finally { ff.off('progress', ph); try { await ff.unmount(mp); } catch { /* ignore */ } }
    const r: FileResult = { name: file.name, sizeBytes: file.size, ok, outBytes, error, elapsedMs: Math.round(performance.now() - t0), lastStatus: { done: ok ? 1 : 0, segs: 1, lastProgress } };
    results.push(r); log('single-exec result', r);
  }
  return results;
};

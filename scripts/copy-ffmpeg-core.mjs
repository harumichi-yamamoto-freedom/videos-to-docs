#!/usr/bin/env node
/**
 * @ffmpeg/core の wasm と loader を public/ffmpeg/ へ複製する (predev / prebuild で走る)。
 *
 * ブラウザ内の音声変換 (src/lib/ffmpeg.ts) は core を同一オリジンの /ffmpeg/ から読む。
 * 以前は実行のたびに unpkg から取っていたので、unpkg の障害 = 変換不能だった。
 * public/ffmpeg/ は生成物なので git には入れない (.gitignore)。版は src/lib/ffmpeg.ts の
 * FFMPEG_CORE_VERSION と package.json の devDependencies で揃える。
 */
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'umd');
const target = join(root, 'public', 'ffmpeg');
const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

const corePackage = JSON.parse(await readFile(join(root, 'node_modules', '@ffmpeg', 'core', 'package.json'), 'utf8'));
const ffmpegTs = await readFile(join(root, 'src', 'lib', 'ffmpeg.ts'), 'utf8');
const pinned = ffmpegTs.match(/FFMPEG_CORE_VERSION = '([^']+)'/)?.[1];
if (pinned !== corePackage.version) {
    console.error(`[copy-ffmpeg-core] 版が食い違っています: src/lib/ffmpeg.ts=${pinned} node_modules=${corePackage.version}`);
    process.exit(1);
}

await mkdir(target, { recursive: true });
for (const file of files) {
    const from = join(source, file);
    const to = join(target, file);
    await copyFile(from, to);
    const { size } = await stat(to);
    console.log(`[copy-ffmpeg-core] ${file} -> public/ffmpeg/ (${size} bytes, v${corePackage.version})`);
}

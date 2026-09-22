// usage: [MODE=write|mount|single|copy] [SEGLEN=秒] [CORE=0.12.6] node run.js <label> <terminateBetween:0|1> <file1> [file2 ...]
// 前提: リポジトリ直下で `npm run copy-ffmpeg-core` と `npm run e2e:ffmpeg:build` を済ませ、この dir で `npm i` してある
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const MODE = process.env.MODE || 'write';
const [label, term, ...files] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.env.OUT_DIR || path.join(__dirname, 'results');
const PORT = 8765 + Math.floor(Math.random() * 1000);
fs.mkdirSync(OUT, { recursive: true });

function allPw() {
  const rows = execSync('ps -axo pid,ppid,rss,command').toString().trim().split('\n').slice(1)
    .map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], cmd: m[4] }; }).filter(Boolean);
  return rows.filter(r => /ms-playwright/.test(r.cmd));
}
function descendants(rootPid) {
  const rows = execSync('ps -axo pid,ppid,rss,command').toString().trim().split('\n').slice(1)
    .map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], cmd: m[4] }; }).filter(Boolean);
  const set = new Set([rootPid]); let grew = true;
  while (grew) { grew = false; for (const r of rows) if (set.has(r.ppid) && !set.has(r.pid)) { set.add(r.pid); grew = true; } }
  return rows.filter(r => set.has(r.pid));
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', ROOT], { stdio: 'ignore' });
  // 静的サーバが listen するまで待つ (固定 1.5 秒待ちでは ERR_CONNECTION_REFUSED になることがあった)
  const deadline = Date.now() + 15000;
  for (;;) {
    try { await fetch(`http://127.0.0.1:${PORT}/e2e/ffmpeg-wasm/index.html`); break; } catch (e) {
      if (Date.now() > deadline) throw new Error(`static server did not start on ${PORT}: ${e}`);
      await new Promise(r => setTimeout(r, 250));
    }
  }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', m => { const t = m.text(); if (!t.includes('[repro]')) consoleLines.push(t.slice(0, 400)); });
  page.on('pageerror', e => consoleLines.push('PAGEERROR ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/e2e/ffmpeg-wasm/index.html?core=${process.env.CORE || '0.12.6'}`);
  await page.setInputFiles('#files', files);
  const bpid = null;
  const samples = []; const t0 = Date.now();
  const timer = setInterval(() => {
    const d = allPw(); const renderer = d.filter(r => /type=renderer/.test(r.cmd));
    const maxR = Math.max(0, ...renderer.map(r => r.rssKb));
    samples.push({ tSec: Math.round((Date.now() - t0) / 1000), rendererMaxMb: Math.round(maxR / 1024), treeTotalMb: Math.round(d.reduce((a, r) => a + r.rssKb, 0) / 1024) });
  }, 5000);
  let results = null, fatal = null;
  try {
    results = await page.evaluate(opts => (opts.mode === 'mount' ? window.runMountRepro(opts) : opts.mode === 'single' ? window.runSingleExec(opts) : opts.mode === 'copy' ? window.runSingleExec({ ...opts, copy: true }) : window.runRepro(opts)), { mode: MODE, segLenOverride: Number(process.env.SEGLEN || 0), bitrate: '96k', sampleRate: 44100, terminateBetween: term === '1' });
  } catch (e) { fatal = String(e && e.message || e); }
  clearInterval(timer);
  const reproLog = await page.evaluate(() => window.reproLog).catch(() => null);
  const out = { label, mode: MODE, terminateBetween: term === '1', files, results, fatal, elapsedSec: Math.round((Date.now() - t0) / 1000), rssPeakRendererMb: Math.max(0, ...samples.map(s => s.rendererMaxMb)), samples, reproLog, consoleTail: consoleLines.slice(-60) };
  fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ label, results, fatal, elapsedSec: out.elapsedSec, rssPeakRendererMb: out.rssPeakRendererMb }, null, 1));
  await browser.close(); server.kill();
})();

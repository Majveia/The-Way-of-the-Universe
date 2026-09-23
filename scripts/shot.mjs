#!/usr/bin/env node
/**
 * Headless screenshot + health check for any experience.
 *
 *   node scripts/shot.mjs --exp gargantua --out shots/gargantua.png
 *   node scripts/shot.mjs --port 5201 --exp cosmos --frames 120 --w 1600 --h 900 \
 *        --query "quality=high&seed=3" --eval "window.__universe.experience.debugView?.('edge-on')"
 *
 * Starts nothing itself: point it at a running `npx vite --port <port>` dev server
 * (or `--url` for any host). Chromium runs WebGL2 on SwiftShader (CPU), so expect
 * roughly 1–10 fps for heavy shaders; frame counts, not wall time, drive the scene.
 *
 * Prints a JSON report: frames, fps, WebGL renderer, console errors/warnings.
 * Exit code 1 if the page reported errors or never became ready.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const port = opt('port', '5173');
const base = opt('url', `http://127.0.0.1:${port}/`);
const exp = opt('exp', 'prelude');
const out = opt('out', `shots/${exp}.png`);
const width = Number(opt('w', '1280'));
const height = Number(opt('h', '720'));
const frames = Number(opt('frames', '30'));
const timeout = Number(opt('timeout', '180000'));
const query = opt('query', '');
const evalJs = opt('eval', '');
const afterFrames = Number(opt('after', '20'));
const noui = flag('noui');

const qs = ['shot=1', query, noui ? 'noui=1' : ''].filter(Boolean).join('&');
const url = `${base}?${qs}#${exp}`;

mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
const errors = [];
const warnings = [];
page.on('console', (m) => {
  const t = m.type();
  const text = m.text();
  if (t === 'error') errors.push(text);
  else if (t === 'warning' && !/GPU stall|swiftshader|Automatic fallback/i.test(text)) warnings.push(text);
});
page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));

let ok = true;
const t0 = Date.now();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(
    (n) => window.__universe && window.__universe.ready && window.__universe.framesSinceReady >= n,
    frames,
    { timeout, polling: 250 },
  );
  if (evalJs) {
    await page.evaluate(evalJs);
    const f0 = await page.evaluate(() => window.__universe.frames);
    await page.waitForFunction((n) => window.__universe.frames >= n, f0 + afterFrames, { timeout, polling: 250 });
  }
} catch (e) {
  ok = false;
  errors.push(`not ready: ${String(e?.message ?? e).split('\n')[0]}`);
}
await page.screenshot({ path: out });
const info = await page.evaluate(() => {
  const u = window.__universe;
  let renderer = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    renderer = gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
  } catch {}
  return u ? { frames: u.frames, framesSinceReady: u.framesSinceReady, ready: u.ready, pageErrors: u.errors, renderer } : { renderer };
});
const wall = (Date.now() - t0) / 1000;
const report = { out, url, wallSeconds: wall, fpsWall: info.frames ? +(info.frames / wall).toFixed(2) : 0, ...info, errors, warnings: warnings.slice(0, 20) };
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(ok && errors.length === 0 && !(info.pageErrors?.length) ? 0 : 1);

import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const q = opt('quality', 'high'), w = +opt('w', 640), h = +opt('h', 360), views = opt('views', 'default').split(',');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:5226/?shot=1&noui=1&quality=${q}#milkyway`, { timeout: 300000 });
await page.waitForFunction(() => window.__universe?.ready && window.__universe.framesSinceReady >= 3, null, { timeout: 900000, polling: 500 });
for (const view of views) {
  await page.evaluate((v) => { window.__universe.experience.setView(v, 0); }, view);
  const f0 = await page.evaluate(() => window.__universe.frames); await page.waitForFunction((n) => window.__universe.frames >= n, f0 + 3, { timeout: 900000, polling: 250 });
  const res = await page.evaluate(async () => {
    const U = window.__universe, r = U.app.engine.renderer, L = U.experience.galaxy, gl = r.getContext();
    const vu = L.volMat.uniforms;
    const run = () => { L.quad.material = L.volMat; L.quad.render(r, L.volRT); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4)); };
    run();
    const t0 = performance.now(); for (let i = 0; i < 3; i++) run(); const ms = (performance.now() - t0) / 3;
    vu.uDebug.value = 4; run(); vu.uDebug.value = 0;
    const W = L.volRT.width, H = L.volRT.height; const b = new Uint16Array(W * H * 4); r.readRenderTargetPixels(L.volRT, 0, 0, W, H, b);
    const f16 = (x) => { const e = (x >> 10) & 31, m = x & 1023; return e === 0 ? m / 1024 / 16384 : Math.pow(2, e - 15) * (1 + m / 1024); };
    let s = 0, hit = 0; for (let i = 0; i < W * H; i++) { const v = f16(b[i * 4]); s += v; if (v > 0) hit++; }
    return { vol: [W, H], swiftshaderMs: +ms.toFixed(1), meanSteps: +(s / (W * H) * vu.uMaxSteps.value).toFixed(1), meanStepsHit: +(s / Math.max(hit, 1) * vu.uMaxSteps.value).toFixed(1), hit: +(hit / (W * H)).toFixed(2), maxSteps: vu.uMaxSteps.value };
  });
  console.log(JSON.stringify({ view, ...res }));
}
await browser.close();

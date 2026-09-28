import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const q = opt('quality', 'high'), w = +opt('w', 960), h = +opt('h', 540), views = opt('views', 'default').split(',');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:5226/?shot=1&noui=1&quality=${q}#milkyway`, { timeout: 300000 });
await page.waitForFunction(() => window.__universe?.ready && window.__universe.framesSinceReady >= 3, null, { timeout: 900000, polling: 500 });
for (const view of views) {
  await page.evaluate((v) => { window.__universe.experience.setView(v, 0); }, view);
  const f0 = await page.evaluate(() => window.__universe.frames); await page.waitForFunction((n) => window.__universe.frames >= n, f0 + 3, { timeout: 900000, polling: 250 });
  const res = await page.evaluate(async () => {
    const U = window.__universe, r = U.app.engine.renderer, L = U.experience.galaxy, cam = U.experience.camera, hdr = U.app.engine.hdr;
    const T = L.volRT.constructor;
    const W = hdr.width, H = hdr.height;
    const mk = () => new T(W, H, { type: L.volRT.texture.type, depthBuffer: false });
    const A = mk(), B = mk();
    const f16 = (x) => { const e = (x >> 10) & 31, m = x & 1023, s = x >> 15 ? -1 : 1; return s * (e === 0 ? m / 1024 / 16384 : Math.pow(2, e - 15) * (1 + m / 1024)); };
    const vv = L.volumeVisible; L.volumeVisible = false;
    const opts = { exposure: U.experience.ctx.post.exposure, frame: 7 };
    const draw = (rt) => { r.setRenderTarget(rt); r.setClearColor(0, 1); r.clear(); L.render(r, cam, rt, opts); };
    draw(A);
    const lo = L.starLoRT; L.starLoRT = null; draw(B); L.starLoRT = lo; L.volumeVisible = vv;
    const read = (rt) => { const b = new Uint16Array(W * H * 4); r.readRenderTargetPixels(rt, 0, 0, W, H, b); return b; };
    const a = read(A), b = read(B); A.dispose(); B.dispose();
    let sa = 0, sb = 0, sd = 0, mx = 0, mxA = 0;
    for (let i = 0; i < W * H; i++) { const la = 0.2126 * f16(a[i * 4]) + 0.7152 * f16(a[i * 4 + 1]) + 0.0722 * f16(a[i * 4 + 2]); const lb = 0.2126 * f16(b[i * 4]) + 0.7152 * f16(b[i * 4 + 1]) + 0.0722 * f16(b[i * 4 + 2]); sa += la; sb += lb; sd += Math.abs(la - lb); mx = Math.max(mx, Math.abs(la - lb)); mxA = Math.max(mxA, lb); }
    return { fluxRatioSplitOverFull: sa / sb, relL1: sd / sb, maxAbs: mx, maxFull: mxA, lo: lo && [lo.width, lo.height] };
  });
  console.log(JSON.stringify({ view, ...res }));
}
await browser.close();

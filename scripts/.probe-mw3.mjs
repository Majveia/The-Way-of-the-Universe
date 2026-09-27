import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const q = opt('quality', 'high'), w = +opt('w', 960), h = +opt('h', 540), view = opt('view', 'default');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:5226/?shot=1&noui=1&quality=${q}#milkyway`, { timeout: 300000 });
await page.waitForFunction(() => window.__universe?.ready && window.__universe.framesSinceReady >= 3, null, { timeout: 900000, polling: 500 });
await page.evaluate((v) => { window.__universe.experience.setView(v, 0); window.__universe.experience.paused = true; }, view);
const res = await page.evaluate(async () => {
  const U = window.__universe, r = U.app.engine.renderer, L = U.experience.galaxy, cam = U.experience.camera, hdr = U.app.engine.hdr;
  const frame = (n = 1) => new Promise((res) => { const f0 = U.frames; const t = () => (U.frames >= f0 + n ? res() : setTimeout(t, 50)); t(); });
  await frame(3);
  // Fragment counts per pass.
  const f16 = (x) => { const e = (x >> 10) & 31, m = x & 1023; return e === 0 ? m / 1024 / 16384 : Math.pow(2, e - 15) * (1 + m / 1024); };
  const T = L.volRT.constructor;
  const count = (pass, W, H) => {
    const rt = new T(W, H, { type: L.volRT.texture.type, depthBuffer: false });
    const mat = L.starMat, fs = mat.fragmentShader;
    mat.fragmentShader = 'precision highp float; out vec4 outColor; void main(){ outColor = vec4(1.0/16.0, 0.0, 0.0, 1.0); }'; mat.needsUpdate = true;
    mat.uniforms.uPass.value = pass; mat.uniforms.uLoScale.value = H / hdr.height;
    L.hii.visible = false;
    r.setRenderTarget(rt); r.setClearColor(0, 0); r.clear(); r.render(L.starScene, cam); r.setClearColor(0, 1);
    L.hii.visible = true; mat.fragmentShader = fs; mat.needsUpdate = true;
    const buf = new Uint16Array(W * H * 4); r.readRenderTargetPixels(rt, 0, 0, W, H, buf); rt.dispose();
    let s = 0; for (let i = 0; i < W * H; i++) s += f16(buf[i * 4]) * 16; return Math.round(s);
  };
  const lo = L.starLoRT;
  const frags = { all: count(0, hdr.width, hdr.height), sharp: count(1, hdr.width, hdr.height), smoothLo: count(2, lo.width, lo.height) };
  await frame(2);
  const grab = () => { const c = document.createElement('canvas'); c.width = r.domElement.width; c.height = r.domElement.height; const x = c.getContext('2d'); x.drawImage(r.domElement, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
  const A = grab();
  L.starLoRT = null; await frame(3);
  const B = grab();
  L.starLoRT = lo; await frame(1);
  let sum = 0, mx = 0, n = 0, sumA = 0, big = 0;
  for (let i = 0; i < A.length; i += 4) for (let k = 0; k < 3; k++) { const d = Math.abs(A[i + k] - B[i + k]); sum += d; sumA += A[i + k]; mx = Math.max(mx, d); if (d > 12) big++; n++; }
  return { target: [hdr.width, hdr.height], lo: [lo.width, lo.height], vol: [L.volRT.width, L.volRT.height], frags, diff: { meanAbs: sum / n, meanA: sumA / n, max: mx, fracOver12: big / n } };
});
console.log(JSON.stringify({ q, w, h, view, ...res }));
await browser.close();

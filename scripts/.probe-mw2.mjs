import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const q = opt('quality', 'high'), w = +opt('w', 960), h = +opt('h', 540), view = opt('view', 'default');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:5226/?shot=1&quality=${q}#milkyway`, { timeout: 300000 });
await page.waitForFunction(() => window.__universe?.ready && window.__universe.framesSinceReady >= 3, null, { timeout: 600000, polling: 500 });
await page.evaluate((v) => window.__universe.experience.setView(v, 0), view);
const f0 = await page.evaluate(() => window.__universe.frames); await page.waitForFunction((n) => window.__universe.frames >= n, f0 + 4, { timeout: 600000, polling: 250 });
const res = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js').catch(() => null);
  const U = window.__universe, r = U.app.engine.renderer, L = U.experience.galaxy, cam = U.experience.camera;
  const hdr = U.app.engine.hdr;
  const out = {};
  const f16 = (x) => { const e = (x >> 10) & 31, m = x & 1023; return e === 0 ? m / 1024 / 16384 : Math.pow(2, e - 15) * (1 + m / 1024); };
  const T = L.volRT.constructor; // WebGLRenderTarget
  const rt = new T(hdr.width, hdr.height, { type: L.volRT.texture.type, depthBuffer: false });
  for (const [name, mat, obj] of [['stars', L.starMat, L.stars], ['hii', L.hiiMat, L.hii]]) {
    if (!obj) continue;
    const fs = mat.fragmentShader;
    mat.fragmentShader = name==='stars' ? 'precision highp float; in float vSize; out vec4 outColor; void main(){ outColor = vec4(1.0/16.0, vSize > 7.5 ? 1.0/16.0 : 0.0, vSize > 12.5 ? 1.0/16.0 : 0.0, 1.0); }' : 'precision highp float; out vec4 outColor; void main(){ outColor = vec4(1.0/16.0, 0.0, 0.0, 1.0); }';
    mat.needsUpdate = true;
    const others = L.starScene.children.filter((c) => c !== obj); others.forEach((c) => (c.visible = false));
    r.setRenderTarget(rt); r.setClearColor(0, 0); r.clear(); r.render(L.starScene, cam);
    others.forEach((c) => (c.visible = true));
    mat.fragmentShader = fs; mat.needsUpdate = true;
    const buf = new Uint16Array(hdr.width * hdr.height * 4); r.readRenderTargetPixels(rt, 0, 0, hdr.width, hdr.height, buf);
    let s = 0, mx = 0, big = 0, huge = 0; for (let i = 0; i < hdr.width * hdr.height; i++) { const v = f16(buf[i * 4]) * 16; s += v; big += f16(buf[i*4+1])*16; huge += f16(buf[i*4+2])*16; mx = Math.max(mx, v); }
    out[name] = { fragments: Math.round(s), perPixel: s / (hdr.width * hdr.height), maxOverdraw: mx, fracSigmaGt1_25: big / s, fracSigmaGt2: huge / s };
  }
  rt.dispose();
  return { target: [hdr.width, hdr.height], pxPerRad: L.starMat.uniforms.uPxPerRad.value, out };
});
console.log(JSON.stringify({ q, w, h, view, ...res }, null, 1));
await browser.close();

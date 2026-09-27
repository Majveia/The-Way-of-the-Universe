import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text().slice(0, 200)); });
page.on('pageerror', (e) => errs.push(String(e)));
// No query string at all (hosted artifact); quality auto.
await page.goto(`http://127.0.0.1:5226/#milkyway`, { timeout: 300000 });
const ready = async (id) => page.waitForFunction((id) => window.__universe?.ready && window.__universe.experienceId === id && window.__universe.framesSinceReady >= 3, id, { timeout: 900000, polling: 500 });
await ready('milkyway');
const mem = () => page.evaluate(() => { const r = window.__universe.app.engine.renderer; return { ...r.info.memory, programs: r.info.programs.length }; });
const out = { first: await mem() };
for (let k = 0; k < 2; k++) {
  await page.evaluate(() => (location.hash = '#prelude'));
  await ready('prelude');
  out['prelude' + k] = await mem();
  await page.evaluate(() => (location.hash = '#milkyway'));
  await ready('milkyway');
  out['mw' + k] = await mem();
}
// Resize.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForFunction(() => window.__universe.framesSinceReady >= 0, null, { timeout: 60000 });
const f0 = await page.evaluate(() => window.__universe.frames);
await page.waitForFunction((n) => window.__universe.frames >= n, f0 + 4, { timeout: 600000, polling: 250 });
out.afterResize = await page.evaluate(() => { const L = window.__universe.experience.galaxy; const e = window.__universe.app.engine; return { hdr: [e.hdr.width, e.hdr.height], vol: [L.volRT.width, L.volRT.height], lo: L.starLoRT && [L.starLoRT.width, L.starLoRT.height], tier: e.quality.tier }; });
out.errors = errs.filter((e) => !/ERR_CERT|GPU stall|fonts/.test(e));
out.pageErrors = await page.evaluate(() => window.__universe.errors);
console.log(JSON.stringify(out, null, 1));
await browser.close();

#!/usr/bin/env node
/**
 * Post-process `vite build --mode artifact` output (dist-artifact/) for a sandboxed artifact host:
 *  - the host wraps the page in its own <!doctype><html><head><body>, so emit body content only
 *    (plus <title>, <style>, font <link>s);
 *  - inline the CSS bundle (only Google Fonts stylesheets may be external);
 *  - keep JS as relative module files published alongside (assets/…);
 *  - report total size (host limit: 16 MB page, 64 MB per version).
 * Output: dist-artifact/page.html + dist-artifact/assets/*
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist-artifact';
let html = readFileSync(join(dir, 'index.html'), 'utf8');

const title = (html.match(/<title>[\s\S]*?<\/title>/) ?? ['<title>The Way of the Universe</title>'])[0];
const fontLinks = [...html.matchAll(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/g)].map((m) => m[0]);
const cssLinks = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\.\/(assets\/[^"]+\.css)"[^>]*>/g)];
const css = cssLinks.map((m) => readFileSync(join(dir, m[1]), 'utf8')).join('\n');
const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*><\/script>/g)].map((m) => m[0].replace(/\s+crossorigin(="[^"]*")?/, ''));
const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]*>/g)].map((m) => m[0].replace(/\s+crossorigin(="[^"]*")?/, ''));
const body = (html.match(/<body>([\s\S]*?)<\/body>/) ?? ['', ''])[1].replace(/<script[\s\S]*?<\/script>/g, '').trim();

const page = [
  title,
  '<meta name="theme-color" content="#000000" />',
  ...fontLinks,
  `<style>${css}</style>`,
  ...preloads,
  body,
  ...scripts,
].join('\n');
writeFileSync(join(dir, 'page.html'), page);

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const assets = walk(join(dir, 'assets'));
const total = assets.reduce((s, f) => s + statSync(f).size, 0) + Buffer.byteLength(page);
console.log(JSON.stringify({ page: join(dir, 'page.html'), pageBytes: Buffer.byteLength(page), assets: assets.length, totalMB: +(total / 1048576).toFixed(2) }, null, 2));
if (total > 60 * 1048576) {
  console.error('artifact too large');
  process.exit(1);
}

# Engineering guide

TypeScript + three.js r186 (WebGL2) + Vite 8. No other runtime dependencies. Everything is
procedural or bundled; nothing is fetched at runtime (the app must work inside a sandboxed
artifact host with no network and **no query string** — only `#hash` routing).

## Layout

```
src/main.ts                 boot
src/app/App.ts              router (#hash → experience), fades, frame loop, window.__universe debug handle
src/core/Engine.ts          WebGL2 renderer, HDR target, dynamic resolution, quality tiers
src/core/post/Post.ts       bloom (13-tap mip chain) → exposure → ACES/AgX → vignette → dither → canvas
src/core/post/FullscreenQuad.ts
src/core/Input.ts           pointer/touch/wheel/keys → InputScope (auto-disposed per experience)
src/core/rigs/OrbitRig.ts   smooth orbit camera, log-space zoom, flyTo()
src/core/rigs/FlyRig.ts     6-DOF free flight
src/core/types.ts           Experience / ExperienceContext contracts
src/ui/                     UI shell, Panel (declarative controls), style.css, icons
src/audio/                  AudioBus (+ generative engine)
src/physics/                constants, units, random, noise, blackbody, spectrum, cosmology, kepler
src/shaders/lib/            GLSL: COMMON_GLSL, NOISE_GLSL, BLACKBODY_GLSL
src/worlds/sky/Sky.ts       procedural starfield + Milky Way background
src/worlds/planet/          planet renderer contract (types.ts) + implementation
src/worlds/star/            star renderer
src/experiences/<id>/       one directory per experience; index.ts default-exports a factory
src/experiences/index.ts    the catalogue (menu order)
tests/*.test.ts             vitest (node) — physics and pure logic
scripts/shot.mjs            headless screenshot + health report
docs/                       this guide, the vision, module specs
```

## The experience contract (`src/core/types.ts`)

```ts
export default () => new MyExperience();       // src/experiences/<id>/index.ts

class MyExperience implements Experience {
  mount(ctx: ExperienceContext): void | Promise<void>;  // build scene; ctx.progress(); ctx.signalReady()
  update(f: FrameInfo): void;                            // f.dt (s, clamped), f.time, f.frame
  render(target: THREE.WebGLRenderTarget): void;         // draw linear HDR into target
  resize?(w: number, h: number): void;                   // HDR target pixels
  unmount(): void;                                       // dispose EVERYTHING you created
}
```

`ExperienceContext` gives: `engine`, `renderer`, `canvas`, `input` (InputScope), `ui` (UIScope),
`audio`, `quality` (tier, `detail` multiplier 0.35–1.6, msaa), `params` (URL query — dev only),
`post` (PostSettings for this experience: exposure, bloomStrength, bloomRadius, tonemap
'aces'|'agx'|'agx-punchy'|'linear', saturation, vignette, chromaticAberration), `progress()`,
`signalReady()`.

### Rendering rules

- `renderer.autoClear === false`. The engine clears the HDR target (color+depth) to black before
  your `render()`. Bind it with `renderer.setRenderTarget(target)`. Clear depth yourself between
  layers with different near/far (`renderer.clearDepth()`).
- Output **linear radiance** (no tone mapping, no sRGB encode) — the Post pass does that. Built-in
  three materials already write linear when rendering to a render target.
- The HDR target is RGBA16F with depth (+MSAA on high tiers). If you need depth as a texture or
  low-res passes, create your own targets (HalfFloatType) and composite into `target`.
- Resolution: `engine.pixelRatio` (device px per CSS px incl. dynamic scale) — use it for
  `gl_PointSize`. `target.width/height` are pixels. For very heavy passes (ray marching), render
  at a fraction of the target size and upsample yourself; `engine.setRenderScale()` exists but
  prefer your own internal scale.
- Shaders: prefer `THREE.ShaderMaterial` with `glslVersion: THREE.GLSL3` (use `in/out`,
  `out vec4 outColor`). three injects `float luminance(vec3)` into every ShaderMaterial fragment
  shader — never define your own `luminance`; use `luma()` from COMMON_GLSL.
  Libraries: `COMMON_GLSL` (hashes, ign(), raySphere(), phase functions, rot2),
  `NOISE_GLSL` (snoise, snoise4, fbm3, fbm4, ridged3, warpedFbm, worley3, curlNoise),
  `BLACKBODY_GLSL` (`blackbody(T)` → linear RGB with luminance 1).
- Precision: keep each layer in sensible native units (Mpc, pc, AU, km, gravitational radii).
  three.js computes modelView matrices in float64 on the CPU, so objects placed with their own
  origin near the camera stay precise; avoid giant vertex coordinates far from their object origin.
  Rigs support camera-relative rendering: `rig.applyTo(camera, origin)`.
- Frames: three.js is **y-up**. Astronomical frames are z-up; convert with
  `astroToThree()` ((x, y, z) → (x, z, −y)) from `src/physics/kepler.ts`.
- Background sky: `new Sky({ frame: 'ecliptic' | 'equatorial' | 'galactic', stars, milkyWay })`;
  call `sky.render(renderer, camera, engine.pixelRatio)` first, then `renderer.clearDepth()`.
- No allocations in per-frame paths (reuse vectors/arrays). Dispose geometries, materials,
  textures and render targets in `unmount()`; remove any DOM you add outside UIScope.

### UI (UIScope — everything is auto-removed on unmount)

```ts
const dist = ctx.ui.readout('Distance', 'M');        // bottom-left live value
dist.set(formatNumber(r, 3), 'r_g');
const s = ctx.ui.section('Accretion disk');           // right-hand Controls panel (key P)
s.slider({ label: 'Spin a/M', min: 0, max: 0.998, value: 0.9, onChange: v => … });
s.slider({ label: 'Mass', min: 1, max: 1e10, log: true, unit: 'M☉', value: 4.3e6, onChange });
s.toggle({ label: 'Doppler beaming', value: true, onChange });
s.select({ label: 'Preset', value: 'a', options: [{ value: 'a', label: 'A' }], onChange });
s.buttons([{ label: 'Face-on', onClick }, …], 0);
s.text('Short explanation.'); s.readout('Label')('value'); s.custom(element);
ctx.ui.hint('Drag to orbit · Scroll to zoom');       // bottom-centre, fades
ctx.ui.info({ title, subtitle, rows: [['Mass', '4.3 × 10⁶ M☉']], body });  // info card
ctx.ui.toast('Seed 42');
ctx.ui.corner(element);                               // bottom-right slot (timeline, scale bar)
ctx.ui.overlay                                        // full-screen div for labels (pointer-events none)
```
Keep the house style (docs/VISION.md). Numbers via `src/physics/units.ts`
(`formatNumber`, `formatScientific`, `formatDistance`, `formatDuration`, `formatSpeed`,
`formatMass`, `formatTemperature`). Custom DOM should use the CSS variables in `src/ui/style.css`
(`--ink`, `--ink-2`, `--ink-3`, `--line`, `--accent`, `--cool`, `--font-ui`, `--font-mono`, `--glass`).
Global keys already taken: `M` menu, `P` controls, `H` hide UI, `Esc`. Experiences may use others
(Space, WASD, R/F, Q/E, arrows, digits, [ ], T, L, …) — list yours in a hint.

### Input

`ctx.input.onDrag / onWheel / onPinch / onTap / onDoubleTap / onKeyDown / onKeyUp / onMove`,
`ctx.input.isDown('KeyW')`, `ctx.input.pointer` ({x,y,ndcX,ndcY}). `new OrbitRig(ctx.input, {…})`
binds drag/wheel/pinch; `rig.update(dt)`, `rig.applyTo(camera)`, `rig.flyTo({target, distance, yaw, pitch}, seconds)`.

### Audio

`ctx.audio.setMood('blackhole', { intensity: 0.7, mass: 4e6 })` on mount and when the scene
changes character; `ctx.audio.event('portal')` for one-shots. The sound engine decides what that
sounds like; never create your own AudioContext.

### Workers

`new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })` works in dev and in
the build. Workers in the DOM lib typing: post with
`(self as unknown as Worker).postMessage(msg, transfers)`. Always provide a main-thread fallback
if the worker fails to construct, and `terminate()` in `unmount()`.

## Parallel-work rules (several engineers edit this tree at the same time)

1. **Own your files.** Only edit the paths your module spec lists. Core files
   (`src/core`, `src/app`, `src/ui`, `src/audio`, existing `src/physics/*`, existing
   `src/shaders/lib/*`, `src/worlds/sky`, `src/worlds/planet`, `src/worlds/star`) belong to their
   owners (see each spec). You may ADD new files under `src/physics/` or `src/shaders/lib/`
   prefixed with your module id. If a core change is truly essential, make the smallest
   backward-compatible edit and report it.
2. **No new npm dependencies. Do not run `npm install`.** No runtime network access.
3. **No git.** Don't commit, stash, reset, checkout or push — the lead integrates.
4. **Your port only.** Start the dev server with `npx vite --port <PORT> --strictPort &` (your
   spec's port). If it says the port is in use, a previous run's server is still up — reuse it.
5. **Type-check your files:** `npx tsc --noEmit -p . 2>&1 | grep -E "<your paths>"` must be empty
   (others may be mid-edit — ignore their errors).
6. **Tests:** pure logic/physics in `tests/<module>.test.ts`; `npx vitest run tests/<module>.test.ts`.

## Verifying visually

```
node scripts/shot.mjs --port <PORT> --exp <experience-id> --out shots/<module>/<name>.png \
     [--w 1280 --h 720] [--frames 30] [--query "quality=low"] [--eval "<js>"] [--after 20] [--noui]
```
- Waits until your experience calls `ctx.signalReady()` and N frames have rendered (fixed
  dt = 1/60 per frame in shot mode, so simulations are deterministic per frame count).
- `--eval` runs JS in the page after that (e.g. drive your experience through debug hooks you
  expose: `window.__universe.experience.setView('edge-on')`), then waits `--after` more frames.
- Prints JSON: frames, fps, WebGL renderer, console errors. **Look at every PNG** (Read tool)
  and judge it against docs/VISION.md.
- Chromium here renders WebGL on SwiftShader (CPU) at ~0.2–5 fps: iterate at `--w 960 --h 540`,
  few frames, `quality=low`; final evidence at 1280×720 default quality. Design for real GPUs.
- The app is served at `/` with `#<experience-id>`; the query string is for dev only (the hosted
  artifact has none), so every feature must work with defaults and in-page controls.

## Definition of done (every module)

- Gorgeous default view on load (it's the first impression), plus at least 3 other compelling
  states reachable through the UI.
- Physics documented in code comments with references; pure functions unit-tested.
- Controls meaningful and labelled in plain language with units; readouts correct.
- No console errors or warnings; clean mount → unmount → mount (navigate away and back).
- Runs on `quality=low|medium|high` (detail scales particle counts / steps / resolution).
- Touch works (drag, pinch) and layout is fine at 390×844.

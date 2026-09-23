# Module: audio-ui — generative sound and interface polish

- No own experience (works across all). Port: **5210** (use any experience for testing).
- Owns: `src/audio/**` (keep `AudioBus` API; implement the real `SoundEngine` in `engine.ts` and
  new files), `src/ui/**` (keep the public API of `UI`, `UIScope`, `Panel`, `PanelSection`
  backward compatible — every experience uses it), `src/app/App.ts` only for intro/tour hooks
  (minimal, careful), `index.html` (fonts/meta only), `tests/audio-ui.test.ts`.

## Goal
Make the whole thing feel like a finished, cinematic product: sound that breathes with the
universe and an interface that is invisible until needed and delightful when it appears.

## Sound (Web Audio, generative, CPU-light)
- A mood per experience via `setMood(name, params)`: prelude, cosmos, gargantua (blackhole),
  milkyway (galaxy), collision, nebulae, solar, earth, worlds, voyage. Crossfade moods (~4 s).
- Palette: evolving ambient pads (detuned oscillators, filtered noise, slow LFOs, convolution-free
  reverb via feedback delay networks), sub-bass drones, sparse bell/glass tones in natural
  harmonic series; plus an optional **"space jazz" layer** (original, generative — modal harmony
  (Dorian / Lydian), soft FM electric-piano voicings, a walking upright-bass-like line, brushed
  noise percussion; a nod to a certain 1998 space-western's lounge moments, never a copy) that can
  be toggled in a small sound menu.
- Sonification hooks via `event()` / mood params: black hole proximity → deeper drone; pulsar
  ticks; collision rumble on pericentre passage; portal whoosh; UI micro-sounds (very subtle,
  optional, off by default).
- Master volume + music on/off in a minimal popover from the sound button (or panel section).
- Performance: no per-frame node creation; schedule with look-ahead; < 3% CPU on a laptop.

## Interface polish
- **Opening title sequence** on first load (no hash): black → the ringed-planet mark and
  "THE WAY OF THE UNIVERSE" fade in over the prelude sky → a single line ("13.8 billion years
  ago, the universe began to cool…" or a Sagan line) → menu. Skippable (click/any key), shown
  once per session (sessionStorage, guarded by try/catch), respects reduced motion.
- **Help overlay** (`?` key): controls for the current experience (experiences can register
  their shortcuts via a small additive API on UIScope, e.g. `ctx.ui.shortcuts([...])`).
- **Command palette** (Ctrl/Cmd + K): jump to any experience; experiences can register
  destinations (e.g. "Saturn", "Sgr A*") via an additive UIScope API with callbacks.
- Menu: keyboard navigation (arrows, Enter), live mini-preview thumbnails are optional; keep it
  typographic and elegant. Mobile: bottom-sheet panel, larger touch targets (≥ 40px), no hover
  dependence.
- Readout/hint consistency, focus states, `prefers-reduced-motion`, ARIA labels.
- A tiny FPS/quality indicator toggle (backtick key) for diagnostics.

## Acceptance
Screenshots: title sequence frames, menu (desktop + 390×844), help overlay, command palette,
panel open on mobile. Audio can't be screenshotted — describe the design and verify no errors.

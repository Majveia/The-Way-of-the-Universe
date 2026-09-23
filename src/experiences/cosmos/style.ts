/** Scoped styles for the Cosmic Web experience (inserted on mount, removed on unmount). */
export const COSMOS_CSS = /* css */ `
.cw-timeline {
  width: min(540px, calc(100vw - 2 * var(--gutter)));
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 10px;
  align-items: center;
  pointer-events: auto;
}
.cw-timeline .cw-play { grid-row: 1 / span 2; }
.cw-track {
  position: relative;
  height: 30px;
  cursor: pointer;
  touch-action: none;
  outline: none;
}
.cw-track:focus-visible .cw-rail { background: var(--accent); }
.cw-rail, .cw-buffer, .cw-fill {
  position: absolute;
  left: 0;
  top: 50%;
  height: 1px;
}
.cw-rail { right: 0; background: var(--line); }
.cw-buffer { width: 0; background: rgba(236, 232, 225, 0.3); transition: width 0.4s var(--ease); }
.cw-fill { width: 0; background: var(--accent); }
.cw-head {
  position: absolute;
  top: 50%;
  left: 0;
  width: 9px;
  height: 9px;
  margin: -4.5px 0 0 -4.5px;
  border-radius: 50%;
  background: var(--ground);
  border: 1px solid var(--accent);
  box-shadow: 0 0 10px rgba(255, 198, 144, 0.35);
}
.cw-ticks { position: absolute; inset: 0; pointer-events: none; }
.cw-tick {
  position: absolute;
  top: 50%;
  width: 1px;
  height: 5px;
  margin-top: -2.5px;
  background: var(--ink-3);
}
.cw-tick.is-major { height: 9px; margin-top: -4.5px; background: var(--ink-2); }
.cw-tick span {
  position: absolute;
  bottom: 9px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 8.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink-3);
  opacity: 0;
  transition: opacity 0.3s var(--ease);
}
.cw-tick.is-major span { opacity: 0.9; color: var(--ink-2); }
.cw-track:hover .cw-tick span, .cw-track:focus-visible .cw-tick span { opacity: 1; }
.cw-meta {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  min-height: 22px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
}
.cw-meta .cw-z { color: var(--ink); min-width: 9ch; text-align: right; }
.cw-meta .cw-speed { padding: 2px 9px; font-family: var(--font-mono); font-size: 10.5px; }
.cw-busy {
  font-family: var(--font-ui);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-3);
  opacity: 0;
  transition: opacity 0.6s var(--ease);
}
.cw-busy.is-on { opacity: 1; animation: cw-pulse 2.4s var(--ease) infinite; }
@keyframes cw-pulse { 50% { color: var(--accent); } }

.cw-caption {
  position: absolute;
  left: 50%;
  bottom: calc(var(--gutter-bottom) + 118px);
  transform: translate(-50%, 6px);
  width: min(560px, calc(100vw - 2 * var(--gutter)));
  text-align: center;
  opacity: 0;
  transition: opacity 1.4s var(--ease), transform 1.4s var(--ease);
  pointer-events: none;
}
.cw-caption.is-visible { opacity: 1; transform: translate(-50%, 0); }
.cw-caption-kicker {
  font-size: 10px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 6px;
}
.cw-caption-line {
  font-weight: 300;
  font-size: clamp(14px, 1.5vw, 17px);
  line-height: 1.45;
  letter-spacing: 0.01em;
  color: var(--ink);
  text-wrap: balance;
  text-shadow: 0 0 18px #000, 0 0 4px #000;
}
.ui.is-hidden .cw-caption { opacity: 0 !important; }

.cw-ring {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  pointer-events: none;
  will-change: transform;
}
.cw-ring::before {
  content: '';
  position: absolute;
  left: calc(var(--r) * -1);
  top: calc(var(--r) * -1);
  width: calc(var(--r) * 2);
  height: calc(var(--r) * 2);
  border-radius: 50%;
  border: 1px solid rgba(174, 203, 255, 0.7);
}
.cw-ring.is-selected::before { border-color: var(--accent); }
.cw-ring span {
  position: absolute;
  left: calc(var(--r) + 8px);
  top: -7px;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-2);
  text-shadow: 0 0 6px #000;
}
.cw-scale {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-3);
}
.cw-scale i { display: block; height: 1px; background: var(--ink-3); }
.cw-note { font-size: 10.5px; color: var(--ink-3); line-height: 1.5; }

@media (max-width: 720px) {
  .cw-caption { bottom: calc(var(--gutter-bottom) + 190px); }
  .cw-timeline { width: calc(100vw - 2 * var(--gutter)); }
}
`;

import type { Shortcut } from './Help';

const KEY_FIRST =
  /^((?:[A-Z]|[0-9](?:\s?[–-]\s?[0-9])?|F[0-9]{1,2}|Space|Shift|Esc|Enter|Tab|Ctrl|Alt|WASD|QE|RF|[←→↑↓]+|\[\s?\]|\[|\]|[+=-]|`|\?))\s+(?!to\b)(.+)$/;

/**
 * Turn a hint line ("Drag to orbit · Scroll to zoom · Space to pause") into shortcuts,
 * so every world has useful help even before it registers its own. Pure.
 */
export function hintToShortcuts(hint: string): Shortcut[] {
  if (!hint) return [];
  const out: Shortcut[] = [];
  for (const raw of hint.split(/\s*[·•|]\s*/)) {
    const part = raw.trim();
    if (!part) continue;
    const k = KEY_FIRST.exec(part);
    // "A distant galaxy…" is prose, not the A key: single letters only with a short action.
    if (k && !(/^[AI]$/.test(k[1]) && k[2].split(/\s+/).length > 3)) {
      const key = k[1];
      const keys = /^[A-Z]{2,4}$/.test(key) && !/^(ESC|TAB)$/.test(key) ? key.split('') : [key];
      out.push({ keys, label: k[2].charAt(0).toUpperCase() + k[2].slice(1) });
      continue;
    }
    const m = /^(.+?)\s+(?:to|for|=|:)\s+(.+)$/i.exec(part);
    if (m && m[1].length <= 24) {
      const keys = m[1]
        .split(/\s*(?:\/|,|\+| or )\s*/)
        .map((k) => k.trim())
        .filter(Boolean);
      out.push({ keys, label: m[2].charAt(0).toUpperCase() + m[2].slice(1) });
    } else out.push({ keys: [], label: part });
  }
  return out;
}

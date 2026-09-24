/**
 * Tiny fuzzy matcher for the command palette (pure; unit-tested).
 * Score rewards: exact prefix ≫ word-start matches ≫ consecutive runs ≫ scattered letters.
 * Returns 0 when not every query character can be matched in order.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 700 - idx - t.length * 0.1 + (isWordStart(t, idx) ? 150 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === ' ') continue;
    let found = -1;
    // prefer the next word-start occurrence, then any occurrence
    for (let k = ti; k < t.length; k++) {
      if (t[k] === c && isWordStart(t, k)) {
        found = k;
        break;
      }
    }
    if (found < 0) found = t.indexOf(c, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 6 + (isWordStart(t, found) ? 18 : 0) - Math.min(8, found - ti);
    ti = found + 1;
  }
  return Math.max(1, score);
}

function isWordStart(t: string, i: number): boolean {
  return i === 0 || /[\s·\-—/(]/.test(t[i - 1]);
}

/** Every query word must occur in the text (as a substring); earlier, word-start hits score higher. */
export function wordScore(query: string, text: string): number {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const t = text.toLowerCase();
  let score = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i < 0) return 0;
    score += 400 - Math.min(300, i) + (isWordStart(t, i) ? 150 : 0);
  }
  return score / words.length;
}

export interface Rankable {
  label: string;
  keywords?: string;
  group?: string;
}

/** Filter and sort by score (stable for ties and for the empty query). */
export function rankCommands<T extends Rankable>(query: string, items: readonly T[]): T[] {
  if (!query.trim()) return items.slice();
  const scored: Array<{ item: T; s: number; i: number }> = [];
  items.forEach((item, i) => {
    // Scattered-letter matching only on the label; descriptions must contain the words.
    const s = Math.max(fuzzyScore(query, item.label), wordScore(query, item.keywords ?? '') * 0.8, wordScore(query, `${item.group ?? ''} ${item.label}`) * 0.6);
    if (s > 0) scored.push({ item, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.item);
}

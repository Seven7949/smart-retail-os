/**
 * Fuzzy item matching for voice billing and invoice scanning.
 * Handles English, Hinglish (Roman) and Devanagari names + aliases, typos
 * ("magi", "parle ji") and noisy invoice text ("PARLE-G 80G").
 */
import type { Item } from './types';

export interface Match {
  readonly item: Item;
  readonly score: number; // 0..1
}

const SIZE_RE = /\b\d+(\.\d+)?\s*(g|gm|gms|kg|ml|l|ltr|pcs|pc|x)\b/g;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(SIZE_RE, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const similarity = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

function candidates(item: Item): string[] {
  const raw = [item.name, item.hi ?? '', ...(item.aliases ?? []), item.sku.replace(/-/g, ' ')];
  return Array.from(new Set(raw.map(normalize).filter((s) => s.length > 0)));
}

/** Score how well `phrase` names `item`. Exact alias containment wins. */
export function scoreItem(phrase: string, item: Item): number {
  const p = normalize(phrase);
  if (!p) return 0;
  const pTokens = p.split(' ');
  let best = 0;
  for (const c of candidates(item)) {
    if (p === c) return 1;
    const cTokens = c.split(' ');
    // whole-word containment either way ("amul doodh" in "do amul doodh dena")
    const contains = (hay: string[], needle: string[]) =>
      hay.some((_, i) => needle.every((t, k) => hay[i + k] === t));
    if (contains(pTokens, cTokens)) best = Math.max(best, 0.9 + 0.1 * Math.min(cTokens.length / pTokens.length, 1));
    else if (cTokens.length > 1 && contains(cTokens, pTokens) && p.length >= 4) best = Math.max(best, 0.8);
    // token-level fuzzy: each candidate token vs best phrase token
    const tokenScore = cTokens.reduce((s, ct) => s + Math.max(...pTokens.map((pt) => similarity(pt, ct))), 0) / cTokens.length;
    best = Math.max(best, tokenScore * 0.85, similarity(p, c) * 0.9);
  }
  return Math.min(best, 1);
}

export function bestMatches(phrase: string, items: readonly Item[], limit = 3, min = 0.6): Match[] {
  return items
    .map((item) => ({ item, score: scoreItem(phrase, item) }))
    .filter((m) => m.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

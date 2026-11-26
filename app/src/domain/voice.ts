/**
 * Hinglish voice-billing parser.
 *
 *   "do kilo cheeni aur teen maggi"       -> sugar 2 kg, Maggi ×3
 *   "ढाई किलो आलू, एक अमूल दूध"            -> potato 2.5 kg, milk ×1
 *   "2 kg sugar 250 gram chai patti"      -> sugar 2 kg, tea 0.25
 *   "bhaiya ek parle ji dena"             -> Parle-G ×1
 *
 * Works fully offline. Each line carries a confidence; if any line is weak
 * or words are left unmatched, the app may ask the Bedrock fallback.
 */
import { bestMatches, normalize } from './match';
import type { Item } from './types';

export interface ParsedLine {
  readonly item: Item;
  readonly qtyMilli: number;
  readonly confidence: number;
  readonly heard: string;
}

export interface ParseResult {
  readonly lines: readonly ParsedLine[];
  readonly unmatched: readonly string[];
  readonly confidence: number;
}

const NUMBERS: Record<string, number> = {
  // roman Hindi
  ek: 1, ik: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, pach: 5, chhe: 6, che: 6, chah: 6, chhah: 6,
  saat: 7, sat: 7, aath: 8, ath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, baarah: 12, pandrah: 15, bees: 20,
  pachees: 25, pachas: 50, sau: 100,
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20,
  dozen: 12, darjan: 12,
  // Devanagari
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  'बारह': 12, 'बीस': 20, 'पचास': 50, 'सौ': 100, 'दर्जन': 12,
};
const FRACTIONS: Record<string, number> = {
  aadha: 0.5, adha: 0.5, aadhi: 0.5, half: 0.5, pav: 0.25, paav: 0.25, quarter: 0.25, dedh: 1.5, dhai: 2.5, dhaai: 2.5,
  'आधा': 0.5, 'आधी': 0.5, 'पाव': 0.25, 'डेढ़': 1.5, 'डेढ': 1.5, 'ढाई': 2.5,
};
/** "sawa do" = 2.25, "sadhe teen" = 3.5, "paune do" = 1.75 */
const MODIFIERS: Record<string, number> = { sawa: 0.25, 'सवा': 0.25, sadhe: 0.5, saadhe: 0.5, 'साढ़े': 0.5, 'साढे': 0.5, paune: -0.25, 'पौने': -0.25 };
const UNITS: Record<string, { mult: number; kind: 'weight' | 'count' }> = {
  kilo: { mult: 1, kind: 'weight' }, kg: { mult: 1, kind: 'weight' }, kgs: { mult: 1, kind: 'weight' }, 'किलो': { mult: 1, kind: 'weight' },
  litre: { mult: 1, kind: 'weight' }, liter: { mult: 1, kind: 'weight' }, ltr: { mult: 1, kind: 'weight' }, 'लीटर': { mult: 1, kind: 'weight' },
  gram: { mult: 0.001, kind: 'weight' }, grams: { mult: 0.001, kind: 'weight' }, gm: { mult: 0.001, kind: 'weight' }, g: { mult: 0.001, kind: 'weight' },
  'ग्राम': { mult: 0.001, kind: 'weight' }, ml: { mult: 0.001, kind: 'weight' },
  packet: { mult: 1, kind: 'count' }, packets: { mult: 1, kind: 'count' }, pkt: { mult: 1, kind: 'count' }, pack: { mult: 1, kind: 'count' },
  piece: { mult: 1, kind: 'count' }, pieces: { mult: 1, kind: 'count' }, pcs: { mult: 1, kind: 'count' }, dabba: { mult: 1, kind: 'count' },
  box: { mult: 1, kind: 'count' }, bottle: { mult: 1, kind: 'count' }, 'पैकेट': { mult: 1, kind: 'count' }, 'पीस': { mult: 1, kind: 'count' },
  'डिब्बा': { mult: 1, kind: 'count' },
};
const SEPARATORS = new Set(['aur', 'and', 'plus', 'phir', 'also', 'और', 'तथा', 'फिर']);
const FILLERS = new Set([
  'bhaiya', 'bhai', 'bhaiyya', 'dena', 'dedo', 'de', 'dijiye', 'chahiye', 'lena', 'please', 'pls', 'ji', 'wala', 'wali',
  'ka', 'ki', 'ke', 'a', 'an', 'the', 'of', 'give', 'me', 'add', 'bhi', 'sir', 'madam',
  'भैया', 'भाई', 'देना', 'दीजिए', 'दे', 'चाहिए', 'का', 'की', 'के', 'भी', 'जी', 'वाला',
]);

const DEVANAGARI_DIGITS = '०१२३४५६७८९';
const toAsciiDigits = (s: string) => s.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));

interface Segment { qty: number | null; unitMult: number | null; unitKind: 'weight' | 'count' | null; words: string[] }

function numberValue(tok: string): number | null {
  if (/^\d+(\.\d+)?$/.test(tok)) return Number(tok);
  if (tok in NUMBERS) return NUMBERS[tok];
  if (tok in FRACTIONS) return FRACTIONS[tok];
  return null;
}

function tokenize(text: string): string[] {
  return toAsciiDigits(text.toLowerCase())
    .replace(/(\d)(kg|g|gm|ml|l)\b/g, '$1 $2')
    .replace(/[,;।|]/g, ' aur ')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{M}\p{N}.]/gu, ''))
    .filter(Boolean);
}

function segments(tokens: string[]): Segment[] {
  const out: Segment[] = [];
  let cur: Segment = { qty: null, unitMult: null, unitKind: null, words: [] };
  let pendingMod = 0;
  const flush = () => {
    if (cur.words.length) out.push(cur);
    cur = { qty: null, unitMult: null, unitKind: null, words: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (SEPARATORS.has(t)) { flush(); continue; }
    if (t in MODIFIERS) { pendingMod = MODIFIERS[t]; continue; }
    const n = numberValue(t);
    // "do" at the very end ("ek maggi do") means "give", not 2
    const trailingGive = t === 'do' && i === tokens.length - 1 && cur.words.length > 0;
    if (n !== null && !trailingGive) {
      if (cur.words.length) flush();
      cur.qty = cur.qty === null ? n + pendingMod : cur.qty + n; // "ek dedh" rarely; keep additive
      pendingMod = 0;
      continue;
    }
    if (t in UNITS && cur.words.length === 0) {
      cur.unitMult = UNITS[t].mult;
      cur.unitKind = UNITS[t].kind;
      continue;
    }
    if (FILLERS.has(t) || trailingGive) continue;
    cur.words.push(t);
  }
  flush();
  return out;
}

export function parseUtterance(text: string, items: readonly Item[]): ParseResult {
  const lines: ParsedLine[] = [];
  const unmatched: string[] = [];
  for (const seg of segments(tokenize(text))) {
    const heard = seg.words.join(' ');
    const [best] = bestMatches(heard, items, 1, 0.62);
    if (!best) { unmatched.push(heard); continue; }
    let qty = seg.qty ?? 1;
    if (seg.unitMult !== null) qty *= seg.unitMult;
    // A weight for a packaged (piece) item ("250 gram chai patti", "3 kilo atta" for a 5 kg bag)
    // is ambiguous -> 1 pack, lower confidence so the shopkeeper double-checks.
    let confidence = best.score;
    if (best.item.unit === 'pcs' && seg.unitKind === 'weight') { qty = 1; confidence *= 0.7; }
    const qtyMilli = Math.round(qty * 1000);
    if (qtyMilli <= 0) { unmatched.push(heard); continue; }
    const existing = lines.findIndex((l) => l.item.sku === best.item.sku);
    if (existing >= 0) {
      const e = lines[existing];
      lines[existing] = { ...e, qtyMilli: e.qtyMilli + qtyMilli, confidence: Math.min(e.confidence, confidence) };
    } else {
      lines.push({ item: best.item, qtyMilli, confidence, heard });
    }
  }
  const confidence = lines.length ? Math.min(...lines.map((l) => l.confidence)) * (unmatched.length ? 0.6 : 1) : 0;
  return { lines, unmatched, confidence };
}

/** Should the app ask the cloud (Bedrock) for a second opinion? */
export const needsCloudHelp = (r: ParseResult) => r.lines.length === 0 || r.confidence < 0.75 || r.unmatched.length > 0;

export { normalize };

/** IST day keys + Indian festival calendar (same ramp as ml/sros_ml/catalog.py). */
import { FESTIVALS } from '../domain/catalog';

export const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3600_000;

export const dayKey = (ts: number): string => new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);
export const keyToTs = (key: string): number => Date.parse(`${key}T00:00:00Z`) - IST_OFFSET_MS;
export const addDays = (key: string, n: number): string => dayKey(keyToTs(key) + n * DAY_MS + 12 * 3600_000);
export const dayOfWeek = (key: string): number => (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0

let cache: Map<string, number> | null = null;

function intensityMap(): Map<string, number> {
  if (cache) return cache;
  const m = new Map<string, number>();
  for (const f of FESTIVALS) {
    for (const d of f.dates) {
      for (let off = -f.windowBefore; off <= f.windowAfter; off++) {
        const ramp = off === 0 ? 1 : off < 0 ? 0.4 + (0.6 * (f.windowBefore + off)) / Math.max(f.windowBefore, 1) : 0.6;
        const k = addDays(d, off);
        m.set(k, Math.max(m.get(k) ?? 0, f.intensity * ramp));
      }
    }
  }
  cache = m;
  return m;
}

export const festivalIntensity = (key: string): number => intensityMap().get(key) ?? 0;

export interface UpcomingFestival {
  readonly name: string;
  readonly date: string;
  readonly daysAway: number;
}

export function upcomingFestival(todayKey: string, withinDays = 30): UpcomingFestival | null {
  const today = keyToTs(todayKey);
  let best: UpcomingFestival | null = null;
  for (const f of FESTIVALS) {
    for (const d of f.dates) {
      const days = Math.round((keyToTs(d) - today) / DAY_MS);
      if (days >= 0 && days <= withinDays && (!best || days < best.daysAway)) best = { name: f.name, date: d, daysAway: days };
    }
  }
  return best;
}

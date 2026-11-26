/**
 * Festival-adjusted Holt-Winters (additive, weekly season) — the on-device
 * forecaster used offline and before the cloud model has run.
 *
 * Idea: divide history by the known festival multiplier so spikes do not
 * corrupt level/season, fit Holt-Winters on the adjusted series, then
 * re-apply the multiplier for future festival days.
 */
import { addDays, dayOfWeek, festivalIntensity } from './calendar';

export interface ForecastResult {
  readonly forecast: number[];
  readonly sigma: number;
  readonly method: 'holt-winters+festivals' | 'average';
  /** 1 - WAPE on a 14-day backtest (null when history is too short). */
  readonly accuracy: number | null;
  readonly baselineAccuracy: number | null;
}

const ALPHA = 0.3, BETA = 0.02, GAMMA = 0.15, SEASON = 7;

export const festivalMultiplier = (key: string, lift: number) => 1 + (lift - 1) * festivalIntensity(key);

interface Fit { level: number; trend: number; season: number[]; residuals: number[] }

function fit(z: number[], startDow: number): Fit {
  const first = z.slice(0, SEASON);
  let level = first.reduce((a, b) => a + b, 0) / first.length;
  let trend = 0;
  const season = new Array(SEASON).fill(0);
  const weeks = Math.max(1, Math.floor(Math.min(z.length, 28) / SEASON));
  for (let i = 0; i < weeks * SEASON; i++) season[(startDow + i) % SEASON] += (z[i] - level) / weeks;
  const residuals: number[] = [];
  for (let t = 0; t < z.length; t++) {
    const s = (startDow + t) % SEASON;
    const pred = level + trend + season[s];
    residuals.push(z[t] - pred);
    const prevLevel = level;
    level = ALPHA * (z[t] - season[s]) + (1 - ALPHA) * (level + trend);
    trend = BETA * (level - prevLevel) + (1 - BETA) * trend;
    season[s] = GAMMA * (z[t] - level) + (1 - GAMMA) * season[s];
  }
  return { level, trend, season, residuals };
}

function project(f: Fit, lastKey: string, horizon: number, lift: number, startDow: number, n: number): number[] {
  const out: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const key = addDays(lastKey, h);
    const base = f.level + h * f.trend + f.season[(startDow + n - 1 + h) % SEASON];
    out.push(Math.max(0, base * festivalMultiplier(key, lift)));
  }
  return out;
}

function wape(actual: number[], pred: number[]): number {
  const denom = actual.reduce((a, b) => a + Math.abs(b), 0);
  return denom ? actual.reduce((s, a, i) => s + Math.abs(a - pred[i]), 0) / denom : 1;
}

/** `history[i]` = units sold on day `firstKey + i`. */
export function forecastSeries(history: readonly number[], firstKey: string, lift: number, horizon = 14): ForecastResult {
  const n = history.length;
  const lastKey = addDays(firstKey, n - 1);
  if (n < 14) {
    const mean = n ? history.reduce((a, b) => a + b, 0) / n : 0;
    const fc = Array.from({ length: horizon }, (_, h) => mean * festivalMultiplier(addDays(lastKey, h + 1), lift));
    const sd = n ? Math.sqrt(history.reduce((s, v) => s + (v - mean) ** 2, 0) / n) : 0;
    return { forecast: fc, sigma: sd, method: 'average', accuracy: null, baselineAccuracy: null };
  }
  const startDow = dayOfWeek(firstKey);
  const mult = history.map((_, i) => festivalMultiplier(addDays(firstKey, i), lift));
  const z = history.map((v, i) => v / mult[i]);
  const full = fit(z, startDow);
  const tail = full.residuals.slice(-56).map((r, i, arr) => r * mult[n - arr.length + i]);
  const sigma = Math.sqrt(tail.reduce((s, r) => s + r * r, 0) / Math.max(tail.length, 1));

  let accuracy: number | null = null;
  let baselineAccuracy: number | null = null;
  if (n >= 42) {
    const train = z.slice(0, n - 14);
    const bt = project(fit(train, startDow), addDays(firstKey, n - 15), 14, lift, startDow, train.length);
    const actual = history.slice(-14);
    accuracy = Math.max(0, 1 - wape(actual, bt));
    baselineAccuracy = Math.max(0, 1 - wape(actual, history.slice(-21, -7)));
  }
  return {
    forecast: project(full, lastKey, horizon, lift, startDow, n), sigma, method: 'holt-winters+festivals',
    accuracy, baselineAccuracy,
  };
}

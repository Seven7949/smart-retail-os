/** Compose all on-device insights from the shop's data (pure function). */
import type { Bill, Customer, Item, UdhaarTxn } from '../domain/types';
import { associationRules, type Rule } from './apriori';
import { addDays, DAY_MS, dayKey, festivalIntensity, upcomingFestival, type UpcomingFestival } from './calendar';
import { forecastSeries, type ForecastResult } from './forecast';
import { bestKMeans, standardize } from './kmeans';
import { suggestReorder, type ReorderSuggestion } from './reorder';
import { riskFeatures, scoreRisk, type RiskBand } from './udhaarRisk';

export const HISTORY_DAYS = 120;
export const HORIZON = 14;

export interface ItemForecast extends ForecastResult {
  readonly sku: string;
  readonly history: number[]; // last 28 days
  readonly firstFutureKey: string;
}

export type SegmentName = 'Champions' | 'Regulars' | 'Occasional' | 'At risk' | 'New';

export interface Insights {
  readonly generatedAt: number;
  readonly todayKey: string;
  readonly forecasts: Record<string, ItemForecast>;
  readonly reorder: (ReorderSuggestion & { name: string })[];
  readonly rules: Rule[];
  readonly segments: Record<string, SegmentName>;
  readonly segmentCounts: Partial<Record<SegmentName, number>>;
  readonly udhaar: { customerId: string; risk: number; band: RiskBand; drivers: string[]; outstandingPaise: number }[];
  readonly festival: (UpcomingFestival & { stockUp: string[] }) | null;
  readonly salesByDay: { key: string; paise: number }[];
  readonly forecastSalesPaise: number[];
}

export function dailyUnits(bills: readonly Bill[], todayKey: string, days = HISTORY_DAYS): { firstKey: string; bySku: Map<string, number[]>; sales: number[] } {
  const firstKey = addDays(todayKey, -days);
  const index = new Map<string, number>();
  for (let i = 0; i < days; i++) index.set(addDays(firstKey, i), i);
  const bySku = new Map<string, number[]>();
  const sales = new Array(days).fill(0);
  for (const b of bills) {
    const i = index.get(dayKey(b.createdAt));
    if (i === undefined) continue;
    sales[i] += b.totalPaise;
    for (const l of b.items) {
      if (!bySku.has(l.sku)) bySku.set(l.sku, new Array(days).fill(0));
      bySku.get(l.sku)![i] += l.qtyMilli / 1000;
    }
  }
  return { firstKey, bySku, sales };
}

function segmentCustomers(bills: readonly Bill[], now: number): Record<string, SegmentName> {
  const per = new Map<string, { last: number; n: number; value: number }>();
  for (const b of bills) {
    if (!b.customerId) continue;
    const p = per.get(b.customerId) ?? { last: 0, n: 0, value: 0 };
    p.last = Math.max(p.last, b.createdAt);
    p.n++;
    p.value += b.totalPaise;
    per.set(b.customerId, p);
  }
  const ids = [...per.keys()].sort();
  const out: Record<string, SegmentName> = {};
  if (ids.length < 8) {
    ids.forEach((id) => (out[id] = 'New'));
    return out;
  }
  const raw = ids.map((id) => {
    const p = per.get(id)!;
    return [(now - p.last) / DAY_MS, p.n, p.value / 100];
  });
  const { labels, k } = bestKMeans(standardize(raw.map((r) => r.map((v) => Math.log1p(v)))), 2, 5, 7);
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const prof = Array.from({ length: k }, (_, c) => {
    const m = raw.filter((_, i) => labels[i] === c);
    return { r: med(m.map((x) => x[0])), f: med(m.map((x) => x[1])), v: med(m.map((x) => x[2])) };
  });
  const maxR = Math.max(...prof.map((p) => p.r)), maxV = Math.max(...prof.map((p) => p.v)), maxF = Math.max(...prof.map((p) => p.f));
  const names = prof.map((p): SegmentName => (p.r === maxR && p.r > 21 ? 'At risk' : p.v === maxV ? 'Champions' : p.f === maxF ? 'Regulars' : 'Occasional'));
  ids.forEach((id, i) => (out[id] = names[labels[i]]));
  return out;
}

export function computeInsights(
  bills: readonly Bill[], items: readonly Item[], customers: readonly Customer[], udhaar: readonly UdhaarTxn[], now: number,
): Insights {
  const todayKey = dayKey(now);
  const { firstKey, bySku, sales } = dailyUnits(bills, todayKey);
  const forecasts: Record<string, ItemForecast> = {};
  const reorder: Insights['reorder'] = [];
  const forecastSalesPaise = new Array(HORIZON).fill(0);
  for (const item of items) {
    const series = bySku.get(item.sku) ?? new Array(HISTORY_DAYS).fill(0);
    const f = forecastSeries(series, firstKey, item.festivalLift, HORIZON);
    forecasts[item.sku] = { ...f, sku: item.sku, history: series.slice(-28), firstFutureKey: todayKey };
    f.forecast.forEach((u, h) => (forecastSalesPaise[h] += u * item.pricePaise));
    const festive = item.festivalLift >= 1.5 &&
      Array.from({ length: item.leadTimeDays + 7 }, (_, h) => festivalIntensity(addDays(todayKey, h + 1))).some((v) => v > 0.3);
    const s = suggestReorder(item, f.forecast, f.sigma, festive);
    if (s.reorder) reorder.push({ ...s, name: item.name });
  }
  reorder.sort((a, b) => a.daysOfCover - b.daysOfCover);

  const recent = bills.filter((b) => now - b.createdAt <= 90 * DAY_MS).map((b) => b.items.map((l) => l.sku));
  const rules = associationRules(recent, Math.max(0.01, 5 / Math.max(recent.length, 1)));

  const segments = segmentCustomers(bills.filter((b) => now - b.createdAt <= 180 * DAY_MS), now);
  const segmentCounts: Insights['segmentCounts'] = {};
  Object.values(segments).forEach((s) => (segmentCounts[s] = (segmentCounts[s] ?? 0) + 1));

  const byCust = new Map<string, UdhaarTxn[]>();
  udhaar.forEach((t) => byCust.set(t.customerId, [...(byCust.get(t.customerId) ?? []), t]));
  const custMap = new Map(customers.map((c) => [c.customerId, c]));
  const risk = [...byCust].map(([id, ts]) => {
    const f = riskFeatures(custMap.get(id), ts, now);
    return { customerId: id, ...scoreRisk(f), outstandingPaise: f.outstanding_paise };
  }).filter((r) => r.outstandingPaise > 0).sort((a, b) => b.risk - a.risk);

  const fest = upcomingFestival(todayKey, 21);
  const festival = fest ? {
    ...fest,
    stockUp: [...items].filter((i) => i.festivalLift >= 2).sort((a, b) => b.festivalLift - a.festivalLift).slice(0, 5).map((i) => i.sku),
  } : null;

  return {
    generatedAt: now, todayKey, forecasts, reorder, rules, segments, segmentCounts, udhaar: risk, festival,
    salesByDay: sales.map((paise, i) => ({ key: addDays(firstKey, i), paise })), forecastSalesPaise,
  };
}

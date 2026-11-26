/** Forecast-driven (s,S) reorder decision with a newsvendor service level for
 * perishables — a port of ml/sros_ml/replenishment.py (see ML report §2). */
import type { Item } from '../domain/types';

export const Z_SERVICE = 1.65;
export const STOCKOUT_GOODWILL = 1.0;
export const PERISHABLE_DAYS = 7;

/** Inverse standard normal CDF (Acklam's rational approximation, |err| < 1e-9). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p must be in (0,1)');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function serviceZ(item: Pick<Item, 'shelfLifeDays' | 'pricePaise' | 'costPaise'>): number {
  if (item.shelfLifeDays > PERISHABLE_DAYS) return Z_SERVICE;
  const cu = (item.pricePaise - item.costPaise) * (1 + STOCKOUT_GOODWILL);
  const ratio = cu / (cu + item.costPaise);
  return Math.min(Z_SERVICE, Math.max(-1, normInv(Math.min(Math.max(ratio, 0.001), 0.999))));
}

export const roundToPack = (units: number, pack: number) => (units > 0 ? Math.ceil(units / pack) * pack : 0);

export interface ReorderSuggestion {
  readonly sku: string;
  readonly orderUnits: number;
  readonly packs: number;
  readonly daysOfCover: number;
  readonly reorder: boolean;
  readonly reason: 'festival' | 'low-stock' | 'ok';
}

/** `forecast[0]` = expected demand tomorrow. Stock is in units (milli / 1000). */
export function suggestReorder(item: Item, forecast: readonly number[], sigma: number, festive = false): ReorderSuggestion {
  const onHand = item.stockMilli / 1000;
  const L = Math.max(item.leadTimeDays, 1);
  const cover = Math.max(1, Math.min(7, item.shelfLifeDays));
  const z = serviceZ(item);
  const sum = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += forecast[Math.min(i, forecast.length - 1)] ?? 0;
    return s;
  };
  const weekly = sum(7) / 7;
  const daysOfCover = Math.round((onHand / Math.max(weekly, 1e-6)) * 10) / 10;
  const s = sum(L) + z * sigma * Math.sqrt(L);
  if (onHand >= s) return { sku: item.sku, orderUnits: 0, packs: 0, daysOfCover, reorder: false, reason: 'ok' };
  const horizon = L - 1 + cover;
  const S = sum(horizon) + z * sigma * Math.sqrt(horizon);
  const pack = Math.max(1, item.packSize);
  const orderUnits = roundToPack(S - onHand, pack);
  return {
    sku: item.sku, orderUnits, packs: orderUnits / pack, daysOfCover, reorder: orderUnits > 0,
    reason: orderUnits > 0 ? (festive ? 'festival' : 'low-stock') : 'ok',
  };
}

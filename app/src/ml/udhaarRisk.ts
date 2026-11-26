/** Udhaar (credit) risk on the phone: same features as
 * ml/sros_ml/udhaar_features.py, scored with the exported logistic model. */
import model from '../spec/udhaar_model.json';
import type { Customer, UdhaarTxn } from '../domain/types';
import { DAY_MS } from './calendar';

const LATE_AFTER_DAYS = 30;

export interface RiskFeatures {
  tenure_days: number;
  utilisation: number;
  days_since_payment: number;
  avg_days_to_repay: number;
  late_payments: number;
  pay_ratio_90d: number;
  reminders_ignored: number;
  outstanding_paise: number;
}

export function riskFeatures(customer: Customer | undefined, txns: readonly UdhaarTxn[], now: number): RiskFeatures {
  const sorted = [...txns].sort((a, b) => a.ts - b.ts);
  const credits = sorted.filter((t) => t.kind === 'credit');
  const payments = sorted.filter((t) => t.kind === 'payment');
  const sum = (xs: readonly UdhaarTxn[]) => xs.reduce((s, t) => s + t.amountPaise, 0);
  const outstanding = Math.max(sum(credits) - sum(payments), 0);
  const avgCredit = credits.length ? sum(credits) / credits.length : 0;
  const limit = customer?.creditLimitPaise || Math.max(avgCredit * 6, 50_000);
  const first = sorted.length ? sorted[0].ts : now;
  const lastPay = payments.length ? payments[payments.length - 1].ts : first;

  const queue = credits.map((c) => ({ ts: c.ts, left: c.amountPaise }));
  const delays: number[] = [];
  let late = 0;
  let qi = 0;
  for (const p of payments) {
    let remaining = p.amountPaise;
    while (remaining > 0 && qi < queue.length) {
      const take = Math.min(remaining, queue[qi].left);
      queue[qi].left -= take;
      remaining -= take;
      if (queue[qi].left === 0) {
        const d = (p.ts - queue[qi].ts) / DAY_MS;
        delays.push(d);
        if (d > LATE_AFTER_DAYS) late++;
        qi++;
      }
    }
  }
  late += queue.slice(qi).filter((c) => c.left > 0 && (now - c.ts) / DAY_MS > LATE_AFTER_DAYS).length;
  const since = now - 90 * DAY_MS;
  const c90 = sum(credits.filter((t) => t.ts >= since));
  const p90 = sum(payments.filter((t) => t.ts >= since));
  return {
    tenure_days: (now - first) / DAY_MS,
    utilisation: limit ? outstanding / limit : 0,
    days_since_payment: (now - lastPay) / DAY_MS,
    avg_days_to_repay: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : (now - first) / DAY_MS,
    late_payments: late,
    pay_ratio_90d: c90 ? p90 / c90 : 1,
    reminders_ignored: customer?.remindersSent ?? 0,
    outstanding_paise: outstanding,
  };
}

export type RiskBand = 'low' | 'medium' | 'high';

export function scoreRisk(f: RiskFeatures): { risk: number; band: RiskBand; drivers: string[] } {
  let z = model.intercept;
  const contributions: [string, number][] = [];
  model.features.forEach((name, i) => {
    const c = (model.coef[i] * ((f as unknown as Record<string, number>)[name] - model.mean[i])) / model.scale[i];
    contributions.push([name, c]);
    z += c;
  });
  const risk = 1 / (1 + Math.exp(-z));
  const band: RiskBand = risk >= model.bands.high ? 'high' : risk >= model.bands.low ? 'medium' : 'low';
  const drivers = contributions.filter(([, c]) => c > 0.15).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
  return { risk, band, drivers };
}

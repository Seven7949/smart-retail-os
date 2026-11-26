import { generateDemoShop } from '../../domain/demo';
import { verifyChain, buildChain } from '../../domain/ledger';
import { associationRules, frequentItemsets } from '../apriori';
import { addDays, dayKey, dayOfWeek, festivalIntensity, keyToTs, upcomingFestival } from '../calendar';
import { forecastSeries } from '../forecast';
import { computeInsights, dailyUnits } from '../insights';
import { bestKMeans, kmeans, mulberry32, silhouette, standardize } from '../kmeans';
import { normInv, roundToPack, serviceZ, suggestReorder } from '../reorder';
import { riskFeatures, scoreRisk } from '../udhaarRisk';
import type { Item } from '../../domain/types';

const NOW = Date.parse('2026-11-01T12:00:00+05:30'); // one week before Diwali 2026
const DAY = 86_400_000;

describe('calendar', () => {
  test('IST day keys and arithmetic', () => {
    expect(dayKey(Date.parse('2026-11-08T23:30:00+05:30'))).toBe('2026-11-08');
    expect(dayKey(Date.parse('2026-11-08T00:10:00+05:30'))).toBe('2026-11-08');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(dayKey(keyToTs('2026-03-04'))).toBe('2026-03-04');
    expect(dayOfWeek('2026-11-09')).toBe(0); // Monday
  });

  test('festival intensity matches the python calendar', () => {
    expect(festivalIntensity('2026-11-08')).toBeCloseTo(1.0);
    expect(festivalIntensity('2026-11-01')).toBeCloseTo(0.4);
    expect(festivalIntensity('2026-11-09')).toBeCloseTo(0.6);
    expect(festivalIntensity('2026-11-20')).toBe(0);
    expect(upcomingFestival('2026-11-01')).toEqual({ name: 'Diwali', date: '2026-11-08', daysAway: 7 });
    expect(upcomingFestival('2026-11-20', 10)).toBeNull();
  });
});

describe('forecast', () => {
  test('learns weekly seasonality and beats the naive baseline', () => {
    const rand = mulberry32(3);
    const pattern = [10, 9, 10, 11, 13, 18, 16];
    const first = '2026-05-04'; // Monday
    const hist = Array.from({ length: 98 }, (_, i) => pattern[i % 7] + (rand() - 0.5) * 3);
    const f = forecastSeries(hist, first, 1.0);
    expect(f.method).toBe('holt-winters+festivals');
    expect(f.forecast).toHaveLength(14);
    // 98 days from a Monday -> next day is Monday again; Saturday should be the peak
    expect(f.forecast[5]).toBeGreaterThan(f.forecast[1]);
    expect(f.accuracy!).toBeGreaterThan(0.85);
    expect(f.sigma).toBeGreaterThan(0);
  });

  test('re-applies festival uplift for future festival days', () => {
    const hist = new Array(60).fill(5);
    const plain = forecastSeries(hist, '2026-09-01', 1.0, 14);
    const festive = forecastSeries(hist, '2026-09-01', 9.0, 14); // forecast covers Oct 31 – Nov 13 incl. Diwali
    const diwaliIdx = 7; // Nov 8
    expect(festive.forecast[diwaliIdx]).toBeGreaterThan(plain.forecast[diwaliIdx] * 5);
  });

  test('short history falls back to the average', () => {
    const f = forecastSeries([4, 6], '2026-06-01', 1);
    expect(f.method).toBe('average');
    expect(f.forecast[0]).toBeCloseTo(5);
    expect(forecastSeries([], '2026-06-01', 1).forecast[0]).toBe(0);
  });
});

describe('reorder', () => {
  const milk: Item = { sku: 'milk', name: 'Milk', category: 'dairy', unit: 'pcs', pricePaise: 2900, costPaise: 2700,
    stockMilli: 5000, leadTimeDays: 1, packSize: 12, shelfLifeDays: 2, festivalLift: 1 };
  const sugar: Item = { ...milk, sku: 'sugar', shelfLifeDays: 365, leadTimeDays: 3, packSize: 25, pricePaise: 4800, costPaise: 4300 };

  test('normInv', () => {
    expect(normInv(0.5)).toBeCloseTo(0, 6);
    expect(normInv(0.95)).toBeCloseTo(1.6449, 3);
    expect(normInv(0.01)).toBeCloseTo(-2.3263, 3);
    expect(normInv(0.99)).toBeCloseTo(2.3263, 3);
    expect(() => normInv(1)).toThrow();
  });

  test('newsvendor runs perishables lean, durables safe', () => {
    expect(serviceZ(milk)).toBeLessThan(0);
    expect(serviceZ(sugar)).toBe(1.65);
    expect(roundToPack(13, 12)).toBe(24);
    expect(roundToPack(0, 12)).toBe(0);
  });

  test('orders in packs only when below the reorder point', () => {
    const low = suggestReorder(milk, new Array(14).fill(30), 5);
    expect(low.reorder).toBe(true);
    expect(low.orderUnits % 12).toBe(0);
    expect(low.packs).toBe(low.orderUnits / 12);
    const plenty = suggestReorder({ ...sugar, stockMilli: 500_000 }, new Array(14).fill(10), 3);
    expect(plenty).toMatchObject({ reorder: false, reason: 'ok', daysOfCover: 50 });
    expect(suggestReorder({ ...sugar, stockMilli: 0 }, new Array(14).fill(10), 3, true).reason).toBe('festival');
  });
});

describe('apriori', () => {
  const tx = [
    ...Array(30).fill(['bread', 'butter', 'milk']),
    ...Array(20).fill(['tea', 'sugar']),
    ...Array(50).fill(['salt']),
    ...Array(10).fill(['bread']),
  ];

  test('frequent itemsets with pruning', () => {
    const f = frequentItemsets(tx, 0.1);
    expect(f.get('bread|butter|milk')).toBe(30);
    expect(f.get('bread')).toBe(40);
    expect(f.has('salt|tea')).toBe(false);
  });

  test('rules have correct confidence and lift', () => {
    const rules = associationRules(tx, 0.1, 0.5, 1.2);
    const r = rules.find((x) => x.if.join() === 'butter' && x.then.join() === 'bread,milk')!;
    expect(r.confidence).toBeCloseTo(1);
    expect(r.lift).toBeCloseTo(1 / (30 / 110));
    expect(rules.every((x) => x.lift >= 1.2)).toBe(true);
    expect(associationRules([])).toEqual([]);
  });
});

describe('kmeans', () => {
  test('separates obvious clusters', () => {
    const rand = mulberry32(1);
    const pts = [...Array(30)].map((_, i) => (i < 15 ? [rand(), rand()] : [10 + rand(), 10 + rand()]));
    const labels = kmeans(pts, 2);
    expect(new Set(labels.slice(0, 15)).size).toBe(1);
    expect(labels[0]).not.toBe(labels[20]);
    expect(silhouette(pts, labels)).toBeGreaterThan(0.8);
    expect(bestKMeans(standardize(pts)).k).toBe(2);
    expect(silhouette(pts, new Array(30).fill(0))).toBe(-1);
  });
});

describe('udhaar risk (same numbers as Python)', () => {
  const C = 'c';
  const good = [
    { id: '1', customerId: C, kind: 'credit' as const, amountPaise: 50_000, ts: NOW - 40 * DAY },
    { id: '2', customerId: C, kind: 'payment' as const, amountPaise: 50_000, ts: NOW - 35 * DAY },
    { id: '3', customerId: C, kind: 'credit' as const, amountPaise: 20_000, ts: NOW - 3 * DAY },
  ];
  const bad = [
    { id: '4', customerId: C, kind: 'credit' as const, amountPaise: 90_000, ts: NOW - 120 * DAY },
    { id: '5', customerId: C, kind: 'credit' as const, amountPaise: 60_000, ts: NOW - 70 * DAY },
    { id: '6', customerId: C, kind: 'payment' as const, amountPaise: 5_000, ts: NOW - 100 * DAY },
  ];

  test('features mirror ml/tests/test_batch.py::test_udhaar_features_fifo', () => {
    const f = riskFeatures(undefined, good, NOW);
    expect(f.outstanding_paise).toBe(20_000);
    expect(f.avg_days_to_repay).toBeCloseTo(5);
    expect(f.late_payments).toBe(0);
    const b = riskFeatures({ customerId: C, name: 'x', remindersSent: 4 }, bad, NOW);
    expect(b.late_payments).toBeGreaterThanOrEqual(1);
    expect(b.days_since_payment).toBeCloseTo(100);
  });

  test('risky behaviour scores higher', () => {
    const g = scoreRisk(riskFeatures(undefined, good, NOW));
    const b = scoreRisk(riskFeatures(undefined, bad, NOW));
    expect(b.risk).toBeGreaterThan(g.risk);
    expect(b.band).toBe('high');
    expect(b.drivers.length).toBeGreaterThan(0);
    expect(b.drivers.every((d) => ['days_since_payment', 'pay_ratio_90d', 'utilisation', 'avg_days_to_repay', 'late_payments', 'tenure_days', 'reminders_ignored'].includes(d))).toBe(true);
  });
});

describe('demo shop + full insights', () => {
  const shop = generateDemoShop(NOW);

  test('demo data is deterministic, realistic and ledger-valid', () => {
    const again = generateDemoShop(NOW);
    expect(again.bills.length).toBe(shop.bills.length);
    expect(shop.bills.length).toBeGreaterThan(2500);
    expect(shop.bills.every((b) => b.createdAt <= NOW)).toBe(true);
    expect(shop.udhaar.some((u) => u.kind === 'payment')).toBe(true);
    const chain = buildChain('local', shop.bills.slice(0, 300));
    expect(verifyChain('local', chain).valid).toBe(true);
  });

  test('insights cover all features', () => {
    const t0 = Date.now();
    const ins = computeInsights(shop.bills, shop.items, shop.customers, shop.udhaar, NOW);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(Object.keys(ins.forecasts)).toHaveLength(shop.items.length);
    expect(ins.reorder.length).toBeGreaterThan(0);
    expect(ins.rules.length).toBeGreaterThan(3);
    expect(ins.rules[0].lift).toBeGreaterThan(1.2);
    expect(Object.keys(ins.segmentCounts).length).toBeGreaterThanOrEqual(2);
    expect(ins.udhaar.length).toBeGreaterThan(0);
    expect(ins.festival?.name).toBe('Diwali');
    expect(ins.festival?.stockUp).toContain('colour-holi'); // highest lift items first
    expect(ins.salesByDay).toHaveLength(120);
    expect(ins.forecastSalesPaise[6]).toBeGreaterThan(ins.forecastSalesPaise[0] * 0.5);
    // festive item forecast rises towards Diwali
    const diya = ins.forecasts['diya-12'];
    expect(diya.forecast[6]).toBeGreaterThan(diya.forecast[0]);
  });

  test('dailyUnits ignores bills outside the window', () => {
    const { sales } = dailyUnits([{ billId: 'x', createdAt: NOW - 400 * DAY, customerId: null, items: [], paymentMode: 'cash', totalPaise: 5 }], dayKey(NOW));
    expect(sales.every((s) => s === 0)).toBe(true);
  });
});

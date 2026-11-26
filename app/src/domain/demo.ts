/**
 * Deterministic demo shop ("Sharma General Store"): 90 days of realistic
 * kirana activity so every insight is visible on first launch, offline.
 * Mirrors the planted structure of ml/sros_ml/synth.py (festivals, weekday
 * rhythm, paydays, basket templates, customer personas, udhaar behaviour).
 */
import { mulberry32 } from '../ml/kmeans';
import { addDays, dayKey, dayOfWeek, festivalIntensity, keyToTs } from '../ml/calendar';
import { lineTotal } from './billing';
import { BASKETS, CATALOG } from './catalog';
import type { Bill, BillLine, Customer, Item, PaymentMode, UdhaarTxn } from './types';

const NAMES = [
  'Ramesh Kumar', 'Sunita Devi', 'Anil Sharma', 'Priya Patel', 'Mohammed Irfan', 'Lakshmi Iyer', 'Suresh Yadav',
  'Kavita Joshi', 'Rajesh Gupta', 'Fatima Begum', 'Vikram Singh', 'Meena Kumari', 'Arjun Reddy', 'Pooja Verma',
  'Harish Nair', 'Geeta Rani', 'Deepak Mehta', 'Anjali Das', 'Sanjay Mishra', 'Rekha Pillai', 'Imran Khan',
  'Neha Agarwal', 'Gopal Krishnan', 'Shabana Shaikh', 'Manoj Tiwari', 'Asha Bhat', 'Ravi Shankar', 'Seema Jain',
  'Karan Malhotra', 'Usha Menon', 'Prakash Rao', 'Nisha Chauhan', 'Ajay Pandey', 'Farah Siddiqui', 'Mahesh Babu',
  'Divya Kulkarni', 'Rohit Saxena', 'Sarita Thakur', 'Naveen Kumar', 'Jyoti Rawat', 'Ashok Bansal', 'Ritu Kapoor',
  'Ganesh Patil', 'Zainab Ali', 'Tarun Bose', 'Kamla Devi', 'Vinod Chawla', 'Shweta Sinha',
];

type Persona = 'daily' | 'bulk' | 'occasional' | 'lapsed';
const PERSONAS: [Persona, number, number][] = [ // persona, share, visits/week
  ['daily', 0.35, 5], ['bulk', 0.15, 0.4], ['occasional', 0.35, 0.9], ['lapsed', 0.15, 3],
];

export interface DemoShop {
  readonly items: Item[];
  readonly customers: Customer[];
  readonly bills: Bill[];
  readonly udhaar: UdhaarTxn[];
}

function poisson(lambda: number, rand: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L && k < 500);
  return k - 1;
}

const DOW = [0.95, 0.92, 0.95, 0.98, 1.05, 1.18, 1.12];

export function generateDemoShop(now: number, days = 90, seed = 2026): DemoShop {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const items: Item[] = CATALOG.map((c) => {
    const daysOfStock = c.festivalLift > 5 ? 2 : 1.5 + rand() * 9;
    const { baseDaily: _b, season: _s, ...rest } = c;
    return { ...rest, stockMilli: Math.round(c.baseDaily * daysOfStock) * 1000 };
  });
  const byS = new Map(items.map((i) => [i.sku, i]));
  const weights = CATALOG.map((c) => c.baseDaily);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const popular = () => {
    let r = rand() * totalW;
    for (let i = 0; i < CATALOG.length; i++) { r -= weights[i]; if (r <= 0) return CATALOG[i].sku; }
    return CATALOG[0].sku;
  };

  const customers: (Customer & { persona: Persona; reliability: number })[] = NAMES.map((name, i) => {
    let r = rand(), persona: Persona = 'daily';
    for (const [p, share] of PERSONAS) { if (r < share) { persona = p; break; } r -= share; }
    const reliability = i % 4 === 0 ? 0.2 + rand() * 0.3 : 0.7 + rand() * 0.3;
    return {
      customerId: `c_${(i + 1).toString().padStart(3, '0')}`, name, persona, reliability,
      phone: `+9198${(10000000 + Math.floor(rand() * 89999999)).toString()}`,
      creditLimitPaise: i % 3 === 0 ? 300000 : undefined, remindersSent: reliability < 0.5 ? Math.floor(rand() * 4) : 0,
    };
  });
  const credit = new Set(customers.filter((_, i) => i % 3 === 0).map((c) => c.customerId));

  const todayKey = dayKey(now);
  const bills: Bill[] = [];
  const udhaar: UdhaarTxn[] = [];
  let n = 0;
  for (let d = days; d >= 0; d--) {
    const key = addDays(todayKey, -d);
    const fest = festivalIntensity(key);
    const dayStart = keyToTs(key);
    const visitors: (string | null)[] = [];
    for (const c of customers) {
      const visitsPerWeek = PERSONAS.find((p) => p[0] === c.persona)![2];
      if (c.persona === 'lapsed' && d < 40) continue;
      if (rand() < (visitsPerWeek / 7) * (1 + fest * 0.5)) visitors.push(c.customerId);
    }
    const walkIns = poisson(26 * DOW[dayOfWeek(key)] * (1 + fest * 0.8), rand);
    for (let w = 0; w < walkIns; w++) visitors.push(null);
    for (const customerId of visitors) {
      const lines = new Map<string, number>();
      const persona = customers.find((c) => c.customerId === customerId)?.persona;
      if (rand() < 0.75) {
        const t = fest > 0.4 && rand() < 0.45 ? BASKETS.find((b) => b.name === 'festive-sweets')! : pick(BASKETS);
        for (const s of t.skus) if (rand() < 0.7) lines.set(s, 1);
      }
      const extra = persona === 'bulk' ? 6 : Math.floor(rand() * 2.2);
      for (let e = 0; e < extra; e++) lines.set(popular(), 1);
      if (!lines.size) lines.set(popular(), 1);
      const billLines: BillLine[] = [...lines.keys()].sort().map((sku) => {
        const it = byS.get(sku)!;
        const qty = it.unit === 'pcs' ? 1 + Math.floor(rand() * (persona === 'bulk' ? 4 : 2.4)) : pick([0.5, 1, 1, 2]);
        return { sku, qtyMilli: Math.round(qty * 1000), unitPricePaise: it.pricePaise };
      });
      const canCredit = customerId !== null && credit.has(customerId);
      const r = rand();
      const mode: PaymentMode = canCredit && r < 0.35 ? 'udhaar' : r < 0.6 ? 'cash' : 'upi';
      const createdAt = dayStart + (8 + rand() * 13) * 3600_000;
      if (createdAt > now) continue;
      n++;
      const bill: Bill = {
        billId: `b_demo_${n.toString().padStart(5, '0')}`, createdAt: Math.floor(createdAt), customerId,
        items: billLines, paymentMode: mode, totalPaise: billLines.reduce((s, l) => s + lineTotal(l), 0),
      };
      bills.push(bill);
      if (mode === 'udhaar' && customerId) {
        udhaar.push({ id: `u_${n}`, customerId, kind: 'credit', amountPaise: bill.totalPaise, ts: bill.createdAt, billId: bill.billId });
        const c = customers.find((x) => x.customerId === customerId)!;
        if (rand() < c.reliability) {
          const payTs = bill.createdAt + (2 + rand() * (c.reliability > 0.6 ? 8 : 40)) * 86_400_000;
          if (payTs < now) udhaar.push({ id: `p_${n}`, customerId, kind: 'payment', amountPaise: bill.totalPaise, ts: Math.floor(payTs) });
        }
      }
    }
  }
  bills.sort((a, b) => a.createdAt - b.createdAt);
  udhaar.sort((a, b) => a.ts - b.ts);
  return { items, customers: customers.map(({ persona: _p, reliability: _r, ...c }) => c), bills, udhaar };
}

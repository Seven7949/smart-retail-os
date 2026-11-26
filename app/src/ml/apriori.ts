/** On-device Apriori (itemsets up to size 3) + association rules. */

export interface Rule {
  readonly if: readonly string[];
  readonly then: readonly string[];
  readonly support: number;
  readonly confidence: number;
  readonly lift: number;
}

const key = (items: readonly string[]) => [...items].sort().join('|');

export function frequentItemsets(transactions: readonly (readonly string[])[], minSupport: number, maxSize = 3): Map<string, number> {
  const n = transactions.length;
  const minCount = Math.max(1, Math.ceil(minSupport * n));
  const sets = transactions.map((t) => Array.from(new Set(t)).sort());
  const freq = new Map<string, number>();
  // size 1
  const c1 = new Map<string, number>();
  for (const t of sets) for (const i of t) c1.set(i, (c1.get(i) ?? 0) + 1);
  let level = [...c1].filter(([, c]) => c >= minCount).map(([i]) => [i]);
  for (const [i, c] of c1) if (c >= minCount) freq.set(i, c);
  for (let size = 2; size <= maxSize && level.length; size++) {
    const frequentItems = new Set(level.flat());
    const prevKeys = new Set(level.map(key));
    const counts = new Map<string, number>();
    for (const t of sets) {
      const items = t.filter((i) => frequentItems.has(i));
      const combos: string[][] = [];
      const rec = (start: number, acc: string[]) => {
        if (acc.length === size) { combos.push(acc); return; }
        for (let i = start; i < items.length; i++) rec(i + 1, [...acc, items[i]]);
      };
      rec(0, []);
      for (const c of combos) {
        // Apriori pruning: every (size-1)-subset must be frequent
        if (size > 2 && !c.every((_, i) => prevKeys.has(key(c.filter((__, j) => j !== i))))) continue;
        const k = key(c);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    level = [];
    for (const [k, c] of counts) {
      if (c >= minCount) {
        freq.set(k, c);
        level.push(k.split('|'));
      }
    }
  }
  return freq;
}

export function associationRules(transactions: readonly (readonly string[])[], minSupport = 0.01, minConfidence = 0.2, minLift = 1.2, top = 20): Rule[] {
  const n = transactions.length;
  if (!n) return [];
  const freq = frequentItemsets(transactions, minSupport);
  const rules: Rule[] = [];
  for (const [k, count] of freq) {
    const items = k.split('|');
    if (items.length < 2) continue;
    const subsets: string[][] = [];
    for (let mask = 1; mask < (1 << items.length) - 1; mask++) subsets.push(items.filter((_, i) => mask & (1 << i)));
    for (const ante of subsets) {
      const cons = items.filter((i) => !ante.includes(i));
      const a = freq.get(key(ante));
      const c = freq.get(key(cons));
      if (!a || !c) continue;
      const confidence = count / a;
      const lift = confidence / (c / n);
      if (confidence >= minConfidence && lift >= minLift) {
        rules.push({ if: ante, then: cons, support: count / n, confidence, lift });
      }
    }
  }
  return rules.sort((x, y) => y.lift - x.lift || y.confidence - x.confidence).slice(0, top);
}

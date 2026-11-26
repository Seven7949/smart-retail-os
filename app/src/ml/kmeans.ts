/** Customer segmentation on RFM features: K-Means++ with k chosen by silhouette. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

export function standardize(rows: readonly (readonly number[])[]): number[][] {
  if (!rows.length) return [];
  const d = rows[0].length;
  const mean = Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(rows.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / rows.length) || 1);
  return rows.map((r) => r.map((v, j) => (v - mean[j]) / sd[j]));
}

export function kmeans(X: readonly (readonly number[])[], k: number, seed = 1, iters = 50): number[] {
  const rand = mulberry32(seed);
  const centers: number[][] = [X[Math.floor(rand() * X.length)].slice()];
  while (centers.length < k) {
    const d = X.map((x) => Math.min(...centers.map((c) => dist2(x, c))));
    const total = d.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    let idx = 0;
    while (idx < d.length - 1 && r > d[idx]) r -= d[idx++];
    centers.push(X[idx].slice());
  }
  let labels = new Array(X.length).fill(0);
  for (let it = 0; it < iters; it++) {
    const next = X.map((x) => centers.reduce((best, c, j) => (dist2(x, c) < dist2(x, centers[best]) ? j : best), 0));
    const changed = next.some((l, i) => l !== labels[i]);
    labels = next;
    for (let j = 0; j < k; j++) {
      const members = X.filter((_, i) => labels[i] === j);
      if (members.length) centers[j] = members[0].map((_, m) => members.reduce((s, p) => s + p[m], 0) / members.length);
    }
    if (!changed && it > 0) break;
  }
  return labels;
}

export function silhouette(X: readonly (readonly number[])[], labels: readonly number[]): number {
  const n = X.length;
  const ks = Array.from(new Set(labels));
  if (ks.length < 2) return -1;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const byCluster = new Map<number, { sum: number; n: number }>();
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const e = byCluster.get(labels[j]) ?? { sum: 0, n: 0 };
      e.sum += Math.sqrt(dist2(X[i], X[j]));
      e.n++;
      byCluster.set(labels[j], e);
    }
    const own = byCluster.get(labels[i]);
    const a = own && own.n ? own.sum / own.n : 0;
    let b = Infinity;
    for (const [l, e] of byCluster) if (l !== labels[i] && e.n) b = Math.min(b, e.sum / e.n);
    total += b === Infinity || Math.max(a, b) === 0 ? 0 : (b - a) / Math.max(a, b);
  }
  return total / n;
}

export function bestKMeans(X: readonly (readonly number[])[], kMin = 2, kMax = 5, seed = 1): { k: number; labels: number[]; silhouette: number } {
  let best = { k: 1, labels: new Array(X.length).fill(0) as number[], silhouette: -1 };
  for (let k = kMin; k <= Math.min(kMax, X.length - 1); k++) {
    const labels = kmeans(X, k, seed);
    const s = silhouette(X, labels);
    if (s > best.silhouette) best = { k, labels, silhouette: s };
  }
  return best;
}

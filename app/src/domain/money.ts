/** Indian number formatting (lakh/crore grouping) without relying on Intl,
 * which is incomplete on some Android Hermes builds. */
import type { Unit } from './types';

export function groupIndian(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.trunc(n)).toString();
  if (s.length <= 3) return (neg ? '-' : '') + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (neg ? '-' : '') + rest + ',' + last3;
}

/** ₹1,23,456 or ₹45.50 (paise shown only when non-zero). */
export function formatRupees(paiseIn: number, opts: { compact?: boolean } = {}): string {
  const paise = Math.round(paiseIn);
  const neg = paise < 0;
  const abs = Math.abs(paise);
  if (opts.compact && abs >= 10_000_000) {
    const lakhs = abs / 10_000_000;
    return `${neg ? '-' : ''}₹${lakhs.toFixed(lakhs >= 10 ? 0 : 1)}L`;
  }
  if (opts.compact && abs >= 100_000) {
    const k = abs / 100_000;
    return `${neg ? '-' : ''}₹${k.toFixed(k >= 10 ? 0 : 1)}k`;
  }
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return `${neg ? '-' : ''}₹${groupIndian(rupees)}${p ? '.' + p.toString().padStart(2, '0') : ''}`;
}

export function formatQty(qtyMilli: number, unit: Unit): string {
  if (unit === 'pcs') {
    const n = qtyMilli / 1000;
    return Number.isInteger(n) ? `${n}` : n.toFixed(2).replace(/0+$/, '');
  }
  const base = unit === 'kg' ? ['kg', 'g'] : ['L', 'ml'];
  if (Math.abs(qtyMilli) < 1000) return `${qtyMilli} ${base[1]}`;
  const v = qtyMilli / 1000;
  return `${Number.isInteger(v) ? v : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} ${base[0]}`;
}

/** Parse "45", "45.5", "₹1,200" into paise; null when invalid. */
export function parseRupees(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [r, p = ''] = clean.split('.');
  const value = Number(r) * 100 + Number(p.padEnd(2, '0'));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

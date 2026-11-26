/** Immutable cart + bill creation. All arithmetic in integers. */
import type { Bill, BillLine, Item, PaymentMode } from './types';

export interface CartLine extends BillLine {
  readonly name: string;
  readonly unit: Item['unit'];
}

export type Cart = readonly CartLine[];

export const MAX_QTY_MILLI = 1_000_000_000;

/** LEDGER_SPEC line-total rule: half-up rounding to the paisa. */
export const lineTotal = (l: BillLine): number => Math.floor((l.qtyMilli * l.unitPricePaise + 500) / 1000);
export const cartTotal = (cart: Cart): number => cart.reduce((s, l) => s + lineTotal(l), 0);

/** Default step: 1 piece, 250 g / 250 ml for loose goods. */
export const stepFor = (unit: Item['unit']): number => (unit === 'pcs' ? 1000 : 250);

export function addToCart(cart: Cart, item: Item, qtyMilli = stepFor(item.unit)): Cart {
  if (!Number.isInteger(qtyMilli) || qtyMilli <= 0) throw new RangeError('quantity must be positive');
  const existing = cart.find((l) => l.sku === item.sku);
  if (existing) return setQty(cart, item.sku, existing.qtyMilli + qtyMilli);
  return [...cart, { sku: item.sku, name: item.name, unit: item.unit, qtyMilli: Math.min(qtyMilli, MAX_QTY_MILLI), unitPricePaise: item.pricePaise }];
}

export function setQty(cart: Cart, sku: string, qtyMilli: number): Cart {
  if (qtyMilli <= 0) return cart.filter((l) => l.sku !== sku);
  const q = Math.min(Math.round(qtyMilli), MAX_QTY_MILLI);
  return cart.map((l) => (l.sku === sku ? { ...l, qtyMilli: q } : l));
}

export function setPrice(cart: Cart, sku: string, unitPricePaise: number): Cart {
  if (!Number.isInteger(unitPricePaise) || unitPricePaise <= 0) throw new RangeError('price must be positive');
  return cart.map((l) => (l.sku === sku ? { ...l, unitPricePaise } : l));
}

export class BillError extends Error {}

export function createBill(cart: Cart, mode: PaymentMode, customerId: string | null, billId: string, now: number): Bill {
  if (cart.length === 0) throw new BillError('cart is empty');
  if (mode === 'udhaar' && !customerId) throw new BillError('choose a customer for udhaar');
  return {
    billId,
    createdAt: now,
    customerId,
    items: cart.map((l) => ({ sku: l.sku, qtyMilli: l.qtyMilli, unitPricePaise: l.unitPricePaise })),
    paymentMode: mode,
    totalPaise: cartTotal(cart),
  };
}

/** New item list with stock reduced by the bill (returns new objects). */
export function applyBillToStock(items: readonly Item[], bill: Bill): Item[] {
  const used = new Map<string, number>();
  for (const l of bill.items) used.set(l.sku, (used.get(l.sku) ?? 0) + l.qtyMilli);
  return items.map((it) => (used.has(it.sku) ? { ...it, stockMilli: it.stockMilli - used.get(it.sku)! } : it));
}

export function newId(prefix: string, now = Date.now(), rand: () => number = Math.random): string {
  const r = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
  return `${prefix}_${now.toString(36)}${r}`;
}

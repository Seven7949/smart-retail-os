import { addToCart, applyBillToStock, BillError, cartTotal, createBill, lineTotal, newId, setPrice, setQty } from '../billing';
import { formatQty, formatRupees, groupIndian, parseRupees } from '../money';
import type { Item } from '../types';

const sugar: Item = {
  sku: 'sugar-1', name: 'Sugar 1kg', category: 'staples', unit: 'kg', pricePaise: 4800, costPaise: 4300,
  stockMilli: 10000, leadTimeDays: 3, packSize: 25, shelfLifeDays: 365, festivalLift: 2.1,
};
const maggi: Item = { ...sugar, sku: 'maggi-70', name: 'Maggi', unit: 'pcs', pricePaise: 1400 };

describe('cart', () => {
  test('adds, merges, updates and removes immutably', () => {
    const empty = [] as const;
    const c1 = addToCart(empty, maggi);
    expect(empty).toHaveLength(0);
    const c2 = addToCart(c1, maggi);
    expect(c2).toHaveLength(1);
    expect(c2[0].qtyMilli).toBe(2000);
    expect(c1[0].qtyMilli).toBe(1000);
    const c3 = addToCart(c2, sugar);
    expect(c3[1].qtyMilli).toBe(250); // loose goods step 250 g
    expect(cartTotal(c3)).toBe(2 * 1400 + 1200);
    expect(setQty(c3, 'maggi-70', 0)).toHaveLength(1);
    expect(setPrice(c3, 'sugar-1', 5000)[1].unitPricePaise).toBe(5000);
    expect(() => addToCart(c3, sugar, -1)).toThrow(RangeError);
    expect(() => setPrice(c3, 'sugar-1', 0)).toThrow(RangeError);
  });

  test('half-up rounding matches LEDGER_SPEC', () => {
    expect(lineTotal({ sku: 'x', qtyMilli: 333, unitPricePaise: 1500 })).toBe(500);
    expect(lineTotal({ sku: 'x', qtyMilli: 333, unitPricePaise: 1000 })).toBe(333);
  });

  test('createBill validates and applyBillToStock decrements', () => {
    const cart = addToCart(addToCart([], maggi, 3000), sugar, 1500);
    expect(() => createBill([], 'cash', null, 'b', 1)).toThrow(BillError);
    expect(() => createBill(cart, 'udhaar', null, 'b', 1)).toThrow(/customer/);
    const bill = createBill(cart, 'udhaar', 'c_1', 'b_1', 42);
    expect(bill).toEqual({
      billId: 'b_1', createdAt: 42, customerId: 'c_1', paymentMode: 'udhaar', totalPaise: 4200 + 7200,
      items: [{ sku: 'maggi-70', qtyMilli: 3000, unitPricePaise: 1400 }, { sku: 'sugar-1', qtyMilli: 1500, unitPricePaise: 4800 }],
    });
    const after = applyBillToStock([sugar, maggi], bill);
    expect(after[0].stockMilli).toBe(8500);
    expect(after[1].stockMilli).toBe(7000);
    expect(sugar.stockMilli).toBe(10000);
  });

  test('ids are URL/ledger safe', () => {
    const id = newId('b', 1767225600000, () => 0.5);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('money formatting', () => {
  test('indian grouping', () => {
    expect(groupIndian(1234567)).toBe('12,34,567');
    expect(groupIndian(999)).toBe('999');
    expect(groupIndian(-100000)).toBe('-1,00,000');
    expect(formatRupees(123456789)).toBe('₹12,34,567.89');
    expect(formatRupees(4500)).toBe('₹45');
    expect(formatRupees(-50)).toBe('-₹0.50');
    expect(formatRupees(250_000_00, { compact: true })).toBe('₹2.5L');
    expect(formatRupees(4_560_00, { compact: true })).toBe('₹4.6k');
    expect(formatRupees(999_00, { compact: true })).toBe('₹999');
    expect(formatRupees(7212576.9155)).toBe('₹72,125.77');
  });

  test('quantities', () => {
    expect(formatQty(2000, 'pcs')).toBe('2');
    expect(formatQty(1500, 'pcs')).toBe('1.5');
    expect(formatQty(250, 'kg')).toBe('250 g');
    expect(formatQty(1500, 'kg')).toBe('1.5 kg');
    expect(formatQty(2000, 'l')).toBe('2 L');
  });

  test('parse rupees', () => {
    expect(parseRupees('45')).toBe(4500);
    expect(parseRupees('₹1,200.5')).toBe(120050);
    expect(parseRupees('abc')).toBeNull();
    expect(parseRupees('0')).toBeNull();
    expect(parseRupees('1.234')).toBeNull();
  });
});

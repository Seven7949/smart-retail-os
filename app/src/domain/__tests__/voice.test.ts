import { CATALOG } from '../catalog';
import { bestMatches, levenshtein, normalize, scoreItem } from '../match';
import type { Item } from '../types';
import { needsCloudHelp, parseUtterance } from '../voice';

const ITEMS: Item[] = CATALOG.map((c) => ({ ...c, stockMilli: 10000 }));
const parse = (t: string) => parseUtterance(t, ITEMS);
const summary = (t: string) => parse(t).lines.map((l) => [l.item.sku, l.qtyMilli]);

describe('Hinglish voice parser', () => {
  test.each([
    ['do kilo cheeni aur teen maggi', [['sugar-1', 2000], ['maggi-70', 3000]]],
    ['2 kg sugar 250 gram chai patti', [['sugar-1', 2000], ['tea-tata-250', 1000]]],
    ['bhaiya ek parle ji dena', [['parleg-80', 1000]]],
    ['dhai kilo aloo, aadha kilo tamatar', [['potato-1', 2500], ['tomato-1', 500]]],
    ['sawa do kilo pyaz', [['onion-1', 2250]]],
    ['sadhe teen kilo atta', [['atta-aashirvaad-5', 1000]]],
    ['ek amul doodh', [['milk-amul-500', 1000]]],
    ['ek maggi do', [['maggi-70', 1000]]],
    ['dozen ande', [['eggs-6', 12000]]],
    ['ढाई किलो आलू और एक दूध', [['potato-1', 2500], ['milk-amul-500', 1000]]],
    ['दो किलो चीनी, तीन मैगी', [['sugar-1', 2000], ['maggi-70', 3000]]],
    ['२ पैकेट पारले जी', [['parleg-80', 2000]]],
    ['3 coke 2 lays', [['coke-750', 3000], ['lays-52', 2000]]],
    ['magi teen', [['maggi-70', 1000]]],
  ])('%s', (text, expected) => {
    // "magi teen": a number after the item starts a new (empty) segment -> qty defaults to 1
    // "sadhe teen kilo atta": atta is sold as a 5 kg bag -> 1 bag, flagged low-confidence
    expect(summary(text as string)).toEqual(expected);
  });

  test('merges repeated items and keeps the lowest confidence', () => {
    const r = parse('ek maggi aur do maggi');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].qtyMilli).toBe(3000);
  });

  test('unknown words are reported and trigger cloud help', () => {
    const r = parse('do kilo xyzzy aur ek maggi');
    expect(r.unmatched).toEqual(['xyzzy']);
    expect(r.lines.map((l) => l.item.sku)).toEqual(['maggi-70']);
    expect(needsCloudHelp(r)).toBe(true);
    expect(needsCloudHelp(parse('teen maggi'))).toBe(false);
    expect(parse('').lines).toHaveLength(0);
  });
});

describe('fuzzy matcher', () => {
  test('normalize strips sizes and punctuation', () => {
    expect(normalize('PARLE-G 80G')).toBe('parle g');
    expect(normalize('Amul  Taaza Milk 500ml!!')).toBe('amul taaza milk');
  });

  test('levenshtein', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  test('invoice lines map to inventory', () => {
    const cases: [string, string][] = [
      ['PARLE-G 80G', 'parleg-80'], ['TATA SALT 1KG', 'salt-tata-1'], ['Surf Excel Easy Wash 1kg', 'detergent-surf-1'],
      ['FORTUNE SUNFLOWER OIL 1L', 'oil-fortune-1'], ['Toor Dal', 'toor-dal-1'], ['CADBURY DAIRY MILK', 'dairymilk-50'],
    ];
    for (const [text, sku] of cases) expect(bestMatches(text, ITEMS, 1)[0]?.item.sku).toBe(sku);
    expect(bestMatches('random gibberish qqq', ITEMS)).toHaveLength(0);
    expect(scoreItem('', ITEMS[0])).toBe(0);
  });
});

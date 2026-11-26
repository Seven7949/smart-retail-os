import catalogJson from '../spec/catalog.json';
import type { Item, Unit } from './types';

export interface Festival {
  readonly name: string;
  readonly dates: readonly string[];
  readonly windowBefore: number;
  readonly windowAfter: number;
  readonly intensity: number;
}

export interface BasketTemplate {
  readonly name: string;
  readonly skus: readonly string[];
  readonly weight: number;
}

export interface CatalogItem extends Omit<Item, 'stockMilli'> {
  readonly baseDaily: number;
  readonly season: 'summer' | 'winter' | 'monsoon' | 'none';
}

export const CATALOG: readonly CatalogItem[] = catalogJson.items.map((i) => ({
  ...i,
  unit: i.unit as Unit,
  season: i.season as CatalogItem['season'],
}));
export const FESTIVALS: readonly Festival[] = catalogJson.festivals;
export const BASKETS: readonly BasketTemplate[] = catalogJson.baskets;

export const CATEGORY_LABELS: Record<string, { en: string; hi: string; icon: string }> = {
  dairy: { en: 'Dairy', hi: 'डेयरी', icon: 'water-outline' },
  bakery: { en: 'Bakery', hi: 'बेकरी', icon: 'cafe-outline' },
  staples: { en: 'Staples', hi: 'राशन', icon: 'basket-outline' },
  beverages: { en: 'Drinks', hi: 'पेय', icon: 'beer-outline' },
  snacks: { en: 'Snacks', hi: 'नाश्ता', icon: 'fast-food-outline' },
  personal: { en: 'Personal care', hi: 'साबुन-शैम्पू', icon: 'sparkles-outline' },
  home: { en: 'Home care', hi: 'घरेलू', icon: 'home-outline' },
  pooja: { en: 'Pooja', hi: 'पूजा', icon: 'flame-outline' },
  fresh: { en: 'Vegetables', hi: 'सब्ज़ी', icon: 'leaf-outline' },
};

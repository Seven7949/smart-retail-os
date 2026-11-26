/**
 * Application store: immutable state + async actions that persist through the
 * Repo. Framework-free so it is fully unit-testable; React binds to it with
 * `useStore` (useSyncExternalStore).
 */
import { ApiClient, chainForSync, toCloudCustomer, type ScanResult } from '../api/client';
import { Auth } from '../api/auth';
import { buildTimeConfig, validateConfig, type CloudConfig } from '../api/config';
import { applyBillToStock, createBill, newId, type Cart } from '../domain/billing';
import { CATALOG } from '../domain/catalog';
import { generateDemoShop } from '../domain/demo';
import { appendBill, buildChain, verifyChain, type VerifyReport } from '../domain/ledger';
import type { Bill, ChainHead, ChainRecord, Customer, Item, PaymentMode, UdhaarTxn } from '../domain/types';
import { computeInsights, type Insights } from '../ml/insights';
import type { Repo } from './repo';

export type Lang = 'en' | 'hi';
export const LOCAL_SHOP_ID = 'local';
const SYNC_BATCH = 200;

export interface Settings {
  readonly lang: Lang;
  readonly shopName: string;
  readonly upiId: string;
  readonly onboarded: boolean;
  readonly shopId: string;
  readonly publicKey: string | null;
  readonly lastSyncAt: number | null;
  readonly digestOptIn: boolean;
  readonly cloud: Partial<CloudConfig>;
  readonly email: string | null;
}

export interface State {
  readonly ready: boolean;
  readonly items: readonly Item[];
  readonly customers: readonly Customer[];
  readonly udhaar: readonly UdhaarTxn[];
  readonly chain: readonly ChainRecord[];
  readonly settings: Settings;
  readonly version: number;
  readonly cloudInsights: Record<string, unknown> | null;
  readonly syncing: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'en', shopName: '', upiId: '', onboarded: false, shopId: LOCAL_SHOP_ID, publicKey: null, lastSyncAt: null,
  digestOptIn: false, cloud: buildTimeConfig(), email: null,
};

export class StoreError extends Error {}

export class Store {
  private state: State;
  private listeners = new Set<() => void>();
  private insightsCache: { version: number; value: Insights } | null = null;

  private constructor(private readonly repo: Repo, initial: State, private readonly fetchFn: typeof fetch) {
    this.state = initial;
  }

  static async create(repo: Repo, fetchFn: typeof fetch = fetch): Promise<Store> {
    const snap = await repo.load();
    const saved = snap.kv.settings ? (JSON.parse(snap.kv.settings) as Partial<Settings>) : {};
    const settings: Settings = { ...DEFAULT_SETTINGS, ...saved, cloud: { ...DEFAULT_SETTINGS.cloud, ...(saved.cloud ?? {}) } };
    return new Store(repo, {
      ready: true, items: snap.items, customers: snap.customers, udhaar: snap.udhaar, chain: snap.chain, settings,
      version: 1, cloudInsights: snap.kv.cloudInsights ? JSON.parse(snap.kv.cloudInsights) : null, syncing: false,
    }, fetchFn);
  }

  // ---------- subscription ----------
  getState = (): State => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<State>, bump = true) {
    this.state = { ...this.state, ...patch, version: bump ? this.state.version + 1 : this.state.version };
    this.listeners.forEach((l) => l());
  }

  // ---------- derived ----------
  bills(): Bill[] { return this.state.chain.map((r) => r.bill); }
  head(): ChainHead | null {
    const last = this.state.chain[this.state.chain.length - 1];
    return last ? { seq: last.entry.seq, entryHash: last.entryHash } : null;
  }
  insights(now = Date.now()): Insights {
    if (this.insightsCache?.version === this.state.version) return this.insightsCache.value;
    const s = this.state;
    const value = computeInsights(this.bills(), s.items, s.customers, s.udhaar, now);
    this.insightsCache = { version: s.version, value };
    return value;
  }
  balance(customerId: string): number {
    return this.state.udhaar.filter((t) => t.customerId === customerId)
      .reduce((s, t) => s + (t.kind === 'credit' ? t.amountPaise : -t.amountPaise), 0);
  }

  // ---------- onboarding ----------
  async loadDemo(now = Date.now()): Promise<void> {
    const demo = generateDemoShop(now);
    const chain = buildChain(this.state.settings.shopId, demo.bills);
    await this.repo.reset();
    await this.repo.saveItems(demo.items);
    await this.repo.saveCustomers(demo.customers);
    await this.repo.saveUdhaar(demo.udhaar);
    await this.repo.appendChain(chain);
    const settings = { ...this.state.settings, onboarded: true, shopName: this.state.settings.shopName || 'Sharma General Store', upiId: this.state.settings.upiId || 'sharmastore@upi' };
    await this.repo.setKV('settings', JSON.stringify(settings));
    this.set({ items: demo.items, customers: demo.customers, udhaar: demo.udhaar, chain, settings });
  }

  async startFresh(shopName: string): Promise<void> {
    const items: Item[] = CATALOG.map(({ baseDaily: _b, season: _s, ...rest }) => ({ ...rest, stockMilli: 0 }));
    await this.repo.reset();
    await this.repo.saveItems(items);
    const settings = { ...this.state.settings, onboarded: true, shopName: shopName.trim() || 'My shop' };
    await this.repo.setKV('settings', JSON.stringify(settings));
    this.set({ items, customers: [], udhaar: [], chain: [], settings });
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const settings = { ...this.state.settings, ...patch };
    await this.repo.setKV('settings', JSON.stringify(settings));
    this.set({ settings }, false);
  }

  // ---------- billing ----------
  async saveBill(cart: Cart, mode: PaymentMode, customerId: string | null, now = Date.now()): Promise<ChainRecord> {
    const bill = createBill(cart, mode, customerId, newId('b', now), now);
    const record = appendBill(this.state.settings.shopId, this.head(), bill);
    const items = applyBillToStock(this.state.items, bill);
    const changed = items.filter((it, i) => it !== this.state.items[i]);
    await this.repo.appendChain([record]);
    await this.repo.saveItems(changed);
    let udhaar = this.state.udhaar;
    if (mode === 'udhaar' && customerId) {
      const txn: UdhaarTxn = { id: newId('u', now), customerId, kind: 'credit', amountPaise: bill.totalPaise, ts: now, billId: bill.billId };
      await this.repo.saveUdhaar([txn]);
      udhaar = [...udhaar, txn];
    }
    this.set({ chain: [...this.state.chain, record], items, udhaar });
    return record;
  }

  // ---------- inventory ----------
  async upsertItem(item: Item): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(item.sku)) throw new StoreError('invalid sku');
    if (!item.name.trim() || item.pricePaise <= 0) throw new StoreError('name and price are required');
    await this.repo.saveItems([item]);
    const exists = this.state.items.some((i) => i.sku === item.sku);
    this.set({ items: exists ? this.state.items.map((i) => (i.sku === item.sku ? item : i)) : [...this.state.items, item] });
  }

  /** Add received stock (e.g. from a scanned supplier invoice). */
  async receiveStock(lines: readonly { sku: string; qtyMilli: number; costPaise?: number | null }[]): Promise<number> {
    const bySku = new Map<string, { qty: number; cost?: number | null }>();
    lines.forEach((l) => {
      if (l.qtyMilli > 0) bySku.set(l.sku, { qty: (bySku.get(l.sku)?.qty ?? 0) + l.qtyMilli, cost: l.costPaise });
    });
    const items = this.state.items.map((it) => {
      const r = bySku.get(it.sku);
      if (!r) return it;
      return { ...it, stockMilli: it.stockMilli + r.qty, costPaise: r.cost && r.cost > 0 ? r.cost : it.costPaise };
    });
    const changed = items.filter((it, i) => it !== this.state.items[i]);
    await this.repo.saveItems(changed);
    this.set({ items });
    return changed.length;
  }

  // ---------- khata (udhaar) ----------
  async addCustomer(name: string, phone?: string, creditLimitPaise?: number): Promise<Customer> {
    const clean = name.trim();
    if (!clean || clean.length > 80) throw new StoreError('enter a name');
    if (phone && !/^\+?\d{10,13}$/.test(phone.replace(/[\s-]/g, ''))) throw new StoreError('enter a valid phone number');
    const c: Customer = { customerId: newId('c'), name: clean, phone: phone?.replace(/[\s-]/g, '') || undefined, creditLimitPaise, remindersSent: 0 };
    await this.repo.saveCustomers([c]);
    this.set({ customers: [...this.state.customers, c] });
    return c;
  }

  async recordUdhaar(customerId: string, kind: UdhaarTxn['kind'], amountPaise: number, now = Date.now()): Promise<UdhaarTxn> {
    if (!this.state.customers.some((c) => c.customerId === customerId)) throw new StoreError('unknown customer');
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new StoreError('enter an amount');
    const txn: UdhaarTxn = { id: newId(kind === 'credit' ? 'u' : 'p', now), customerId, kind, amountPaise, ts: now };
    await this.repo.saveUdhaar([txn]);
    this.set({ udhaar: [...this.state.udhaar, txn] });
    return txn;
  }

  async markReminderSent(customerId: string): Promise<void> {
    const customers = this.state.customers.map((c) => (c.customerId === customerId ? { ...c, remindersSent: (c.remindersSent ?? 0) + 1 } : c));
    await this.repo.saveCustomers(customers.filter((c) => c.customerId === customerId));
    this.set({ customers });
  }

  // ---------- ledger ----------
  verifyLocal(signatures: 'all' | 'latest' = 'latest'): VerifyReport {
    const s = this.state;
    return verifyChain(s.settings.shopId, s.chain, s.settings.publicKey ?? undefined, signatures);
  }

  // ---------- cloud ----------
  cloudConfig(): CloudConfig | null {
    const v = validateConfig(this.state.settings.cloud);
    return v.ok ? v.config : null;
  }
  private auth(): Auth {
    const cfg = this.cloudConfig();
    if (!cfg) throw new StoreError('Cloud is not configured. Add the API details in Settings.');
    return new Auth(cfg, this.fetchFn);
  }
  api(): ApiClient {
    return new ApiClient(this.cloudConfig()!, this.auth(), this.fetchFn);
  }

  signUp(email: string, password: string) { return this.auth().signUp(email, password); }
  confirmSignUp(email: string, code: string) { return this.auth().confirm(email, code); }

  async signIn(email: string, password: string): Promise<void> {
    const tokens = await this.auth().signIn(email, password);
    const s = this.state;
    if (s.settings.shopId !== tokens.sub) {
      if (s.chain.some((r) => r.signature)) {
        await this.auth().signOut();
        throw new StoreError('This phone already holds another account\'s signed bills. Reset data before switching accounts.');
      }
      // Bills made offline before sign-in are re-chained under the real shop id (none are signed yet).
      const chain = buildChain(tokens.sub, this.bills());
      await this.repo.replaceChain(chain);
      this.set({ chain });
    }
    await this.updateSettings({ shopId: tokens.sub, email: tokens.email });
  }

  async signOut(): Promise<void> {
    await this.auth().signOut();
    await this.updateSettings({ email: null });
  }

  async sync(now = Date.now()): Promise<{ signed: number }> {
    const api = this.api();
    this.set({ syncing: true }, false);
    try {
      const s = this.state;
      const pending = s.chain.filter((r) => !r.signature);
      const sentUdhaar = s.udhaar.filter((u) => !u.synced);
      let signed = 0;
      for (let i = 0; i === 0 || i < pending.length; i += SYNC_BATCH) {
        const batch = pending.slice(i, i + SYNC_BATCH);
        const first = i === 0;
        const res = await api.sync({
          ...(first ? {
            profile: { shopName: s.settings.shopName || 'My shop', digestOptIn: s.settings.digestOptIn },
            items: s.items, customers: s.customers.map(toCloudCustomer), udhaar: sentUdhaar,
          } : {}),
          chain: batch.map(chainForSync),
        });
        const sigs = res.accepted.filter((a) => batch.some((b) => b.entry.seq === a.seq && b.entryHash === a.entryHash));
        await this.repo.setSignatures(sigs);
        const bySeq = new Map(sigs.map((a) => [a.seq, a.signature]));
        // merge into the *current* state: bills saved while we were waiting must not be lost
        this.set({ chain: this.state.chain.map((r) => (bySeq.has(r.entry.seq) ? { ...r, signature: bySeq.get(r.entry.seq)! } : r)) }, false);
        signed += sigs.length;
        if (first && sentUdhaar.length) {
          const sentIds = new Set(sentUdhaar.map((u) => u.id));
          const marked = sentUdhaar.map((u) => ({ ...u, synced: true }));
          await this.repo.saveUdhaar(marked);
          this.set({ udhaar: this.state.udhaar.map((u) => (sentIds.has(u.id) ? { ...u, synced: true } : u)) }, false);
        }
      }
      const publicKey = this.state.settings.publicKey ?? (await api.publicKey()).publicKey;
      const cloud = await api.insights().catch(() => null);
      if (cloud) {
        await this.repo.setKV('cloudInsights', JSON.stringify(cloud.insights));
        this.set({ cloudInsights: cloud.insights }, false);
      }
      await this.updateSettings({ publicKey, lastSyncAt: now });
      return { signed };
    } finally {
      this.set({ syncing: false }, false);
    }
  }

  scanInvoice(uri: string, type: 'image/jpeg' | 'image/png'): Promise<ScanResult> {
    return this.api().scanInvoice(uri, type);
  }

  async resetAll(): Promise<void> {
    await this.repo.reset();
    const settings = { ...DEFAULT_SETTINGS, lang: this.state.settings.lang, cloud: this.state.settings.cloud };
    this.set({ items: [], customers: [], udhaar: [], chain: [], settings, cloudInsights: null });
  }
}

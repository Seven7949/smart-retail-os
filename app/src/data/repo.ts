/**
 * Offline-first persistence. SQLite (expo-sqlite) is the source of truth on
 * the phone; the cloud is a sync target. The `Repo` interface isolates
 * storage from business logic (ECC patterns: repository boundary).
 */
import type { ChainRecord, Customer, Item, UdhaarTxn } from '../domain/types';

export interface Snapshot {
  readonly items: Item[];
  readonly customers: Customer[];
  readonly udhaar: UdhaarTxn[];
  readonly chain: ChainRecord[];
  readonly kv: Record<string, string>;
}

export interface Repo {
  load(): Promise<Snapshot>;
  saveItems(items: readonly Item[]): Promise<void>;
  saveCustomers(customers: readonly Customer[]): Promise<void>;
  saveUdhaar(txns: readonly UdhaarTxn[]): Promise<void>;
  appendChain(records: readonly ChainRecord[]): Promise<void>;
  /** A sale: ledger entry + stock changes + optional udhaar credit, all or nothing. */
  commitBill(record: ChainRecord, items: readonly Item[], udhaar: readonly UdhaarTxn[]): Promise<void>;
  replaceChain(records: readonly ChainRecord[]): Promise<void>;
  setSignatures(sigs: readonly { seq: number; signature: string }[]): Promise<void>;
  setKV(key: string, value: string): Promise<void>;
  reset(): Promise<void>;
}

/** Minimal subset of the expo-sqlite async API we rely on (also implemented by the test adapter). */
export interface SqlDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS items (sku TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS udhaar (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY NOT NULL, bill_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, signature TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

export class SqliteRepo implements Repo {
  /** Serialises all access: expo-sqlite transactions are not exclusive, so two
   * overlapping writes (e.g. a bill saved during a sync) would nest BEGINs. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly db: SqlDb) {}

  static async open(db: SqlDb): Promise<SqliteRepo> {
    await db.execAsync(SCHEMA);
    return new SqliteRepo(db);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  load(): Promise<Snapshot> {
    return this.exclusive(async () => {
      const rows = <T,>(sql: string) => this.db.getAllAsync<T>(sql);
      const items = (await rows<{ data: string }>('SELECT data FROM items')).map((r) => JSON.parse(r.data) as Item);
      const customers = (await rows<{ data: string }>('SELECT data FROM customers')).map((r) => JSON.parse(r.data) as Customer);
      const udhaar = (await rows<{ data: string }>('SELECT data FROM udhaar')).map((r) => JSON.parse(r.data) as UdhaarTxn)
        .sort((a, b) => a.ts - b.ts);
      const chain = (await rows<{ data: string; signature: string | null }>('SELECT data, signature FROM ledger ORDER BY seq'))
        .map((r) => ({ ...(JSON.parse(r.data) as Omit<ChainRecord, 'signature'>), signature: r.signature }));
      const kv: Record<string, string> = {};
      for (const r of await rows<{ key: string; value: string }>('SELECT key, value FROM kv')) kv[r.key] = r.value;
      return { items, customers, udhaar, chain, kv };
    });
  }

  private upsertMany(table: 'items' | 'customers' | 'udhaar', keyCol: string, rows: readonly [string, unknown][]) {
    return this.exclusive(async () => {
      if (!rows.length) return;
      await this.db.withTransactionAsync(async () => {
        for (const [k, v] of rows) {
          await this.db.runAsync(`INSERT OR REPLACE INTO ${table} (${keyCol}, data) VALUES (?, ?)`, k, JSON.stringify(v));
        }
      });
    });
  }

  saveItems(items: readonly Item[]) { return this.upsertMany('items', 'sku', items.map((i) => [i.sku, i])); }
  saveCustomers(cs: readonly Customer[]) { return this.upsertMany('customers', 'id', cs.map((c) => [c.customerId, c])); }
  saveUdhaar(ts: readonly UdhaarTxn[]) { return this.upsertMany('udhaar', 'id', ts.map((t) => [t.id, t])); }

  private async insertChain(records: readonly ChainRecord[]) {
    for (const r of records) {
      // plain INSERT: a duplicate seq or bill id fails loudly instead of overwriting history
      await this.db.runAsync('INSERT INTO ledger (seq, bill_id, data, signature) VALUES (?, ?, ?, ?)',
        r.entry.seq, r.bill.billId, JSON.stringify({ bill: r.bill, entry: r.entry, entryHash: r.entryHash }), r.signature);
    }
  }

  appendChain(records: readonly ChainRecord[]) {
    return this.exclusive(async () => {
      if (records.length) await this.db.withTransactionAsync(() => this.insertChain(records));
    });
  }

  commitBill(record: ChainRecord, items: readonly Item[], udhaar: readonly UdhaarTxn[]) {
    return this.exclusive(() => this.db.withTransactionAsync(async () => {
      await this.insertChain([record]);
      for (const i of items) await this.db.runAsync('INSERT OR REPLACE INTO items (sku, data) VALUES (?, ?)', i.sku, JSON.stringify(i));
      for (const t of udhaar) await this.db.runAsync('INSERT OR REPLACE INTO udhaar (id, data) VALUES (?, ?)', t.id, JSON.stringify(t));
    }));
  }

  /** One transaction: a crash can never leave the shop with an empty ledger. */
  replaceChain(records: readonly ChainRecord[]) {
    return this.exclusive(() => this.db.withTransactionAsync(async () => {
      await this.db.runAsync('DELETE FROM ledger');
      await this.insertChain(records);
    }));
  }

  setSignatures(sigs: readonly { seq: number; signature: string }[]) {
    return this.exclusive(() => this.db.withTransactionAsync(async () => {
      for (const s of sigs) await this.db.runAsync('UPDATE ledger SET signature = ? WHERE seq = ?', s.signature, s.seq);
    }));
  }

  setKV(key: string, value: string) {
    return this.exclusive(async () => {
      await this.db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value);
    });
  }

  reset() {
    return this.exclusive(() => this.db.execAsync('DELETE FROM items; DELETE FROM customers; DELETE FROM udhaar; DELETE FROM ledger; DELETE FROM kv;'));
  }
}

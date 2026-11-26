/** In-memory Repo: used for the web preview build (no SQLite there). */
import type { ChainRecord, Customer, Item, UdhaarTxn } from '../domain/types';
import type { Repo, Snapshot } from './repo';

export class MemoryRepo implements Repo {
  private items = new Map<string, Item>();
  private customers = new Map<string, Customer>();
  private udhaar = new Map<string, UdhaarTxn>();
  private chain = new Map<number, ChainRecord>();
  private kv = new Map<string, string>();

  async load(): Promise<Snapshot> {
    return {
      items: [...this.items.values()], customers: [...this.customers.values()],
      udhaar: [...this.udhaar.values()].sort((a, b) => a.ts - b.ts),
      chain: [...this.chain.values()].sort((a, b) => a.entry.seq - b.entry.seq), kv: Object.fromEntries(this.kv),
    };
  }
  async saveItems(xs: readonly Item[]) { xs.forEach((x) => this.items.set(x.sku, x)); }
  async saveCustomers(xs: readonly Customer[]) { xs.forEach((x) => this.customers.set(x.customerId, x)); }
  async saveUdhaar(xs: readonly UdhaarTxn[]) { xs.forEach((x) => this.udhaar.set(x.id, x)); }
  async appendChain(rs: readonly ChainRecord[]) {
    for (const r of rs) {
      if (this.chain.has(r.entry.seq)) throw new Error(`ledger seq ${r.entry.seq} already exists`);
    }
    rs.forEach((r) => this.chain.set(r.entry.seq, r));
  }
  async replaceChain(rs: readonly ChainRecord[]) { this.chain.clear(); await this.appendChain(rs); }
  async setSignatures(sigs: readonly { seq: number; signature: string }[]) {
    sigs.forEach((s) => {
      const r = this.chain.get(s.seq);
      if (r) this.chain.set(s.seq, { ...r, signature: s.signature });
    });
  }
  async setKV(k: string, v: string) { this.kv.set(k, v); }
  async reset() { [this.items, this.customers, this.udhaar, this.chain, this.kv].forEach((m) => m.clear()); }
}

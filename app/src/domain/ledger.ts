/**
 * On-device tamper-evident ledger. Every saved bill is appended to a SHA-256
 * hash chain immediately (works offline). When synced, the Rust signer adds an
 * Ed25519 signature which the phone can verify itself with the public key.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { canonical, sha256Hex } from './canonical';
import type { Bill, ChainHead, ChainRecord, LedgerEntry } from './types';

export const GENESIS_HASH = '0'.repeat(64);

export type FailureCode =
  | 'SEQ_GAP' | 'PREV_MISMATCH' | 'PAYLOAD_MISMATCH' | 'HASH_MISMATCH' | 'BAD_SIGNATURE' | 'SHOP_MISMATCH';

export interface VerifyReport {
  readonly valid: boolean;
  readonly checked: number;
  readonly signed: number;
  readonly failure?: { readonly seq: number; readonly code: FailureCode };
}

/** Only the hashed fields, in a fresh object (extra UI fields are dropped). */
export function billPayload(b: Bill): Bill {
  return {
    billId: b.billId, createdAt: b.createdAt, customerId: b.customerId,
    items: b.items.map((l) => ({ sku: l.sku, qtyMilli: l.qtyMilli, unitPricePaise: l.unitPricePaise })),
    paymentMode: b.paymentMode, totalPaise: b.totalPaise,
  };
}

export const payloadHash = (b: Bill): string => sha256Hex(canonical(billPayload(b)));
export const entryHash = (e: LedgerEntry): string => sha256Hex(canonical(e));

export function appendBill(shopId: string, head: ChainHead | null, bill: Bill): ChainRecord {
  const entry: LedgerEntry = {
    billId: bill.billId,
    payloadHash: payloadHash(bill),
    prevHash: head ? head.entryHash : GENESIS_HASH,
    seq: head ? head.seq + 1 : 0,
    shopId,
    timestamp: bill.createdAt,
  };
  return { bill: billPayload(bill), entry, entryHash: entryHash(entry), signature: null };
}

/** Build a whole chain for many bills (demo data, re-chaining on sign-in). */
export function buildChain(shopId: string, bills: readonly Bill[], head: ChainHead | null = null): ChainRecord[] {
  const out: ChainRecord[] = [];
  let h = head;
  for (const b of bills) {
    const rec = appendBill(shopId, h, b);
    out.push(rec);
    h = { seq: rec.entry.seq, entryHash: rec.entryHash };
  }
  return out;
}

export function verifySignature(publicKeyB64: string, entryHashHex: string, signatureB64: string): boolean {
  try {
    return ed25519.verify(b64ToBytes(signatureB64), hexToBytes(entryHashHex), b64ToBytes(publicKeyB64));
  } catch {
    return false;
  }
}

/**
 * Recompute every hash link. Signatures: `all` checks each one; `latest`
 * checks only the newest signed entry, which is enough because its hash
 * commits (through prevHash) to the entire history before it, and it is
 * ~1000x faster on a phone.
 */
export function verifyChain(
  shopId: string, chain: readonly ChainRecord[], publicKeyB64?: string, signatures: 'all' | 'latest' = 'all',
): VerifyReport {
  let prev = GENESIS_HASH;
  let signed = 0;
  let lastSigned = -1;
  if (signatures === 'latest') for (let i = chain.length - 1; i >= 0; i--) if (chain[i].signature) { lastSigned = i; break; }
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    const fail = (code: FailureCode): VerifyReport => ({ valid: false, checked: i, signed, failure: { seq: r.entry.seq, code } });
    if (r.entry.shopId !== shopId) return fail('SHOP_MISMATCH');
    if (r.entry.seq !== i) return fail('SEQ_GAP');
    if (r.entry.prevHash !== prev) return fail('PREV_MISMATCH');
    if (r.entry.billId !== r.bill.billId || r.entry.timestamp !== r.bill.createdAt || payloadHash(r.bill) !== r.entry.payloadHash) {
      return fail('PAYLOAD_MISMATCH');
    }
    if (entryHash(r.entry) !== r.entryHash) return fail('HASH_MISMATCH');
    if (r.signature && publicKeyB64) {
      const check = signatures === 'all' || i === lastSigned;
      if (check && !verifySignature(publicKeyB64, r.entryHash, r.signature)) return fail('BAD_SIGNATURE');
      signed++;
    }
    prev = r.entryHash;
  }
  return { valid: true, checked: chain.length, signed };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) throw new Error('invalid base64');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buf = 0, bits = 0, j = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, j);
}

import vectors from '../../spec/ledger-vectors.json';
import { canonical, CanonicalError, sha256Hex } from '../canonical';
import { appendBill, b64ToBytes, buildChain, GENESIS_HASH, payloadHash, verifyChain, verifySignature } from '../ledger';
import type { Bill, ChainRecord } from '../types';

const fs = require('fs');
const path = require('path');

describe('cross-language conformance (shared vectors)', () => {
  test('spec copies in the app are identical to the repo spec', () => {
    for (const f of ['catalog.json', 'ledger-vectors.json', 'udhaar_model.json']) {
      const a = fs.readFileSync(path.join(__dirname, '../../spec', f), 'utf8');
      const b = fs.readFileSync(path.join(__dirname, '../../../../spec', f), 'utf8');
      expect(a).toBe(b);
    }
  });

  test.each(vectors.canonicalCases.map((c) => [c.name, c]))('canonical: %s', (_n, c: any) => {
    expect(canonical(c.input)).toBe(c.canonical);
    expect(sha256Hex(c.canonical)).toBe(c.sha256);
  });

  test('floats and non-ASCII keys are rejected', () => {
    for (const bad of vectors.rejectFloats) expect(() => canonical(bad)).toThrow(CanonicalError);
    expect(() => canonical({ नाम: 1 })).toThrow(CanonicalError);
    expect(() => canonical({ n: 2 ** 60 })).toThrow(CanonicalError);
  });

  test('bills and entries hash exactly like Rust and Python', () => {
    const chain = buildChain(vectors.shopId, vectors.chain.map((c) => c.bill as Bill));
    chain.forEach((rec, i) => {
      expect(canonical(rec.bill)).toBe(vectors.chain[i].billCanonical);
      expect(canonical(rec.entry)).toBe(vectors.chain[i].entryCanonical);
      expect(rec.entryHash).toBe(vectors.chain[i].entryHash);
    });
  });

  test('server (Rust) signatures verify on the phone', () => {
    for (const c of vectors.chain) {
      expect(verifySignature(vectors.publicKeyBase64, c.entryHash, c.signature)).toBe(true);
    }
    expect(verifySignature(vectors.publicKeyBase64, vectors.chain[0].entryHash, vectors.chain[1].signature)).toBe(false);
    expect(verifySignature('bad', vectors.chain[0].entryHash, vectors.chain[0].signature)).toBe(false);
  });
});

describe('tamper detection', () => {
  const signedChain = (): ChainRecord[] =>
    vectors.chain.map((c) => ({ bill: c.bill as Bill, entry: c.entry, entryHash: c.entryHash, signature: c.signature }));

  test('valid signed chain', () => {
    const r = verifyChain(vectors.shopId, signedChain(), vectors.publicKeyBase64);
    expect(r).toEqual({ valid: true, checked: 3, signed: 3 });
  });

  test('edited, deleted, reordered, forged and foreign entries', () => {
    const edited = signedChain();
    edited[1] = { ...edited[1], bill: { ...edited[1].bill, totalPaise: 1 } };
    expect(verifyChain(vectors.shopId, edited).failure).toEqual({ seq: 1, code: 'PAYLOAD_MISMATCH' });

    const deleted = signedChain().filter((_, i) => i !== 1);
    expect(verifyChain(vectors.shopId, deleted).failure?.code).toBe('SEQ_GAP');

    const reordered = signedChain();
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    expect(verifyChain(vectors.shopId, reordered).failure?.code).toBe('SEQ_GAP');

    // attacker rewrites the last bill and recomputes all hashes but cannot sign
    const forged = signedChain();
    const last = forged[2];
    const bill = { ...last.bill, paymentMode: 'cash' as const };
    const entry = { ...last.entry, payloadHash: payloadHash(bill) };
    const rehashed = appendBill(vectors.shopId, { seq: 1, entryHash: forged[1].entryHash }, bill);
    forged[2] = { ...rehashed, entry: { ...entry, prevHash: forged[1].entryHash }, signature: last.signature };
    expect(verifyChain(vectors.shopId, forged, vectors.publicKeyBase64).failure?.code).toBe('BAD_SIGNATURE');
    expect(verifyChain(vectors.shopId, forged, vectors.publicKeyBase64, 'latest').failure?.code).toBe('BAD_SIGNATURE');
    // a forged middle entry breaks the hash links even when only the latest signature is checked
    const middle = signedChain();
    middle[1] = { ...middle[1], signature: middle[0].signature };
    expect(verifyChain(vectors.shopId, middle, vectors.publicKeyBase64, 'latest')).toMatchObject({ valid: true, signed: 3 });
    expect(verifyChain(vectors.shopId, middle, vectors.publicKeyBase64, 'all').failure?.code).toBe('BAD_SIGNATURE');

    expect(verifyChain('someone-else', signedChain()).failure?.code).toBe('SHOP_MISMATCH');

    const brokenHash = signedChain();
    brokenHash[0] = { ...brokenHash[0], entryHash: 'f'.repeat(64) };
    expect(verifyChain(vectors.shopId, brokenHash).failure?.code).toBe('HASH_MISMATCH');
    const brokenPrev = signedChain();
    brokenPrev[1] = { ...brokenPrev[1], entry: { ...brokenPrev[1].entry, prevHash: GENESIS_HASH } };
    expect(verifyChain(vectors.shopId, brokenPrev).failure?.code).toBe('PREV_MISMATCH');
  });

  test('appendBill strips non-hashed fields', () => {
    const b = { ...(vectors.chain[0].bill as Bill), uiOnly: 'x' } as Bill;
    expect(Object.keys(appendBill('s', null, b).bill)).not.toContain('uiOnly');
  });

  test('base64 decoder', () => {
    expect(Array.from(b64ToBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(b64ToBytes('AQ=='))).toEqual([1]);
    expect(() => b64ToBytes('!!')).toThrow();
  });
});

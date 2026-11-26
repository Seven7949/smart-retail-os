import vectors from '../../spec/ledger-vectors.json';
import { addToCart } from '../../domain/billing';
import { memoryDb } from '../../testing/memoryDb';
import { MemoryRepo } from '../memoryRepo';
import { SqliteRepo } from '../repo';
import { Store, StoreError } from '../store';

const NOW = Date.parse('2026-11-01T12:00:00+05:30');

const CFG = { apiUrl: 'https://api.example.com', region: 'ap-south-1', userPoolId: 'ap-south-1_AbCdEf123', clientId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3' };

function jwt(claims: object) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

/** Fake Cognito + API that signs with the reference vectors' semantics. */
function fakeCloud(opts: { sub?: string } = {}) {
  const calls: { url: string; body: any; headers: any }[] = [];
  const sub = opts.sub ?? 'user-sub-1';
  const fetchFn = jest.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: init?.headers });
    const ok = (json: object) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes('cognito-idp')) {
      const target = init.headers['X-Amz-Target'];
      if (target.endsWith('InitiateAuth')) {
        if (body.AuthParameters.PASSWORD === 'wrong') return { ok: false, status: 400, json: async () => ({ __type: 'NotAuthorizedException' }) };
        return ok({ AuthenticationResult: { IdToken: jwt({ sub, email: 'a@b.co' }), RefreshToken: 'r', ExpiresIn: 3600 } });
      }
      return ok({});
    }
    if (url.endsWith('/sync')) {
      return ok({ accepted: (body.chain ?? []).map((c: any) => ({ seq: c.entry.seq, entryHash: c.entryHash, signature: 'c2ln' })), head: null, counts: {}, serverTime: 1 });
    }
    if (url.endsWith('/ledger/public-key')) return ok({ publicKey: vectors.publicKeyBase64 });
    if (url.endsWith('/insights')) return ok({ insights: { meta: { billCount: 3 } } });
    return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'nope' } }) };
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

async function freshStore(fetchFn?: typeof fetch) {
  const repo = await SqliteRepo.open(await memoryDb());
  return { repo, store: await Store.create(repo, fetchFn) };
}

describe('store + sqlite repo', () => {
  test('start fresh, bill, stock, persistence round-trip', async () => {
    const { repo, store } = await freshStore();
    await store.startFresh('Gupta Kirana');
    const milk = store.getState().items.find((i) => i.sku === 'milk-amul-500')!;
    await store.receiveStock([{ sku: milk.sku, qtyMilli: 24000, costPaise: 2650 }, { sku: 'nope', qtyMilli: 5 }]);
    let listened = 0;
    const unsub = store.subscribe(() => listened++);
    const rec = await store.saveBill(addToCart([], store.getState().items.find((i) => i.sku === milk.sku)!, 2000), 'cash', null, NOW);
    unsub();
    expect(listened).toBe(1);
    expect(rec.entry.seq).toBe(0);
    const after = store.getState().items.find((i) => i.sku === milk.sku)!;
    expect(after.stockMilli).toBe(22000);
    expect(after.costPaise).toBe(2650);
    expect(store.verifyLocal().valid).toBe(true);

    const reloaded = await Store.create(repo);
    expect(reloaded.getState().settings.shopName).toBe('Gupta Kirana');
    expect(reloaded.getState().chain).toHaveLength(1);
    expect(reloaded.getState().items.find((i) => i.sku === milk.sku)!.stockMilli).toBe(22000);
  });

  test('ledger table refuses to overwrite history', async () => {
    const { repo, store } = await freshStore();
    await store.startFresh('x');
    const rec = await store.saveBill(addToCart([], store.getState().items[0]), 'cash', null, NOW);
    await expect(repo.appendChain([rec])).rejects.toThrow();
  });

  test('udhaar bills create credit; balances and validation', async () => {
    const { store } = await freshStore();
    await store.startFresh('x');
    await expect(store.addCustomer('  ')).rejects.toThrow(StoreError);
    await expect(store.addCustomer('Ramesh', '12')).rejects.toThrow(/phone/);
    const c = await store.addCustomer('Ramesh', '+91 98765 43210', 300000);
    expect(c.phone).toBe('+919876543210');
    const item = store.getState().items[0];
    await store.saveBill(addToCart([], item, 3000), 'udhaar', c.customerId, NOW);
    expect(store.balance(c.customerId)).toBe(item.pricePaise * 3);
    await store.recordUdhaar(c.customerId, 'payment', item.pricePaise, NOW);
    expect(store.balance(c.customerId)).toBe(item.pricePaise * 2);
    await expect(store.recordUdhaar('ghost', 'payment', 1)).rejects.toThrow(/customer/);
    await expect(store.recordUdhaar(c.customerId, 'payment', 0)).rejects.toThrow(/amount/);
    await store.markReminderSent(c.customerId);
    expect(store.getState().customers[0].remindersSent).toBe(1);
  });

  test('item validation', async () => {
    const { store } = await freshStore();
    await store.startFresh('x');
    const base = store.getState().items[0];
    await expect(store.upsertItem({ ...base, sku: 'bad sku' })).rejects.toThrow();
    await expect(store.upsertItem({ ...base, pricePaise: 0 })).rejects.toThrow();
    await store.upsertItem({ ...base, sku: 'my-new-item', name: 'Local Namkeen' });
    expect(store.getState().items.some((i) => i.sku === 'my-new-item')).toBe(true);
    await store.upsertItem({ ...base, name: 'Renamed' });
    expect(store.getState().items[0].name).toBe('Renamed');
  });

  test('demo shop loads with a valid chain and insights', async () => {
    const { store } = await freshStore();
    await store.loadDemo(NOW);
    const s = store.getState();
    expect(s.chain.length).toBeGreaterThan(2500);
    expect(store.verifyLocal()).toMatchObject({ valid: true });
    const ins = store.insights(NOW);
    expect(ins.reorder.length).toBeGreaterThan(0);
    expect(store.insights(NOW)).toBe(ins); // memoised by version
    await store.resetAll();
    expect(store.getState().chain).toHaveLength(0);
    expect(store.getState().settings.onboarded).toBe(false);
  });
});

describe('cloud flows', () => {
  test('sign-in re-chains offline bills, sync stores signatures and strips phones', async () => {
    const cloud = fakeCloud();
    const { store } = await freshStore(cloud.fetchFn);
    await store.updateSettings({ cloud: CFG });
    await store.startFresh('x');
    const c = await store.addCustomer('Ramesh', '+919876543210');
    await store.saveBill(addToCart([], store.getState().items[0]), 'cash', null, NOW);
    await store.saveBill(addToCart([], store.getState().items[1]), 'udhaar', c.customerId, NOW + 1000);
    expect(store.getState().chain[0].entry.shopId).toBe('local');

    await store.signIn('A@B.co ', 'pw12345678');
    const s = store.getState();
    expect(s.settings.shopId).toBe('user-sub-1');
    expect(s.chain.every((r) => r.entry.shopId === 'user-sub-1')).toBe(true);
    expect(store.verifyLocal().valid).toBe(true);

    const res = await store.sync(NOW);
    expect(res.signed).toBe(2);
    const after = store.getState();
    expect(after.chain.every((r) => r.signature === 'c2ln')).toBe(true);
    expect(after.settings.publicKey).toBe(vectors.publicKeyBase64);
    expect(after.cloudInsights).toEqual({ meta: { billCount: 3 } });
    expect(after.udhaar.every((u) => u.synced)).toBe(true);
    const syncCall = cloud.calls.find((x) => x.url.endsWith('/sync'))!;
    expect(syncCall.headers.Authorization).toMatch(/^Bearer /);
    expect(JSON.stringify(syncCall.body.customers)).not.toContain('9876543210');
    // signatures are fake ('c2ln'), so verification with the real key must now FAIL -> tamper detection works
    expect(store.verifyLocal().failure?.code).toBe('BAD_SIGNATURE');
  });

  test('bills and udhaar created during a sync are not lost or wrongly marked synced', async () => {
    const cloud = fakeCloud();
    const { store } = await freshStore(cloud.fetchFn);
    await store.updateSettings({ cloud: CFG });
    await store.startFresh('x');
    const c = await store.addCustomer('Ramesh');
    await store.recordUdhaar(c.customerId, 'credit', 1000, NOW);
    await store.signIn('a@b.co', 'pw12345678');
    const syncing = store.sync(NOW);
    // user keeps working while the request is in flight
    await store.recordUdhaar(c.customerId, 'credit', 2000, NOW + 1);
    await store.saveBill(addToCart([], store.getState().items[0]), 'cash', null, NOW + 2);
    await syncing;
    const s = store.getState();
    expect(s.udhaar.map((u) => !!u.synced)).toEqual([true, false]);
    expect(s.chain).toHaveLength(1);
    expect(s.chain[0].signature).toBeNull(); // created after the batch was sent
  });

  test('wrong password and unconfigured cloud give friendly errors', async () => {
    const { store } = await freshStore(fakeCloud().fetchFn);
    await expect(store.signIn('a@b.co', 'x')).rejects.toThrow(/not configured/);
    await store.updateSettings({ cloud: CFG });
    await expect(store.signIn('a@b.co', 'wrong')).rejects.toThrow(/Wrong email or password/);
  });

  test('refuses to mix two accounts on one phone', async () => {
    const cloud = fakeCloud({ sub: 'first' });
    const { store } = await freshStore(cloud.fetchFn);
    await store.updateSettings({ cloud: CFG });
    await store.startFresh('x');
    await store.saveBill(addToCart([], store.getState().items[0]), 'cash', null, NOW);
    await store.signIn('a@b.co', 'pw12345678');
    await store.sync(NOW);
    const other = fakeCloud({ sub: 'second' });
    const s2 = await Store.create((store as any).repo, other.fetchFn);
    await expect(s2.signIn('c@d.co', 'pw12345678')).rejects.toThrow(/another account/);
  });
});

describe('memory repo (web preview)', () => {
  test('behaves like the sqlite repo', async () => {
    const repo = new MemoryRepo();
    const store = await Store.create(repo);
    await store.startFresh('Web');
    const rec = await store.saveBill(addToCart([], store.getState().items[0]), 'cash', null, NOW);
    await expect(repo.appendChain([rec])).rejects.toThrow(/already exists/);
    await repo.setSignatures([{ seq: 0, signature: 'x' }, { seq: 9, signature: 'y' }]);
    const again = await Store.create(repo);
    expect(again.getState().chain[0].signature).toBe('x');
    await repo.replaceChain([]);
    expect((await repo.load()).chain).toHaveLength(0);
  });
});

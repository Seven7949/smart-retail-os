/**
 * UI flow tests (React Native Testing Library) over a REAL store backed by
 * SQLite (sql.js). These cover the critical user journeys end to end:
 * onboarding, billing by tap, billing by voice text, and the dashboard.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { StoreContext } from '../../data/hooks';
import { SqliteRepo } from '../../data/repo';
import { Store } from '../../data/store';
import { memoryDb } from '../../testing/memoryDb';
import { ToastProvider } from '../toast';
import Welcome from '../../app/welcome';
import BillScreen from '../../app/(tabs)/bill';
import Home from '../../app/(tabs)/index';
import Khata from '../../app/(tabs)/khata';
import { VoiceSheet } from '../../features/VoiceSheet';

async function makeStore() {
  return Store.create(await SqliteRepo.open(await memoryDb()));
}

async function wrap(store: Store, ui: ReactNode) {
  return render(<StoreContext.Provider value={store}><ToastProvider>{ui}</ToastProvider></StoreContext.Provider>);
}

jest.setTimeout(30000);

test('welcome → start my own shop', async () => {
  const store = await makeStore();
  await wrap(store, <Welcome />);
  await fireEvent.changeText(screen.getByLabelText('Shop name'), 'Gupta Kirana');
  await fireEvent.press(screen.getByLabelText('Start my own shop'));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
  expect(store.getState().settings).toMatchObject({ onboarded: true, shopName: 'Gupta Kirana' });
  expect(store.getState().items.length).toBeGreaterThan(30);
});

test('welcome language switch to Hindi', async () => {
  const store = await makeStore();
  await wrap(store, <Welcome />);
  await fireEvent.press(screen.getByText('हिंदी'));
  expect(await screen.findByText('डेमो दुकान देखें')).toBeTruthy();
});

test('bill by tapping items, pay cash, ledger entry created', async () => {
  const store = await makeStore();
  await store.startFresh('Test');
  await store.receiveStock([{ sku: 'maggi-70', qtyMilli: 48000 }]);
  await wrap(store, <BillScreen />);
  await fireEvent.press(screen.getByLabelText('Maggi Noodles 70g'));
  await fireEvent.press(screen.getByLabelText('Maggi Noodles 70g'));
  await fireEvent.press(screen.getByText('Cart'));
  expect((await screen.findAllByText('₹28')).length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByTestId('save-bill'));
  expect(await screen.findByText('Bill saved')).toBeTruthy();
  const s = store.getState();
  expect(s.chain).toHaveLength(1);
  expect(s.chain[0].bill.totalPaise).toBe(2800);
  expect(s.items.find((i) => i.sku === 'maggi-70')!.stockMilli).toBe(46000);
});

test('search filters the item grid', async () => {
  const store = await makeStore();
  await store.startFresh('Test');
  await wrap(store, <BillScreen />);
  await fireEvent.changeText(screen.getByLabelText('Search items…'), 'cheeni');
  expect(screen.getByLabelText('Sugar 1kg')).toBeTruthy();
  expect(screen.queryByLabelText('Maggi Noodles 70g')).toBeNull();
});

test('voice sheet parses typed Hinglish and adds lines', async () => {
  const store = await makeStore();
  await store.startFresh('Test');
  const onAdd = jest.fn();
  await wrap(store, <VoiceSheet visible onClose={() => undefined} onAdd={onAdd} />);
  await fireEvent.changeText(screen.getByLabelText('Or type it here'), 'do kilo cheeni aur teen maggi');
  expect(await screen.findByText('Sugar 1kg')).toBeTruthy();
  expect(screen.getByText('Maggi Noodles 70g')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Add to bill'));
  expect(onAdd).toHaveBeenCalledWith([
    expect.objectContaining({ qtyMilli: 2000, item: expect.objectContaining({ sku: 'sugar-1' }) }),
    expect.objectContaining({ qtyMilli: 3000, item: expect.objectContaining({ sku: 'maggi-70' }) }),
  ]);
});

test('home dashboard with demo shop shows ledger + insights', async () => {
  const store = await makeStore();
  await store.loadDemo(Date.parse('2026-11-01T12:00:00+05:30'));
  await wrap(store, <Home />);
  expect(screen.getByText('Sharma General Store')).toBeTruthy();
  expect(await screen.findByText('Tamper-proof ledger', {}, { timeout: 15000 })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('Crunching your numbers…')).toBeNull(), { timeout: 20000 });
  expect(screen.getByText('Reorder today')).toBeTruthy();
});

test('khata lists customers with balances and adds a customer', async () => {
  const store = await makeStore();
  await store.startFresh('Test');
  const c = await store.addCustomer('Ramesh');
  await store.recordUdhaar(c.customerId, 'credit', 45000);
  await wrap(store, <Khata />);
  expect(screen.getByText('Ramesh')).toBeTruthy();
  expect(screen.getAllByText('₹450').length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByLabelText('Add customer'));
  await fireEvent.changeText(screen.getByLabelText('Name'), 'Sunita');
  await fireEvent.press(screen.getByLabelText('Save'));
  await waitFor(() => expect(store.getState().customers).toHaveLength(2));
});

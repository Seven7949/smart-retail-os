import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { translate, type StringKey } from '../i18n/strings';
import type { VerifyReport } from '../domain/ledger';
import type { Insights } from '../ml/insights';
import type { State, Store } from './store';

export const StoreContext = createContext<Store | null>(null);

export function useStoreInstance(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('StoreContext missing');
  return s;
}

export function useAppState<T>(selector: (s: State) => T): T {
  const store = useStoreInstance();
  const sel = useRef(selector);
  sel.current = selector;
  return useSyncExternalStore(store.subscribe, () => sel.current(store.getState()));
}

export function useT() {
  const lang = useAppState((s) => s.settings.lang);
  return useCallback((key: StringKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
}

/** Ledger integrity check, run after interactions so saving a bill stays instant. */
export function useLedgerStatus(): VerifyReport | null {
  const store = useStoreInstance();
  const chain = useAppState((s) => s.chain);
  const key = useAppState((s) => s.settings.publicKey);
  const [value, setValue] = useState<VerifyReport | null>(null);
  useEffect(() => afterInteractions(() => setValue(store.verifyLocal('latest')), 120), [store, chain, key]);
  return value;
}

/**
 * Run heavy work after the current frame and any running transition
 * (InteractionManager was removed in RN 0.8x). Returns a cancel function.
 */
export function afterInteractions(fn: () => void, delayMs = 50): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const raf = requestAnimationFrame(() => {
    timer = setTimeout(fn, delayMs);
  });
  return () => {
    cancelAnimationFrame(raf);
    if (timer) clearTimeout(timer);
  };
}

/** Insights are computed off the critical path (after animations) and memoised by data version. */
export function useInsights(): Insights | null {
  const store = useStoreInstance();
  const version = useAppState((s) => s.version);
  const [value, setValue] = useState<Insights | null>(null);
  useEffect(() => afterInteractions(() => setValue(store.insights()), 300), [store, version]);
  return value;
}

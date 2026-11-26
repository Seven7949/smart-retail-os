/** Typed HTTPS client for the Smart Retail OS API. */
import type { Bill, ChainHead, ChainRecord, Customer, Item, UdhaarTxn } from '../domain/types';
import type { Auth } from './auth';
import type { CloudConfig } from './config';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

export interface SyncResponse {
  accepted: { seq: number; entryHash: string; signature: string }[];
  head: ChainHead | null;
  counts: Record<string, number>;
  serverTime: number;
}

export interface ScanLine { description: string; qtyMilli: number; unitPricePaise: number | null; amountPaise: number | null }
export interface ScanResult { vendor: string | null; invoiceDate: string | null; totalPaise: number | null; lines: ScanLine[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ApiClient {
  constructor(private readonly cfg: CloudConfig, private readonly auth: Auth, private readonly fetchFn: typeof fetch = fetch) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = await this.auth.idToken();
    if (!token) throw new ApiError(401, 'SIGNED_OUT', 'Please sign in to use cloud features.');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'No internet connection. Your data is safe on this phone.');
    } finally {
      clearTimeout(timer);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = isObj(json) && isObj(json.error) ? json.error : {};
      throw new ApiError(res.status, String(err.code ?? 'HTTP_' + res.status), String(err.message ?? 'Request failed'));
    }
    if (!isObj(json)) throw new ApiError(res.status, 'BAD_RESPONSE', 'Unexpected server response');
    return json as T;
  }

  sync(payload: {
    profile?: { shopName: string; digestOptIn: boolean };
    items?: readonly Item[];
    customers?: readonly Omit<Customer, 'phone'>[];
    udhaar?: readonly UdhaarTxn[];
    chain?: readonly Pick<ChainRecord, 'bill' | 'entry' | 'entryHash'>[];
  }): Promise<SyncResponse> {
    return this.request('POST', '/sync', payload);
  }

  insights(): Promise<{ insights: Record<string, unknown> }> { return this.request('GET', '/insights'); }
  refreshInsights(): Promise<{ status: string }> { return this.request('POST', '/insights/refresh', {}); }
  publicKey(): Promise<{ publicKey: string }> { return this.request('GET', '/ledger/public-key'); }
  verifyLedger(): Promise<{ valid: boolean; checked: number; failure?: { seq: number; code: string } }> {
    return this.request('GET', '/ledger/verify');
  }

  voiceParse(text: string, catalog: readonly Pick<Item, 'sku' | 'name' | 'unit'>[]): Promise<{ lines: { sku: string; qtyMilli: number }[] }> {
    return this.request('POST', '/voice/parse', { text, catalog: catalog.map((c) => ({ sku: c.sku, name: c.name, unit: c.unit })) });
  }

  async scanInvoice(fileUri: string, contentType: 'image/jpeg' | 'image/png'): Promise<ScanResult> {
    const up = await this.request<{ key: string; url: string; fields: Record<string, string> }>('POST', '/scan/upload-url', { contentType });
    if (!/^https:\/\//.test(up.url)) throw new ApiError(0, 'BAD_UPLOAD_URL', 'Unexpected upload URL');
    const form = new FormData();
    Object.entries(up.fields).forEach(([k, v]) => form.append(k, v));
    form.append('file', { uri: fileUri, name: `invoice.${contentType === 'image/png' ? 'png' : 'jpg'}`, type: contentType } as unknown as Blob);
    const res = await this.fetchFn(up.url, { method: 'POST', body: form });
    if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', 'Could not upload the photo (max 5 MB).');
    return this.request('POST', '/scan/parse', { key: up.key });
  }
}

/** Strip on-device-only fields before data leaves the phone (privacy by design). */
export const toCloudCustomer = ({ phone: _phone, ...rest }: Customer) => rest;
export const chainForSync = (r: ChainRecord) => ({ bill: r.bill as Bill, entry: r.entry, entryHash: r.entryHash });

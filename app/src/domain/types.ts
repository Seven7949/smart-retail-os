/** Core domain types. Money is integer paise; quantities are integer milli-units. */

export type Unit = 'pcs' | 'kg' | 'l';
export type PaymentMode = 'cash' | 'upi' | 'udhaar';

export interface Item {
  readonly sku: string;
  readonly name: string;
  readonly hi?: string;
  readonly aliases?: readonly string[];
  readonly category: string;
  readonly unit: Unit;
  readonly pricePaise: number;
  readonly costPaise: number;
  readonly stockMilli: number;
  readonly leadTimeDays: number;
  readonly packSize: number;
  readonly shelfLifeDays: number;
  readonly festivalLift: number;
}

export interface BillLine {
  readonly sku: string;
  readonly qtyMilli: number;
  readonly unitPricePaise: number;
}

/** Exactly the fields that are hashed into the ledger (docs/LEDGER_SPEC.md). */
export interface Bill {
  readonly billId: string;
  readonly createdAt: number;
  readonly customerId: string | null;
  readonly items: readonly BillLine[];
  readonly paymentMode: PaymentMode;
  readonly totalPaise: number;
}

export interface LedgerEntry {
  readonly billId: string;
  readonly payloadHash: string;
  readonly prevHash: string;
  readonly seq: number;
  readonly shopId: string;
  readonly timestamp: number;
}

export interface ChainRecord {
  readonly bill: Bill;
  readonly entry: LedgerEntry;
  readonly entryHash: string;
  /** Ed25519 signature from the cloud signer; null until synced. */
  readonly signature: string | null;
}

export interface Customer {
  readonly customerId: string;
  readonly name: string;
  /** Stays on the device only (never synced). */
  readonly phone?: string;
  readonly creditLimitPaise?: number;
  readonly remindersSent?: number;
}

export interface UdhaarTxn {
  readonly id: string;
  readonly customerId: string;
  readonly kind: 'credit' | 'payment';
  readonly amountPaise: number;
  readonly ts: number;
  readonly billId?: string;
  readonly synced?: boolean;
}

export interface ChainHead {
  readonly seq: number;
  readonly entryHash: string;
}

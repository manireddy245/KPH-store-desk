import type { Q } from '../db/connect.js';

export interface StoreSettings {
  storeName: string;
  storeAddress: string;
  /** Town and PIN code of the shop (e-way bills). */
  storePlace: string;
  storePincode: string;
  storePhone: string;
  storeGstin: string;
  stateCode: string;
  stateName: string;
  invoicePrefix: string;
  receiptPrefix: string;
  invoiceTerms: string;
  /** Default low-stock level for products without their own reorder level. */
  lowStockThresholdMilli: number;
  idleLockMinutes: number;
  discountHintEnabled: boolean;
  allowNegativeStock: boolean;
  /** Hour (0–23, India time) for the automatic daily backup. */
  autoBackupHour: number;
  geminiApiKey: string;
  /** Gemini model used by the invoice scanner; change it here when Google retires a model. */
  geminiModel: string;
  purchasePrefix: string;
  paymentPrefix: string;
  expensePrefix: string;
  contraPrefix: string;
  journalPrefix: string;
  /** Go-live date: opening balances are as at the start of this day. */
  openingDate: string;
  /** Set once the opening balances are confirmed; they can't be changed after that. */
  openingLocked: boolean;
  /** Company name exactly as in the CA's Tally (blank = shop name). */
  tallyCompanyName: string;
  /** Default for new bill lines: price typed excluding or including GST. */
  salesPriceMode: 'excl' | 'incl';
  /** Default for purchase lines. */
  purchasePriceMode: 'excl' | 'incl';
  /** Invoice labels: English, or Telugu + English. */
  invoiceLabels: 'en' | 'te-en';
  creditNotePrefix: string;
  debitNotePrefix: string;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  storeName: 'Kanakapatnam Paints and Hardwares',
  storeAddress: 'Kavali, Andhra Pradesh',
  storePlace: 'Kavali',
  storePincode: '524201',
  storePhone: '',
  storeGstin: '',
  stateCode: '37',
  stateName: 'Andhra Pradesh',
  invoicePrefix: 'KPH',
  receiptPrefix: 'RCT',
  invoiceTerms: 'Goods once sold will not be taken back without the bill. Subject to Kavali jurisdiction.',
  lowStockThresholdMilli: 5000,
  idleLockMinutes: 5,
  discountHintEnabled: true,
  allowNegativeStock: false,
  autoBackupHour: 21,
  geminiApiKey: '',
  geminiModel: 'gemini-3.8-flash',
  purchasePrefix: 'PUR',
  paymentPrefix: 'PAY',
  expensePrefix: 'EXP',
  contraPrefix: 'CTR',
  journalPrefix: 'JRN',
  openingDate: '',
  openingLocked: false,
  tallyCompanyName: '',
  salesPriceMode: 'excl',
  purchasePriceMode: 'excl',
  invoiceLabels: 'te-en',
  creditNotePrefix: 'CN',
  debitNotePrefix: 'DN',
};

/** Never included in backups or sent to non-admin screens. */
export const SECRET_SETTINGS: (keyof StoreSettings)[] = ['geminiApiKey'];

export async function getSettings(q: Q): Promise<StoreSettings> {
  const rows = await q<{ key: string; value: unknown }[]>`select key, value from settings`;
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) s[r.key] = r.value;
  return s as unknown as StoreSettings;
}

export async function setSettings(q: Q, patch: Partial<StoreSettings>) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
    await q`
      insert into settings (key, value, updated_at) values (${key}, ${q.json(value as never)}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
}

export function publicSettings(s: StoreSettings) {
  const { geminiApiKey, ...rest } = s;
  return { ...rest, geminiApiKeySet: !!geminiApiKey };
}

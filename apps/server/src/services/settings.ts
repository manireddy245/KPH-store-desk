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
  /** No longer used: the daily backup is made at closing time (kept so old saved settings still load). */
  autoBackupHour: number;
  geminiApiKey: string;
  /** Gemini model used by the invoice scanner; change it here when Google retires a model. */
  geminiModel: string;
  /** How long Gemini "thinks" before answering (Gemini 3 models): lower is faster. */
  geminiThinking: 'minimal' | 'low' | 'medium' | 'high';
  purchasePrefix: string;
  paymentPrefix: string;
  expensePrefix: string;
  contraPrefix: string;
  journalPrefix: string;
  quotePrefix: string;
  challanPrefix: string;
  /** Cement older than this many days (from packing / receipt) is flagged. */
  oldStockDays: number;
  quoteValidDays: number;
  /** Stock insights: sales period looked at, days without a sale for "dead", default target days and supplier lead time. */
  /** Second backup location (USB drive, another PC's shared folder, or a Google Drive / OneDrive folder). */
  backupCopyDir: string;
  /** Passphrase that encrypts the copies. Never backed up or shown. */
  backupPassphrase: string;
  /** Closing time (India time, HH:MM): the daily backup and the owner's summary are made then. */
  shopCloseTime: string;
  /** Owner's WhatsApp number and e-mail for the daily summary (optional). */
  ownerPhone: string;
  ownerEmail: string;
  insightDays: number;
  deadStockDays: number;
  targetDaysDefault: number;
  leadDaysDefault: number;
  poPrefix: string;
  auditPrefix: string;
  /** Go-live date: opening balances are as at the start of this day. */
  openingDate: string;
  /** Set once the opening balances are confirmed; they can't be changed after that. */
  openingLocked: boolean;
  /** Company name exactly as in the CA's Tally (blank = shop name). */
  tallyCompanyName: string;
  /** Days of credit before a bill counts as overdue (each customer can have their own). 0 = no due dates. */
  creditDaysDefault: number;
  /** Language of WhatsApp reminders unless the customer has their own. */
  reminderLanguage: 'te' | 'en';
  /** Shop UPI ID, added to reminders as a pay link (optional). */
  storeUpiId: string;
  /** Default for new bill lines: price typed excluding or including GST. */
  salesPriceMode: 'excl' | 'incl';
  /** Default for purchase lines. */
  purchasePriceMode: 'excl' | 'incl';
  /** Invoice labels: English, or Telugu + English. */
  invoiceLabels: 'en' | 'te-en';
  /** Show the "Authorised dealers for" brand logos at the foot of every bill. */
  invoiceShowBrands: boolean;
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
  geminiThinking: 'low',
  purchasePrefix: 'PUR',
  paymentPrefix: 'PAY',
  expensePrefix: 'EXP',
  contraPrefix: 'CTR',
  journalPrefix: 'JRN',
  quotePrefix: 'QTN',
  challanPrefix: 'DC',
  oldStockDays: 60,
  quoteValidDays: 15,
  backupCopyDir: '',
  backupPassphrase: '',
  shopCloseTime: '20:30',
  ownerPhone: '9440930271',
  ownerEmail: 'malyadrireddy.munagala@gmail.com',
  insightDays: 30,
  deadStockDays: 60,
  targetDaysDefault: 15,
  leadDaysDefault: 3,
  poPrefix: 'PO',
  auditPrefix: 'SA',
  openingDate: '',
  openingLocked: false,
  tallyCompanyName: '',
  creditDaysDefault: 0,
  reminderLanguage: 'te',
  storeUpiId: '',
  salesPriceMode: 'excl',
  purchasePriceMode: 'excl',
  invoiceLabels: 'te-en',
  invoiceShowBrands: true,
  creditNotePrefix: 'CN',
  debitNotePrefix: 'DN',
};

/** Never included in backups or sent to non-admin screens. */
export const SECRET_SETTINGS: (keyof StoreSettings)[] = ['geminiApiKey', 'backupPassphrase'];

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
  const { geminiApiKey, backupPassphrase, ...rest } = s;
  return { ...rest, geminiApiKeySet: !!geminiApiKey, backupPassphraseSet: !!backupPassphrase };
}

import type { Q } from '../db/connect.js';

export interface StoreSettings {
  storeName: string;
  storeAddress: string;
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
}

export const DEFAULT_SETTINGS: StoreSettings = {
  storeName: 'Kanakapatnam Paints and Hardwares',
  storeAddress: 'Kavali, Andhra Pradesh',
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

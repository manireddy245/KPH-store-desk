import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Sql } from '../db/connect.js';
import { schemaVersion } from '../db/migrate.js';
import { SECRET_SETTINGS } from './settings.js';

/**
 * Backups are a gzipped JSON copy of every table. The Gemini key (and other
 * secrets) are left out. Phase 7 adds encryption and copying to a second location.
 * Order matters for readability only: restore disables triggers and FK checks.
 */
export const BACKUP_TABLES = [
  'settings', 'roles', 'users', 'devices', 'units', 'categories', 'brands', 'products', 'price_history',
  'ledger_groups', 'ledgers', 'customers', 'suppliers', 'vouchers', 'voucher_lines', 'doc_sequences', 'overrides',
  'audit_log', 'stock_movements', 'stock_balances', 'sales_invoices', 'sales_invoice_lines', 'receipts', 'bill_drafts',
  'purchase_scans', 'purchase_invoices', 'purchase_lines', 'product_aliases',
  'product_units', 'credit_notes', 'credit_note_lines', 'debit_notes', 'debit_note_lines', 'gst_periods',
  'assistant_messages', 'invoice_transport', 'money_entries', 'payment_allocations', 'cash_closings',
  'partner_types', 'partner_reward_rules', 'partners', 'partner_sites', 'invoice_partners', 'partner_rewards', 'partner_notes', 'paint_shades',
  'tally_names', 'tally_exports',
  'receipt_allocations', 'reminders',
] as const;

const FORMAT = 'kph-storedesk-backup';
const KEEP_AUTO = 30;

export interface BackupFile {
  format: typeof FORMAT;
  version: 1;
  schema: string | null;
  workspace: string;
  createdAt: string;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
}

export async function createBackupData(owner: Sql, workspace: string): Promise<BackupFile> {
  return owner.begin('isolation level repeatable read read only', async (tx) => {
    const tables: Record<string, unknown[]> = {};
    for (const t of BACKUP_TABLES) {
      const rows = await tx.unsafe(`select * from ${t} order by 1`);
      tables[t] = t === 'settings' ? rows.filter((r) => !(SECRET_SETTINGS as string[]).includes(r.key)) : [...rows];
    }
    return {
      format: FORMAT,
      version: 1,
      schema: await schemaVersion(tx as unknown as Sql),
      workspace,
      createdAt: new Date().toISOString(),
      counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
      tables,
    };
  }) as Promise<BackupFile>;
}

export async function writeBackup(owner: Sql, workspace: string, dir: string, kind: 'auto' | 'manual' | 'pre-restore') {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `storedesk-${workspace}-${stamp}-${kind}.json.gz`;
  try {
    const data = await createBackupData(owner, workspace);
    const buf = gzipSync(Buffer.from(JSON.stringify(data)));
    writeFileSync(join(dir, file), buf);
    await owner`insert into backups_log (kind, file, size_bytes, ok) values (${kind}, ${file}, ${buf.length}, true)`;
    if (kind === 'auto') pruneAutoBackups(dir);
    return { file, sizeBytes: buf.length, counts: data.counts };
  } catch (e) {
    await owner`insert into backups_log (kind, file, ok, error) values (${kind}, ${file}, false, ${String((e as Error).message)})`;
    throw e;
  }
}

function pruneAutoBackups(dir: string) {
  const autos = readdirSync(dir).filter((f) => f.endsWith('-auto.json.gz')).sort();
  for (const f of autos.slice(0, Math.max(0, autos.length - KEEP_AUTO))) unlinkSync(join(dir, f));
}

export function listBackupFiles(dir: string) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => ({ file: f, sizeBytes: statSync(join(dir, f)).size, at: statSync(join(dir, f)).mtime }))
      .sort((a, b) => b.at.getTime() - a.at.getTime());
  } catch {
    return [];
  }
}

export function readBackup(buf: Buffer): BackupFile {
  let data: BackupFile;
  try {
    const text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not a Store Desk backup (could not read it)');
  }
  if (data.format !== FORMAT) throw new Error('This file is not a Store Desk backup');
  return data;
}

/**
 * Replace ALL data in the database with the backup. The caller makes a
 * "pre-restore" backup first. Secret settings (Gemini key) on this computer are kept.
 */
export async function restoreBackupData(owner: Sql, data: BackupFile) {
  const current = await schemaVersion(owner);
  if (data.schema && current && data.schema > current) {
    throw new Error(`This backup is from a newer version of Store Desk (${data.schema}). Update the app first.`);
  }
  await owner.begin(async (tx) => {
    const secrets = await tx`select key, value from settings where key in ${tx(SECRET_SETTINGS as string[])}`;
    await tx.unsafe(`set local session_replication_role = replica`);
    await tx.unsafe(`truncate ${[...BACKUP_TABLES, 'sessions'].join(', ')} restart identity cascade`);
    for (const t of BACKUP_TABLES) {
      const rows = (data.tables[t] ?? []) as Record<string, unknown>[];
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await tx`insert into ${tx(t)} ${tx(chunk as never)}`;
      }
    }
    for (const s of secrets) {
      await tx`insert into settings (key, value) values (${s.key}, ${tx.json(s.value)}) on conflict (key) do update set value = excluded.value`;
    }
    // Move every id sequence past the restored rows.
    const seqs = await tx<{ table_name: string; column_name: string; seq: string }[]>`
      select c.table_name, c.column_name, pg_get_serial_sequence(c.table_name, c.column_name) as seq
      from information_schema.columns c
      where c.table_schema = 'public' and pg_get_serial_sequence(c.table_name, c.column_name) is not null`;
    for (const s of seqs) {
      await tx.unsafe(
        `select setval('${s.seq}', coalesce((select max(${s.column_name}) from ${s.table_name}), 1), (select max(${s.column_name}) from ${s.table_name}) is not null)`,
      );
    }
  });
  return data.counts;
}

export function readBackupFile(path: string) {
  return readBackup(readFileSync(path));
}

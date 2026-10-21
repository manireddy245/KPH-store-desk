import type { Sql } from '../db/connect.js';
import { BACKUP_TABLES } from './backup.js';

/**
 * Start the books again from zero, keeping the setup: users and PINs, approved computers and phones,
 * shop settings (incl. the Gemini key), units, categories, brands, partner types and reward rules, paint
 * shades, Tally names, and the non-party ledgers (cash, bank, sales, GST, expenses — opening balances set
 * to zero). Everything else goes: bills, quotations, purchases, payments, stock, products (except the
 * built-in "Shipping charges"), customers, suppliers, partners and the activity log. Bill numbers restart.
 *
 * Runs as the database owner with triggers off, because the permanent-record guards forbid deleting
 * bills. Take a backup first (the CLI does).
 */
const KEEP = new Set<string>([
  'settings', 'roles', 'users', 'devices', 'units', 'categories', 'brands', 'ledger_groups',
  'partner_types', 'partner_reward_rules', 'paint_shades', 'tally_names',
  'ledgers', 'products', // only partly cleared, below
]);

export async function clearBooks(owner: Sql, byUserId: number | null) {
  return owner.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const counts: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      if (KEEP.has(t)) continue;
      const r = await tx.unsafe(`delete from ${t}`);
      if (r.count) counts[t] = r.count;
    }
    const p = await tx`delete from products where upper(sku) <> 'SHIPPING'`;
    if (p.count) counts.products = p.count;
    const l = await tx`delete from ledgers where party_type is not null`;
    if (l.count) counts.party_ledgers = l.count;
    await tx`update ledgers set opening_dr_paise = 0 where opening_dr_paise <> 0`;
    await tx`insert into audit_log (user_id, action, details) values (${byUserId}, 'data.cleared', ${tx.json({ deleted: counts })})`;
    return counts;
  });
}

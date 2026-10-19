import { isValidGstin, stateFromGstin } from '@kph/core';
import type { Q, Sql } from '../db/connect.js';
import { AppError, audit, requirePerm, type Ctx } from './common.js';
import { createPartyLedger } from './ledger.js';

export interface CustomerInput {
  name?: string;
  phone?: string | null;
  gstin?: string | null;
  address?: string | null;
  stateCode?: string;
  creditLimitPaise?: number | null;
  notes?: string | null;
  active?: boolean;
  /** Only when creating: amount they already owe us (negative = advance). */
  openingBalancePaise?: number;
}

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const clean = (s: string | null | undefined) => (s == null ? null : s.trim() || null);

function validateParty(input: { name?: string; phone?: string | null; gstin?: string | null }) {
  if (input.name !== undefined && input.name.trim().length < 2) throw new AppError(400, 'BAD_NAME', 'Name is too short');
  if (input.phone && !/^[+\d][\d\s-]{6,15}$/.test(input.phone.trim())) throw new AppError(400, 'BAD_PHONE', 'Phone number does not look right');
  if (input.gstin && !GSTIN_RE.test(input.gstin.trim().toUpperCase())) throw new AppError(400, 'BAD_GSTIN', 'GSTIN should be 15 characters, e.g. 37ABCDE1234F1Z5');
  if (input.gstin && !isValidGstin(input.gstin)) throw new AppError(400, 'BAD_GSTIN', 'This GSTIN is not valid (its last character does not check out). Please check it on the bill or the GST portal.');
}

export async function listCustomers(q: Q, f: { search?: string; withBalanceOnly?: boolean; includeInactive?: boolean; id?: number } = {}) {
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  return q`
    select * from (
      select c.id, c.name, c.phone, c.gstin, c.address, c.state_code, c.credit_limit_paise, c.notes, c.active, c.is_sample,
             c.created_at, c.ledger_id,
             l.opening_dr_paise + coalesce(vl.bal, 0) as balance_paise,
             coalesce(si.total, 0) as total_purchases_paise,
             coalesce(si.n, 0) as bill_count,
             si.last_bill_at
      from customers c
      left join ledgers l on l.id = c.ledger_id
      left join (select ledger_id, sum(dr_paise - cr_paise) as bal from voucher_lines group by ledger_id) vl on vl.ledger_id = c.ledger_id
      left join (select customer_id, sum(total_paise) as total, count(*)::int as n, max(at) as last_bill_at
                 from sales_invoices where status = 'posted' group by customer_id) si on si.customer_id = c.id
      where (${f.includeInactive ?? false} or c.active)
        and (${f.id ?? null}::int is null or c.id = ${f.id ?? null})
        and (${search}::text is null or lower(c.name) like ${search} or coalesce(c.phone, '') like ${search})
    ) x
    where (not ${f.withBalanceOnly ?? false} or balance_paise <> 0)
    order by lower(name)
    limit 2000`;
}

export async function createCustomer(sql: Sql, ctx: Ctx, input: CustomerInput & { name: string }, opts: { isSample?: boolean } = {}) {
  requirePerm(ctx, 'customers.manage');
  validateParty(input);
  if (input.creditLimitPaise != null && input.creditLimitPaise < 0) throw new AppError(400, 'BAD_LIMIT', 'Credit limit cannot be negative');
  if (input.openingBalancePaise && !ctx.permissions.includes('settings.manage') && !opts.isSample)
    throw new AppError(403, 'FORBIDDEN', 'Only admin can enter an opening balance');
  return sql.begin(async (tx) => {
    if (input.phone) {
      const [dup] = await tx<{ name: string }[]>`select name from customers where phone = ${input.phone.trim()} and active limit 1`;
      if (dup) throw new AppError(409, 'DUPLICATE_PHONE', `${dup.name} already has this phone number`);
    }
    const [c] = await tx<{ id: number }[]>`
      insert into customers (name, phone, gstin, address, state_code, credit_limit_paise, notes, is_sample)
      values (${input.name.trim()}, ${clean(input.phone)}, ${clean(input.gstin)?.toUpperCase() ?? null}, ${clean(input.address)},
              ${input.stateCode ?? stateFromGstin(clean(input.gstin)) ?? '37'}, ${input.creditLimitPaise ?? null}, ${clean(input.notes)}, ${opts.isSample ?? false})
      returning id`;
    const id = c!.id;
    const ledgerId = await createPartyLedger(tx, 'customer', id, input.name.trim(), input.openingBalancePaise ?? 0);
    await tx`update customers set ledger_id = ${ledgerId} where id = ${id}`;
    await audit(tx, ctx, 'customer.created', { entity: 'customer', entityId: id, details: { name: input.name, phone: input.phone, openingBalancePaise: input.openingBalancePaise ?? 0 } });
    return { id };
  });
}

export async function updateCustomer(sql: Sql, ctx: Ctx, id: number, input: CustomerInput) {
  requirePerm(ctx, 'customers.manage');
  if (input.openingBalancePaise !== undefined) throw new AppError(400, 'NO_OPENING_EDIT', 'Opening balance cannot be changed here');
  if (input.creditLimitPaise !== undefined) requirePerm(ctx, 'settings.manage', 'Only admin can change credit limits');
  validateParty(input);
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.phone !== undefined) set.phone = clean(input.phone);
  if (input.gstin !== undefined) set.gstin = clean(input.gstin)?.toUpperCase() ?? null;
  if (input.address !== undefined) set.address = clean(input.address);
  if (input.stateCode !== undefined) set.state_code = input.stateCode;
  else if (set.gstin) set.state_code = stateFromGstin(set.gstin as string);
  if (input.creditLimitPaise !== undefined) set.credit_limit_paise = input.creditLimitPaise;
  if (input.notes !== undefined) set.notes = clean(input.notes);
  if (input.active !== undefined) set.active = input.active;
  if (!Object.keys(set).length) return { id };
  return sql.begin(async (tx) => {
    const [c] = await tx<{ ledger_id: number }[]>`update customers set ${tx(set)} where id = ${id} returning ledger_id`;
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    if (set.name) await tx`update ledgers set name = ${set.name as string} where id = ${c.ledger_id}`;
    await audit(tx, ctx, 'customer.updated', { entity: 'customer', entityId: id, details: input as Record<string, unknown> });
    return { id };
  });
}

/** Customer statement: every bill, payment and cancellation with running balance. */
export async function customerStatement(q: Q, id: number) {
  const [c] = await listCustomers(q, { id, includeInactive: true });
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  const [opening] = await q<{ opening: number }[]>`select opening_dr_paise as opening from ledgers where id = ${c.ledger_id}`;
  const entries = await q`
    select v.id, v.vdate, v.vtype, v.narration, v.created_at, vl.dr_paise, vl.cr_paise, v.ref_type, v.ref_id,
           sum(vl.dr_paise - vl.cr_paise) over (order by v.created_at, v.id) + ${opening?.opening ?? 0} as running_paise
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id
    where vl.ledger_id = ${c.ledger_id}
    order by v.created_at, v.id`;
  const invoices = await q`
    select id, number, invoice_date, payment_mode, total_paise, status from sales_invoices where customer_id = ${id} order by id desc limit 200`;
  const receipts = await q`
    select r.id, r.number, r.receipt_date, r.mode, r.amount_paise, r.reference, r.status, u.name as user_name
    from receipts r join users u on u.id = r.user_id where customer_id = ${id} order by r.id desc limit 200`;
  return { customer: c, openingPaise: opening?.opening ?? 0, entries, invoices, receipts };
}

// ------------------------------------------------------------------ suppliers

export interface SupplierInput {
  name?: string;
  phone?: string | null;
  category?: string | null;
  gstin?: string | null;
  address?: string | null;
  leadTimeDays?: number | null;
  active?: boolean;
  openingBalancePaise?: number;
}

export async function listSuppliers(q: Q, f: { search?: string; includeInactive?: boolean } = {}) {
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  return q`
    select s.*, -(l.opening_dr_paise + coalesce((select sum(dr_paise - cr_paise) from voucher_lines where ledger_id = s.ledger_id), 0)) as payable_paise
    from suppliers s left join ledgers l on l.id = s.ledger_id
    where (${f.includeInactive ?? false} or s.active)
      and (${search}::text is null or lower(s.name) like ${search} or coalesce(s.phone, '') like ${search} or lower(coalesce(s.category, '')) like ${search})
    order by lower(s.name)`;
}

export async function createSupplier(sql: Sql, ctx: Ctx, input: SupplierInput & { name: string }, opts: { isSample?: boolean } = {}) {
  requirePerm(ctx, 'suppliers.manage');
  validateParty(input);
  return sql.begin(async (tx) => {
    const [s] = await tx<{ id: number }[]>`
      insert into suppliers (name, phone, category, gstin, address, lead_time_days, is_sample)
      values (${input.name.trim()}, ${clean(input.phone)}, ${clean(input.category)}, ${clean(input.gstin)?.toUpperCase() ?? null},
              ${clean(input.address)}, ${input.leadTimeDays ?? null}, ${opts.isSample ?? false})
      returning id`;
    // Supplier ledger: what we owe is a credit balance.
    const ledgerId = await createPartyLedger(tx, 'supplier', s!.id, input.name.trim(), -(input.openingBalancePaise ?? 0));
    await tx`update suppliers set ledger_id = ${ledgerId} where id = ${s!.id}`;
    await audit(tx, ctx, 'supplier.created', { entity: 'supplier', entityId: s!.id, details: { name: input.name } });
    return { id: s!.id };
  });
}

export async function updateSupplier(sql: Sql, ctx: Ctx, id: number, input: SupplierInput) {
  requirePerm(ctx, 'suppliers.manage');
  validateParty(input);
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.phone !== undefined) set.phone = clean(input.phone);
  if (input.category !== undefined) set.category = clean(input.category);
  if (input.gstin !== undefined) set.gstin = clean(input.gstin)?.toUpperCase() ?? null;
  if (input.address !== undefined) set.address = clean(input.address);
  if (input.leadTimeDays !== undefined) set.lead_time_days = input.leadTimeDays;
  if (input.active !== undefined) set.active = input.active;
  if (!Object.keys(set).length) return { id };
  return sql.begin(async (tx) => {
    const [s] = await tx<{ ledger_id: number }[]>`update suppliers set ${tx(set)} where id = ${id} returning ledger_id`;
    if (!s) throw new AppError(404, 'NOT_FOUND', 'Supplier not found');
    if (set.name) await tx`update ledgers set name = ${set.name as string} where id = ${s.ledger_id}`;
    await audit(tx, ctx, 'supplier.updated', { entity: 'supplier', entityId: id, details: input as Record<string, unknown> });
    return { id };
  });
}

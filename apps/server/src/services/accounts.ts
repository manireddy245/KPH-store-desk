import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fyStartYear, isValidGstin, istDate, mulDivRound, settleOldestFirst } from '@kph/core';
import type { Q, Sql, Tx } from '../db/connect.js';
import { consumeOverride } from './auth.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';
import { nextDocNumber, postVoucher, reverseVoucher, systemLedgerIds } from './ledger.js';
import { getSettings, setSettings } from './settings.js';

/**
 * Phase 3A money books: bank accounts and expense heads, supplier payments, expenses,
 * contra (cash ↔ bank, UPI/card settlement), journals, Day/Cash/Bank books, ledger
 * statements, trial balance, supplier ageing, daily cash closing and opening balances.
 * Every entry posts a balanced voucher; nothing is deleted — cancelling posts the reverse.
 */

export type LedgerKind = 'cash' | 'bank' | 'clearing' | 'expense' | 'income' | 'capital' | 'other';
const MONEY_KINDS: LedgerKind[] = ['cash', 'bank', 'clearing'];

// ------------------------------------------------------------------ ledgers

export async function listLedgers(q: Q, f: { kind?: LedgerKind; includeParties?: boolean; asOf?: string } = {}) {
  return q<{ id: number; name: string; group_id: number; group_name: string; nature: string; kind: LedgerKind | null; system_code: string | null; party_type: string | null; party_id: number | null; opening_dr_paise: number; balance_paise: number; active: boolean; details: Record<string, string> }[]>`
    select l.id, l.name, l.group_id, g.name as group_name, g.nature, l.kind, l.system_code, l.party_type, l.party_id, l.opening_dr_paise, l.active, l.details,
           l.opening_dr_paise + coalesce((select sum(vl.dr_paise - vl.cr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id
                                          where vl.ledger_id = l.id and (${f.asOf ?? null}::date is null or v.vdate <= ${f.asOf ?? null}::date)), 0) as balance_paise
    from ledgers l join ledger_groups g on g.id = l.group_id
    where (${f.kind ?? null}::text is null or l.kind = ${f.kind ?? null})
      and (${f.includeParties ?? false} or l.party_type is null)
    order by g.name, lower(l.name)`;
}

export async function listGroups(q: Q) {
  return q<{ id: number; name: string; nature: string }[]>`select id, name, nature from ledger_groups order by name`;
}

export async function createLedger(sql: Sql, ctx: Ctx, input: { name: string; groupId?: number; kind: LedgerKind; details?: Record<string, string> }) {
  requirePerm(ctx, 'accounts.manage');
  const name = input.name?.trim() ?? '';
  if (name.length < 2) throw new AppError(400, 'NAME_REQUIRED', 'Give the account a name');
  const defaultGroup = input.kind === 'bank' ? 'Bank Accounts' : input.kind === 'cash' ? 'Cash-in-Hand' : input.kind === 'expense' ? 'Indirect Expenses' : input.kind === 'income' ? 'Indirect Incomes' : null;
  const [g] = input.groupId
    ? await sql<{ id: number }[]>`select id from ledger_groups where id = ${input.groupId}`
    : await sql<{ id: number }[]>`select id from ledger_groups where name = ${defaultGroup}`;
  if (!g) throw new AppError(400, 'NO_GROUP', 'Choose a group');
  const [dup] = await sql`select 1 from ledgers where lower(name) = ${name.toLowerCase()}`;
  if (dup) throw new AppError(409, 'DUPLICATE', `An account called "${name}" already exists`);
  const [l] = await sql<{ id: number }[]>`
    insert into ledgers (name, group_id, kind, details) values (${name}, ${g.id}, ${input.kind}, ${sql.json(input.details ?? {})}) returning id`;
  await audit(sql, ctx, 'ledger.created', { entity: 'ledger', entityId: l!.id, details: { name, kind: input.kind } });
  return { id: l!.id };
}

export async function updateLedger(sql: Sql, ctx: Ctx, id: number, input: { name?: string; active?: boolean; details?: Record<string, string> }) {
  requirePerm(ctx, 'accounts.manage');
  const [l] = await sql<{ id: number; name: string; system_code: string | null; party_type: string | null }[]>`select id, name, system_code, party_type from ledgers where id = ${id}`;
  if (!l) throw new AppError(404, 'NOT_FOUND', 'Account not found');
  if (l.party_type) throw new AppError(400, 'PARTY_LEDGER', 'Customer and supplier accounts are changed from their own screens');
  if (input.active === false && l.system_code) throw new AppError(400, 'SYSTEM_LEDGER', 'This account is used by the app and cannot be hidden');
  await sql`update ledgers set name = coalesce(${input.name?.trim() || null}, name), active = coalesce(${input.active ?? null}, active),
            details = coalesce(${input.details ? sql.json(input.details) : null}, details) where id = ${id}`;
  await audit(sql, ctx, 'ledger.updated', { entity: 'ledger', entityId: id, details: { from: l.name, ...input } });
  return { id };
}

async function moneyLedger(q: Q, id: number, what = 'Paid from') {
  const [l] = await q<{ id: number; name: string; kind: LedgerKind | null; active: boolean }[]>`select id, name, kind, active from ledgers where id = ${id}`;
  if (!l || !l.kind || !MONEY_KINDS.includes(l.kind)) throw new AppError(400, 'BAD_ACCOUNT', `${what}: choose cash or a bank account`);
  if (!l.active) throw new AppError(400, 'INACTIVE', `${l.name} is hidden`);
  return l;
}

// ------------------------------------------------------------------ money entries

type Kind = 'payment' | 'expense' | 'contra' | 'journal';
const PREFIX: Record<Kind, 'paymentPrefix' | 'expensePrefix' | 'contraPrefix' | 'journalPrefix'> = { payment: 'paymentPrefix', expense: 'expensePrefix', contra: 'contraPrefix', journal: 'journalPrefix' };

interface EntryCommon {
  clientRef?: string;
  date?: string;
  reference?: string;
  narration?: string;
}

/** Entries may be back-dated (an expense paid yesterday), but not into the future or before the opening date. */
async function entryDate(q: Q, d: string | undefined) {
  const today = istDate();
  const date = d ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'BAD_DATE', 'Enter a valid date');
  if (date > today) throw new AppError(400, 'FUTURE_DATE', 'The date cannot be in the future');
  const s = await getSettings(q);
  if (s.openingDate && date < s.openingDate) throw new AppError(400, 'BEFORE_OPENING', `The books start on ${s.openingDate}`);
  return date;
}

async function insertEntry(
  tx: Tx,
  ctx: Ctx,
  kind: Kind,
  date: string,
  fields: Record<string, unknown> & { amount_paise: number },
  voucher: { narration: string; lines: { ledgerId: number; amountPaise: number }[] },
  clientRef?: string,
) {
  const s = await getSettings(tx);
  const fy = fyStartYear(new Date(`${date}T12:00:00+05:30`));
  const { seq, number } = await nextDocNumber(tx, kind, s[PREFIX[kind]], fy);
  const [{ id }] = (await tx<{ id: number }[]>`select nextval('money_entries_id_seq')::bigint as id`) as unknown as [{ id: number }];
  const voucherId = await postVoucher(tx, ctx, { vtype: kind, vdate: date, narration: `${number} ${voucher.narration}`.trim(), refType: 'money_entry', refId: id, lines: voucher.lines });
  await tx`insert into money_entries ${tx({ id, number, fy_start: fy, seq, kind, entry_date: date, voucher_id: voucherId, user_id: ctx.userId, device_id: ctx.deviceId, client_ref: clientRef ?? null, ...fields } as never)}`;
  await audit(tx, ctx, `${kind}.created`, { entity: 'money_entry', entityId: id, details: { number, amountPaise: fields.amount_paise } });
  return { id, number };
}

async function existing(tx: Tx, clientRef?: string) {
  if (!clientRef) return null;
  const [e] = await tx<{ id: number; number: string }[]>`select id, number from money_entries where client_ref = ${clientRef}`;
  return e ?? null;
}

const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

// ---------------- supplier payments

export async function outstandingPurchases(q: Q, supplierId: number) {
  return q<{ id: number; number: string; supplier_invoice_no: string; supplier_invoice_date: string; total_paise: number; paid_paise: number; returned_paise: number; due_paise: number }[]>`
    select p.id, p.number, p.supplier_invoice_no, p.supplier_invoice_date, p.total_paise,
           coalesce((select sum(a.amount_paise) from payment_allocations a join money_entries m on m.id = a.entry_id
                     where a.purchase_id = p.id and m.status = 'posted'), 0) as paid_paise,
           coalesce((select sum(d.total_paise) from debit_notes d where d.purchase_id = p.id and d.status = 'posted'), 0) as returned_paise,
           p.total_paise
             - coalesce((select sum(a.amount_paise) from payment_allocations a join money_entries m on m.id = a.entry_id where a.purchase_id = p.id and m.status = 'posted'), 0)
             - coalesce((select sum(d.total_paise) from debit_notes d where d.purchase_id = p.id and d.status = 'posted'), 0) as due_paise
    from purchase_invoices p
    where p.supplier_id = ${supplierId} and p.status = 'posted'
    order by p.supplier_invoice_date, p.id`;
}

/** Unpaid supplier bills with what is really still open after on-account payments (oldest first). */
export async function openPurchases(q: Q, supplierId: number) {
  const bills = await outstandingPurchases(q, supplierId);
  const [s] = await q<{ owe: number; opening: number }[]>`
    select -(l.opening_dr_paise + coalesce((select sum(dr_paise - cr_paise) from voucher_lines where ledger_id = l.id), 0)) as owe, -l.opening_dr_paise as opening
    from suppliers s join ledgers l on l.id = s.ledger_id where s.id = ${supplierId}`;
  if (!s) return [];
  const openingDue = Math.max(s.opening, 0);
  const open = settleOldestFirst([openingDue, ...bills.map((b) => b.due_paise)], s.owe).slice(1);
  return bills.map((b, i) => ({ ...b, open_paise: open[i]! })).filter((b) => b.open_paise > 0);
}

export async function paySupplier(
  sql: Sql,
  ctx: Ctx,
  input: EntryCommon & { supplierId: number; fromLedgerId: number; amountPaise: number; allocations?: { purchaseId: number; amountPaise: number }[] },
) {
  requirePerm(ctx, 'payments.make', 'Only admin can pay suppliers');
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Enter an amount more than zero');
  return sql.begin(async (tx) => {
    const ex = await existing(tx, input.clientRef);
    if (ex) return ex;
    const date = await entryDate(tx, input.date);
    const [s] = await tx<{ id: number; name: string; ledger_id: number }[]>`select id, name, ledger_id from suppliers where id = ${input.supplierId} for update`;
    if (!s) throw new AppError(404, 'NOT_FOUND', 'Supplier not found');
    const from = await moneyLedger(tx, input.fromLedgerId);
    const allocs = (input.allocations ?? []).filter((a) => a.amountPaise > 0);
    const allocated = allocs.reduce((t, a) => t + a.amountPaise, 0);
    if (allocated > input.amountPaise) throw new AppError(400, 'OVER_ALLOCATED', 'The bills ticked add up to more than the payment');
    if (allocs.length) {
      const due = new Map((await outstandingPurchases(tx, s.id)).map((p) => [p.id, p]));
      for (const a of allocs) {
        const p = due.get(a.purchaseId);
        if (!p) throw new AppError(400, 'BAD_BILL', 'A ticked bill does not belong to this supplier');
        if (a.amountPaise > p.due_paise) throw new AppError(400, 'OVER_BILL', `Bill ${p.supplier_invoice_no} has only ₹${(p.due_paise / 100).toFixed(2)} left to pay`);
      }
    }
    const r = await insertEntry(
      tx,
      ctx,
      'payment',
      date,
      { amount_paise: input.amountPaise, supplier_id: s.id, from_ledger_id: from.id, reference: clean(input.reference), narration: clean(input.narration) },
      { narration: `Paid ${s.name} from ${from.name}${input.reference ? ` (${input.reference})` : ''}`, lines: [{ ledgerId: s.ledger_id, amountPaise: input.amountPaise }, { ledgerId: from.id, amountPaise: -input.amountPaise }] },
      input.clientRef,
    );
    if (allocs.length) await tx`insert into payment_allocations ${tx(allocs.map((a) => ({ entry_id: r.id, purchase_id: a.purchaseId, amount_paise: a.amountPaise })))}`;
    return r;
  });
}

// ---------------- expenses

export async function createExpense(
  sql: Sql,
  ctx: Ctx,
  input: EntryCommon & {
    ledgerId: number;
    fromLedgerId: number;
    amountPaise: number;
    gstRateBp?: number | null;
    interState?: boolean;
    vendorName?: string;
    vendorGstin?: string;
    vendorBillNo?: string;
    photo?: { mimeType: string; base64: string };
  },
  opts: { fileDir?: string } = {},
) {
  requirePerm(ctx, 'expenses.create', 'You are not allowed to enter expenses — ask admin');
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Enter an amount more than zero');
  return sql.begin(async (tx) => {
    const ex = await existing(tx, input.clientRef);
    if (ex) return ex;
    const date = await entryDate(tx, input.date);
    const [head] = await tx<{ id: number; name: string; kind: string | null; active: boolean }[]>`select id, name, kind, active from ledgers where id = ${input.ledgerId}`;
    if (!head || head.kind !== 'expense' || !head.active) throw new AppError(400, 'BAD_HEAD', 'Choose what the expense is for');
    const from = await moneyLedger(tx, input.fromLedgerId);
    const L = await systemLedgerIds(tx);

    // With a GST bill the tax is input credit; the amount typed is the bill total (including GST).
    const rate = input.gstRateBp ?? 0;
    let taxable = input.amountPaise;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    const gstin = clean(input.vendorGstin)?.toUpperCase() ?? null;
    if (rate > 0) {
      if (!gstin || !isValidGstin(gstin)) throw new AppError(400, 'BAD_GSTIN', 'Input credit needs the GSTIN on the expense bill (check it)');
      if (!clean(input.vendorBillNo)) throw new AppError(400, 'BILL_NO', 'Enter the bill number of the expense bill');
      const excl = mulDivRound(input.amountPaise, 10000, 10000 + rate);
      if (input.interState) igst = input.amountPaise - excl;
      else {
        cgst = mulDivRound(excl, rate, 20000);
        sgst = cgst;
      }
      taxable = input.amountPaise - cgst - sgst - igst;
    }

    let file: string | null = null;
    if (input.photo && opts.fileDir) {
      const ext = input.photo.mimeType === 'application/pdf' ? 'pdf' : input.photo.mimeType === 'image/png' ? 'png' : 'jpg';
      const month = date.slice(0, 7);
      mkdirSync(join(opts.fileDir, month), { recursive: true });
      file = `${month}/exp-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;
      writeFileSync(join(opts.fileDir, file), Buffer.from(input.photo.base64, 'base64'));
    }

    return insertEntry(
      tx,
      ctx,
      'expense',
      date,
      {
        amount_paise: input.amountPaise,
        ledger_id: head.id,
        from_ledger_id: from.id,
        gst_rate_bp: rate || null,
        taxable_paise: taxable,
        cgst_paise: cgst,
        sgst_paise: sgst,
        igst_paise: igst,
        vendor_name: clean(input.vendorName),
        vendor_gstin: gstin,
        vendor_bill_no: clean(input.vendorBillNo),
        reference: clean(input.reference),
        narration: clean(input.narration),
        file,
      },
      {
        narration: `${head.name}${input.narration ? ` — ${input.narration.trim()}` : ''} (from ${from.name})`,
        lines: [
          { ledgerId: head.id, amountPaise: taxable },
          { ledgerId: L.input_cgst, amountPaise: cgst },
          { ledgerId: L.input_sgst, amountPaise: sgst },
          { ledgerId: L.input_igst, amountPaise: igst },
          { ledgerId: from.id, amountPaise: -input.amountPaise },
        ],
      },
      input.clientRef,
    );
  });
}

// ---------------- contra (cash deposited, withdrawn, UPI / card settled into the bank)

export async function createContra(sql: Sql, ctx: Ctx, input: EntryCommon & { fromLedgerId: number; toLedgerId: number; amountPaise: number; chargesPaise?: number }) {
  requirePerm(ctx, 'payments.make', 'Only admin can move money between cash and bank');
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Enter an amount more than zero');
  const charges = input.chargesPaise ?? 0;
  if (!Number.isSafeInteger(charges) || charges < 0 || charges >= input.amountPaise) throw new AppError(400, 'BAD_CHARGES', 'Charges must be less than the amount');
  if (input.fromLedgerId === input.toLedgerId) throw new AppError(400, 'SAME_ACCOUNT', 'Choose two different accounts');
  return sql.begin(async (tx) => {
    const ex = await existing(tx, input.clientRef);
    if (ex) return ex;
    const date = await entryDate(tx, input.date);
    const from = await moneyLedger(tx, input.fromLedgerId, 'From');
    const to = await moneyLedger(tx, input.toLedgerId, 'To');
    const [bankCharges] = await tx<{ id: number }[]>`select id from ledgers where system_code = 'bank_charges'`;
    return insertEntry(
      tx,
      ctx,
      'contra',
      date,
      { amount_paise: input.amountPaise, from_ledger_id: from.id, ledger_id: to.id, charges_paise: charges, reference: clean(input.reference), narration: clean(input.narration) },
      {
        narration: `${from.name} → ${to.name}${charges ? `, charges ₹${(charges / 100).toFixed(2)}` : ''}`,
        lines: [
          { ledgerId: to.id, amountPaise: input.amountPaise - charges },
          { ledgerId: bankCharges!.id, amountPaise: charges },
          { ledgerId: from.id, amountPaise: -input.amountPaise },
        ],
      },
      input.clientRef,
    );
  });
}

// ---------------- journal (admin only)

export async function createJournal(sql: Sql, ctx: Ctx, input: EntryCommon & { lines: { ledgerId: number; drPaise?: number; crPaise?: number }[] }) {
  requirePerm(ctx, 'accounts.manage', 'Only admin can make journal entries');
  const narration = clean(input.narration);
  if (!narration || narration.length < 5) throw new AppError(400, 'NARRATION', 'A journal needs a clear reason (narration)');
  const lines = input.lines.map((l) => ({ ledgerId: l.ledgerId, amountPaise: (l.drPaise ?? 0) - (l.crPaise ?? 0) })).filter((l) => l.amountPaise !== 0);
  if (lines.length < 2) throw new AppError(400, 'LINES', 'A journal needs at least one debit and one credit');
  if (lines.some((l) => !Number.isSafeInteger(l.amountPaise))) throw new AppError(400, 'BAD_AMOUNT', 'Amounts must be in rupees and paise');
  const dr = lines.filter((l) => l.amountPaise > 0).reduce((t, l) => t + l.amountPaise, 0);
  const cr = -lines.filter((l) => l.amountPaise < 0).reduce((t, l) => t + l.amountPaise, 0);
  if (dr !== cr) throw new AppError(400, 'NOT_BALANCED', `Debits (₹${(dr / 100).toFixed(2)}) and credits (₹${(cr / 100).toFixed(2)}) must be equal`);
  return sql.begin(async (tx) => {
    const ex = await existing(tx, input.clientRef);
    if (ex) return ex;
    const date = await entryDate(tx, input.date);
    const ids = lines.map((l) => l.ledgerId);
    const found = await tx<{ id: number }[]>`select id from ledgers where id = any(${ids}) and active`;
    if (new Set(found.map((f) => f.id)).size !== new Set(ids).size) throw new AppError(400, 'BAD_ACCOUNT', 'One of the accounts was not found');
    return insertEntry(tx, ctx, 'journal', date, { amount_paise: dr, reference: clean(input.reference), narration }, { narration, lines }, input.clientRef);
  });
}

// ---------------- list / get / cancel

export async function listEntries(q: Q, ctx: Ctx, f: { kind?: Kind; from?: string; to?: string; supplierId?: number; limit?: number }) {
  if (!can(ctx, 'reports.view') && !can(ctx, 'payments.make') && !can(ctx, 'expenses.create')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see this');
  return q`
    select m.id, m.number, m.kind, m.entry_date, m.at, m.amount_paise, m.charges_paise, m.status, m.reference, m.narration, m.file,
           m.gst_rate_bp, m.taxable_paise, m.cgst_paise, m.sgst_paise, m.igst_paise, m.vendor_name, m.vendor_gstin, m.vendor_bill_no,
           s.name as supplier_name, m.supplier_id, l.name as ledger_name, fl.name as from_ledger_name, u.name as user_name, m.cancel_reason
    from money_entries m join users u on u.id = m.user_id
         left join suppliers s on s.id = m.supplier_id left join ledgers l on l.id = m.ledger_id left join ledgers fl on fl.id = m.from_ledger_id
    where (${f.kind ?? null}::text is null or m.kind = ${f.kind ?? null})
      and (${f.from ?? null}::date is null or m.entry_date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or m.entry_date <= ${f.to ?? null}::date)
      and (${f.supplierId ?? null}::int is null or m.supplier_id = ${f.supplierId ?? null})
      and (m.kind <> 'expense' or ${can(ctx, 'reports.view')} or m.user_id = ${ctx.userId})
    order by m.id desc limit ${Math.min(f.limit ?? 300, 2000)}`;
}

export async function getEntry(q: Q, ctx: Ctx, id: number) {
  const [e] = await listEntriesById(q, id);
  if (!e) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
  if (!can(ctx, 'reports.view') && e.user_id !== ctx.userId) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see this');
  const lines = await q`
    select vl.ledger_id, l.name as ledger_name, vl.dr_paise, vl.cr_paise from voucher_lines vl join ledgers l on l.id = vl.ledger_id
    where vl.voucher_id = ${e.voucher_id} order by vl.dr_paise desc, vl.id`;
  const allocations = await q`
    select a.purchase_id, a.amount_paise, p.number, p.supplier_invoice_no, p.supplier_invoice_date from payment_allocations a join purchase_invoices p on p.id = a.purchase_id
    where a.entry_id = ${id} order by p.supplier_invoice_date`;
  return { ...e, lines, allocations };
}

async function listEntriesById(q: Q, id: number) {
  return q<{ id: number; number: string; kind: Kind; status: string; voucher_id: number; user_id: number; amount_paise: number; entry_date: string; file: string | null; [k: string]: unknown }[]>`
    select m.*, s.name as supplier_name, l.name as ledger_name, fl.name as from_ledger_name, u.name as user_name, cu.name as cancelled_by_name
    from money_entries m join users u on u.id = m.user_id left join users cu on cu.id = m.cancelled_by
         left join suppliers s on s.id = m.supplier_id left join ledgers l on l.id = m.ledger_id left join ledgers fl on fl.id = m.from_ledger_id
    where m.id = ${id}`;
}

export async function cancelEntry(sql: Sql, ctx: Ctx, id: number, input: { reason: string; overrideToken?: string }) {
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason for cancelling');
  return sql.begin(async (tx) => {
    const [e] = await tx<{ id: number; number: string; kind: Kind; status: string; voucher_id: number; user_id: number; entry_date: string }[]>`
      select id, number, kind, status, voucher_id, user_id, entry_date from money_entries where id = ${id} for update`;
    if (!e) throw new AppError(404, 'NOT_FOUND', 'Entry not found');
    if (e.status === 'cancelled') throw new AppError(409, 'ALREADY_CANCELLED', `${e.number} is already cancelled`);
    let approvedBy: number | null = null;
    if (!can(ctx, 'accounts.manage')) {
      if (!input.overrideToken) throw new AppError(403, 'NEEDS_OVERRIDE', 'Cancelling needs the admin PIN', { permission: 'accounts.manage', entryId: id });
      approvedBy = (await consumeOverride(tx, ctx, input.overrideToken, 'accounts.manage', (c) => c.entryId === id)).approvedBy;
    }
    const cancelVoucherId = await reverseVoucher(tx, ctx, e.voucher_id, istDate(), `Cancelled ${e.number}: ${reason}`);
    await tx`update money_entries set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = now(), cancelled_by = ${ctx.userId},
             cancel_approved_by = ${approvedBy}, cancel_voucher_id = ${cancelVoucherId} where id = ${id}`;
    await audit(tx, ctx, `${e.kind}.cancelled`, { entity: 'money_entry', entityId: id, details: { number: e.number }, reason, approvedBy });
    return { id, number: e.number };
  });
}

// ------------------------------------------------------------------ books

/** Statement of one account: opening balance at `from`, every entry with a running balance, closing. Positive = debit. */
export async function ledgerStatement(q: Q, ctx: Ctx, ledgerId: number, r: { from: string; to: string }) {
  requirePerm(ctx, 'reports.view');
  const [l] = await q<{ id: number; name: string; group_name: string; nature: string; kind: string | null; opening_dr_paise: number; party_type: string | null }[]>`
    select l.id, l.name, g.name as group_name, g.nature, l.kind, l.opening_dr_paise, l.party_type from ledgers l join ledger_groups g on g.id = l.group_id where l.id = ${ledgerId}`;
  if (!l) throw new AppError(404, 'NOT_FOUND', 'Account not found');
  const [ob] = await q<{ bal: number }[]>`
    select ${l.opening_dr_paise}::bigint + coalesce(sum(vl.dr_paise - vl.cr_paise), 0) as bal
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id where vl.ledger_id = ${ledgerId} and v.vdate < ${r.from}`;
  const rows = await q<{ voucher_id: number; vdate: string; vtype: string; narration: string | null; dr_paise: number; cr_paise: number; other: string | null }[]>`
    select v.id as voucher_id, v.vdate, v.vtype, v.narration, sum(vl.dr_paise) as dr_paise, sum(vl.cr_paise) as cr_paise,
           (select string_agg(distinct ol.name, ', ') from voucher_lines o join ledgers ol on ol.id = o.ledger_id
             where o.voucher_id = v.id and o.ledger_id <> ${ledgerId}) as other
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id
    where vl.ledger_id = ${ledgerId} and v.vdate between ${r.from} and ${r.to}
    group by v.id order by v.vdate, v.id`;
  let bal = ob!.bal;
  const entries = rows.map((x) => {
    bal += x.dr_paise - x.cr_paise;
    return { ...x, balance_paise: bal };
  });
  return {
    ledger: l,
    ...r,
    openingPaise: ob!.bal,
    entries,
    totalDrPaise: rows.reduce((t, x) => t + x.dr_paise, 0),
    totalCrPaise: rows.reduce((t, x) => t + x.cr_paise, 0),
    closingPaise: bal,
  };
}

/** Day Book: every voucher in the period, with its lines. */
export async function dayBook(q: Q, ctx: Ctx, r: { from: string; to: string }) {
  requirePerm(ctx, 'reports.view');
  const rows = await q<{ id: number; vdate: string; vtype: string; narration: string | null; user_name: string | null; lines: { ledger: string; dr: number; cr: number }[] }[]>`
    select v.id, v.vdate, v.vtype, v.narration, u.name as user_name,
           (select json_agg(json_build_object('ledger', l.name, 'dr', vl.dr_paise, 'cr', vl.cr_paise) order by vl.dr_paise desc, vl.id)
            from voucher_lines vl join ledgers l on l.id = vl.ledger_id where vl.voucher_id = v.id) as lines
    from vouchers v left join users u on u.id = v.user_id
    where v.vdate between ${r.from} and ${r.to}
    order by v.vdate, v.id limit 5000`;
  return { ...r, vouchers: rows };
}

/** Trial balance as on a date: every account with a non-zero balance, grouped. Debits equal credits once the openings are balanced. */
export async function trialBalance(q: Q, ctx: Ctx, asOf: string) {
  requirePerm(ctx, 'reports.view');
  const rows = await q<{ id: number; name: string; group_name: string; nature: string; party_type: string | null; balance_paise: number }[]>`
    select l.id, l.name, g.name as group_name, g.nature, l.party_type,
           l.opening_dr_paise + coalesce((select sum(vl.dr_paise - vl.cr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id
                                          where vl.ledger_id = l.id and v.vdate <= ${asOf}), 0) as balance_paise
    from ledgers l join ledger_groups g on g.id = l.group_id`;
  const nonZero = rows.filter((r) => r.balance_paise !== 0);
  // Customers and suppliers are shown as one line per group (details in their own screens).
  const groups = new Map<string, { group: string; nature: string; accounts: { id: number | null; name: string; dr: number; cr: number }[] }>();
  const parties = new Map<string, number>();
  for (const r of nonZero) {
    if (r.party_type) {
      parties.set(r.group_name, (parties.get(r.group_name) ?? 0) + r.balance_paise);
      if (!groups.has(r.group_name)) groups.set(r.group_name, { group: r.group_name, nature: r.nature, accounts: [] });
      continue;
    }
    const g = groups.get(r.group_name) ?? { group: r.group_name, nature: r.nature, accounts: [] };
    g.accounts.push({ id: r.id, name: r.name, dr: Math.max(r.balance_paise, 0), cr: Math.max(-r.balance_paise, 0) });
    groups.set(r.group_name, g);
  }
  for (const [name, bal] of parties) {
    const debitors = rows.filter((r) => r.group_name === name && r.balance_paise > 0).reduce((t, r) => t + r.balance_paise, 0);
    const creditors = -rows.filter((r) => r.group_name === name && r.balance_paise < 0).reduce((t, r) => t + r.balance_paise, 0);
    groups.get(name)!.accounts.push({ id: null, name: `${name} (${rows.filter((r) => r.group_name === name && r.balance_paise !== 0).length} parties)`, dr: debitors, cr: creditors });
    void bal;
  }
  const list = [...groups.values()].filter((g) => g.accounts.length).sort((a, b) => ['asset', 'liability', 'income', 'expense'].indexOf(a.nature) - ['asset', 'liability', 'income', 'expense'].indexOf(b.nature) || a.group.localeCompare(b.group));
  const totalDr = list.reduce((t, g) => t + g.accounts.reduce((s, a) => s + a.dr, 0), 0);
  const totalCr = list.reduce((t, g) => t + g.accounts.reduce((s, a) => s + a.cr, 0), 0);
  return { asOf, groups: list, totalDrPaise: totalDr, totalCrPaise: totalCr, differencePaise: totalDr - totalCr };
}

// ------------------------------------------------------------------ supplier ageing

const BUCKETS = [30, 60, 90] as const;

/**
 * What we owe each supplier, by age. Payments ticked against bills settle those bills; other
 * payments (and a debit opening balance) settle the oldest bills first.
 */
export async function supplierAgeing(q: Q, ctx: Ctx, asOf = istDate()) {
  if (!can(ctx, 'reports.view') && !can(ctx, 'payments.make')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see this');
  const sups = await q<{ id: number; name: string; phone: string | null; ledger_id: number; balance_paise: number; opening_dr_paise: number }[]>`
    select s.id, s.name, s.phone, s.ledger_id, l.opening_dr_paise,
           l.opening_dr_paise + coalesce((select sum(vl.dr_paise - vl.cr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id where vl.ledger_id = l.id and v.vdate <= ${asOf}), 0) as balance_paise
    from suppliers s join ledgers l on l.id = s.ledger_id order by lower(s.name)`;
  const s = await getSettings(q);
  const out = [];
  for (const sup of sups) {
    const owe = -sup.balance_paise; // credit balance = we owe
    if (owe <= 0 && sup.balance_paise === 0) continue;
    const bills = (await outstandingPurchases(q, sup.id)).filter((b) => b.supplier_invoice_date <= asOf).map((b) => ({ date: b.supplier_invoice_date, due: b.due_paise, label: b.supplier_invoice_no, id: b.id as number | null }));
    if (sup.opening_dr_paise < 0) bills.unshift({ date: s.openingDate || '2000-01-01', due: -sup.opening_dr_paise, label: 'Opening balance', id: null });
    // Unallocated credits (on-account payments, debit opening) settle the oldest bills first.
    let unallocated = bills.reduce((t, b) => t + Math.max(b.due, 0), 0) - Math.max(owe, 0);
    for (const b of bills) {
      if (unallocated <= 0) break;
      const take = Math.min(Math.max(b.due, 0), unallocated);
      b.due -= take;
      unallocated -= take;
    }
    const buckets = [0, 0, 0, 0];
    let oldest: string | null = null;
    for (const b of bills) {
      if (b.due <= 0) continue;
      const days = Math.floor((Date.parse(asOf) - Date.parse(b.date)) / 86_400_000);
      buckets[days <= BUCKETS[0] ? 0 : days <= BUCKETS[1] ? 1 : days <= BUCKETS[2] ? 2 : 3]! += b.due;
      oldest ??= b.date;
    }
    out.push({ supplierId: sup.id, name: sup.name, phone: sup.phone, owePaise: owe, buckets, oldestDue: oldest, advancePaise: owe < 0 ? -owe : 0 });
  }
  const totals = out.reduce((t, x) => ({ owe: t.owe + Math.max(x.owePaise, 0), b: t.b.map((v, i) => v + x.buckets[i]!) }), { owe: 0, b: [0, 0, 0, 0] });
  return { asOf, suppliers: out.filter((x) => x.owePaise !== 0).sort((a, b) => b.owePaise - a.owePaise), totals };
}

// ------------------------------------------------------------------ cash closing

export async function cashPosition(q: Q, date: string) {
  const [cash] = await q<{ id: number }[]>`select id from ledgers where system_code = 'cash'`;
  const [r] = await q<{ opening: number; inflow: number; outflow: number }[]>`
    select l.opening_dr_paise + coalesce((select sum(vl.dr_paise - vl.cr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id where vl.ledger_id = l.id and v.vdate < ${date}), 0) as opening,
           coalesce((select sum(vl.dr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id where vl.ledger_id = l.id and v.vdate = ${date}), 0) as inflow,
           coalesce((select sum(vl.cr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id where vl.ledger_id = l.id and v.vdate = ${date}), 0) as outflow
    from ledgers l where l.id = ${cash!.id}`;
  const closings = await q<{ id: number; at: string; book_paise: number; counted_paise: number; difference_paise: number; note: string | null; user_name: string; denominations: Record<string, number>; adjustment_entry_id: number | null }[]>`
    select c.id, c.at, c.book_paise, c.counted_paise, c.difference_paise, c.note, c.denominations, c.adjustment_entry_id, u.name as user_name
    from cash_closings c join users u on u.id = c.user_id where c.close_date = ${date} order by c.id`;
  return { date, cashLedgerId: cash!.id, openingPaise: r!.opening, inPaise: r!.inflow, outPaise: r!.outflow, bookPaise: r!.opening + r!.inflow - r!.outflow, closings };
}

export const DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];

/** Count the cash drawer at day end. A difference is recorded; admin may also book it to "Cash Short & Excess". */
export async function closeCash(sql: Sql, ctx: Ctx, input: { date?: string; countedPaise?: number; denominations?: Record<string, number>; note?: string; bookDifference?: boolean }) {
  if (!can(ctx, 'payments.receive') && !can(ctx, 'payments.make')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to close the cash');
  const date = input.date ?? istDate();
  if (date > istDate()) throw new AppError(400, 'FUTURE_DATE', 'The date cannot be in the future');
  let counted = input.countedPaise ?? null;
  const den = input.denominations ?? {};
  if (Object.keys(den).length) {
    for (const [k, n] of Object.entries(den)) if (!DENOMINATIONS.includes(Number(k)) || !Number.isInteger(n) || n < 0) throw new AppError(400, 'BAD_COUNT', 'Check the note and coin counts');
    const fromDen = Object.entries(den).reduce((t, [k, n]) => t + Number(k) * 100 * n, 0);
    if (counted != null && counted !== fromDen) throw new AppError(400, 'BAD_COUNT', 'The total does not match the notes and coins counted');
    counted = fromDen;
  }
  if (counted == null || !Number.isSafeInteger(counted) || counted < 0) throw new AppError(400, 'BAD_COUNT', 'Enter the cash counted');
  if (input.bookDifference) requirePerm(ctx, 'accounts.manage', 'Only admin can book a cash difference');
  return sql.begin(async (tx) => {
    // serialise closings so two counters can't book the same difference twice
    await tx`select pg_advisory_xact_lock(4242, ${Number(date.replace(/-/g, ''))})`;
    const pos = await cashPosition(tx, date);
    const diff = counted! - pos.bookPaise;
    let adjustmentId: number | null = null;
    if (input.bookDifference && diff !== 0) {
      const [cd] = await tx<{ id: number }[]>`select id from ledgers where system_code = 'cash_diff'`;
      const r = await insertEntry(
        tx,
        ctx,
        'journal',
        date,
        { amount_paise: Math.abs(diff), narration: `Cash count difference on ${date}${input.note ? `: ${input.note.trim()}` : ''}` },
        { narration: `Cash ${diff > 0 ? 'excess' : 'short'} at day close`, lines: [{ ledgerId: pos.cashLedgerId, amountPaise: diff }, { ledgerId: cd!.id, amountPaise: -diff }] },
      );
      adjustmentId = r.id;
    }
    const [c] = await tx<{ id: number }[]>`
      insert into cash_closings (close_date, book_paise, counted_paise, difference_paise, denominations, note, adjustment_entry_id, user_id, device_id)
      values (${date}, ${pos.bookPaise}, ${counted}, ${diff}, ${tx.json(den)}, ${clean(input.note)}, ${adjustmentId}, ${ctx.userId}, ${ctx.deviceId}) returning id`;
    await audit(tx, ctx, 'cash.closed', { entity: 'cash_closing', entityId: c!.id, details: { date, bookPaise: pos.bookPaise, countedPaise: counted, differencePaise: diff, booked: !!adjustmentId } });
    return { id: c!.id, bookPaise: pos.bookPaise, countedPaise: counted!, differencePaise: diff, adjustmentEntryId: adjustmentId };
  });
}

// ------------------------------------------------------------------ opening balances

/** Accounts that never carry an opening balance (they start each year at zero, or are worked out). */
const NO_OPENING = ['sales', 'purchases', 'sales_returns', 'purchase_returns', 'round_off', 'opening_stock', 'capital'];

export async function openingBalances(q: Q, ctx: Ctx) {
  requirePerm(ctx, 'accounts.manage');
  const s = await getSettings(q);
  const ledgers = await q<{ id: number; name: string; group_name: string; nature: string; kind: string | null; system_code: string | null; opening_dr_paise: number }[]>`
    select l.id, l.name, g.name as group_name, g.nature, l.kind, l.system_code, l.opening_dr_paise
    from ledgers l join ledger_groups g on g.id = l.group_id
    where l.party_type is null and l.active
      and coalesce(l.system_code, '') not in ('sales', 'purchases', 'sales_returns', 'purchase_returns', 'round_off', 'opening_stock')
    order by g.name, lower(l.name)`;
  const [parties] = await q<{ customers_dr: number; customers_n: number; suppliers_cr: number; suppliers_n: number }[]>`
    select coalesce(sum(opening_dr_paise) filter (where party_type = 'customer'), 0) as customers_dr,
           count(*) filter (where party_type = 'customer' and opening_dr_paise <> 0)::int as customers_n,
           coalesce(-sum(opening_dr_paise) filter (where party_type = 'supplier'), 0) as suppliers_cr,
           count(*) filter (where party_type = 'supplier' and opening_dr_paise <> 0)::int as suppliers_n
    from ledgers where party_type is not null`;
  const [stock] = await q<{ value: number; items: number }[]>`
    select coalesce(sum(round(m.qty_milli::numeric * coalesce(m.unit_cost_cp, p.cost_price_cp, 0) / 100000)), 0)::bigint as value, count(distinct m.product_id)::int as items
    from stock_movements m join products p on p.id = m.product_id where m.kind = 'opening'`;
  const nonCapital = ledgers.filter((l) => l.system_code !== 'capital').reduce((t, l) => t + l.opening_dr_paise, 0);
  const total = nonCapital + parties!.customers_dr - parties!.suppliers_cr + stock!.value;
  return {
    openingDate: s.openingDate,
    locked: s.openingLocked,
    ledgers,
    customers: { totalPaise: parties!.customers_dr, count: parties!.customers_n },
    suppliers: { totalPaise: parties!.suppliers_cr, count: parties!.suppliers_n },
    stock: { valuePaise: stock!.value, items: stock!.items },
    /** What the Capital Account must be (credit) so the opening trial balance agrees. */
    capitalPaise: total,
  };
}

export async function setOpening(sql: Sql, ctx: Ctx, input: { openingDate?: string; ledgers?: { ledgerId: number; drPaise: number }[] }) {
  requirePerm(ctx, 'accounts.manage');
  const s = await getSettings(sql);
  if (s.openingLocked) throw new AppError(409, 'LOCKED', 'Opening balances are confirmed and can no longer be changed. Use a journal entry.');
  return sql.begin(async (tx) => {
    if (input.openingDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.openingDate)) throw new AppError(400, 'BAD_DATE', 'Enter a valid go-live date');
      const [early] = await tx`select 1 from vouchers where vdate < ${input.openingDate} limit 1`;
      if (early) throw new AppError(400, 'ENTRIES_BEFORE', 'There are entries before this date. Pick an earlier go-live date.');
      await setSettings(tx, { openingDate: input.openingDate });
    }
    for (const l of input.ledgers ?? []) {
      if (!Number.isSafeInteger(l.drPaise)) throw new AppError(400, 'BAD_AMOUNT', 'Amounts must be in rupees and paise');
      const [row] = await tx<{ party_type: string | null; system_code: string | null }[]>`select party_type, system_code from ledgers where id = ${l.ledgerId}`;
      if (!row || row.party_type) throw new AppError(400, 'BAD_ACCOUNT', 'Customer and supplier openings are set on their own screens or by import');
      if (row.system_code && NO_OPENING.includes(row.system_code)) throw new AppError(400, 'BAD_ACCOUNT', 'This account does not take an opening balance (Capital is worked out for you)');
      await tx`update ledgers set opening_dr_paise = ${l.drPaise} where id = ${l.ledgerId}`;
    }
    await audit(tx, ctx, 'opening.updated', { details: { openingDate: input.openingDate, ledgers: input.ledgers?.length ?? 0 } });
    return openingBalances(tx, ctx);
  });
}

/** Confirm: opening stock is valued into "Opening Stock", Capital takes the difference, and everything is locked. */
export async function lockOpening(sql: Sql, ctx: Ctx) {
  requirePerm(ctx, 'accounts.manage');
  return sql.begin(async (tx) => {
    const s = await getSettings(tx);
    if (s.openingLocked) throw new AppError(409, 'LOCKED', 'Already confirmed');
    if (!s.openingDate) throw new AppError(400, 'NO_DATE', 'Set the go-live date first');
    const o = await openingBalances(tx, ctx);
    await tx`update ledgers set opening_dr_paise = ${o.stock.valuePaise} where system_code = 'opening_stock'`;
    await tx`update ledgers set opening_dr_paise = ${-o.capitalPaise} where system_code = 'capital'`;
    await setSettings(tx, { openingLocked: true });
    await audit(tx, ctx, 'opening.locked', { details: { openingDate: s.openingDate, capitalPaise: o.capitalPaise, stockPaise: o.stock.valuePaise } });
    return openingBalances(tx, ctx);
  });
}

import { addDays, ageBucket, daysBetween, istDate, reminderMessage, whatsappLink, whatsappNumber } from '@kph/core';
import type { Q, Sql } from '../db/connect.js';
import { openCreditBills } from './billing.js';
import { AppError, audit, can, type Ctx } from './common.js';
import { getSettings } from './settings.js';

/**
 * Credit (khata) management: what each customer owes and since when, what is overdue
 * (bill date + credit days), statements, and WhatsApp reminders.
 *
 * How a balance is matched to bills: receipts marked against bills settle those bills; returns
 * credited to the account settle their own bill; anything else paid "on account" settles the
 * oldest bills first. An opening balance counts as a bill dated on the go-live date.
 */

function canSeeKhata(ctx: Ctx) {
  if (!can(ctx, 'payments.receive') && !can(ctx, 'reports.view') && !can(ctx, 'customers.manage')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see customer dues');
}

interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  credit_limit_paise: number | null;
  credit_days: number | null;
  language: 'te' | 'en' | null;
  dues_on_hold: boolean;
  hold_note: string | null;
  created_at: string;
  opening_dr_paise: number;
  balance_paise: number;
  last_receipt: string | null;
  last_reminder: string | null;
}

export interface OpenBill {
  id: number | null;
  number: string;
  date: string;
  /** null when no credit days are set: the bill has no due date */
  dueDate: string | null;
  totalPaise: number;
  duePaise: number;
  days: number;
  overdue: boolean;
}

export interface CustomerDues {
  customerId: number;
  name: string;
  phone: string | null;
  balancePaise: number;
  creditLimitPaise: number | null;
  creditDays: number | null;
  onHold: boolean;
  holdNote: string | null;
  buckets: [number, number, number, number];
  overduePaise: number;
  dueTodayPaise: number;
  oldest: OpenBill | null;
  nextDueDate: string | null;
  lastReceipt: string | null;
  lastReminder: string | null;
  bills: OpenBill[];
}

async function customers(q: Q, asOf: string, id?: number) {
  return q<CustomerRow[]>`
    select c.id, c.name, c.phone, c.credit_limit_paise, c.credit_days, c.language, c.dues_on_hold, c.hold_note, c.created_at::date::text as created_at, l.opening_dr_paise,
           l.opening_dr_paise + coalesce((select sum(vl.dr_paise - vl.cr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id
                                          where vl.ledger_id = l.id and v.vdate <= ${asOf}), 0) as balance_paise,
           (select max(receipt_date)::text from receipts r where r.customer_id = c.id and r.status = 'posted') as last_receipt,
           (select max(at)::text from reminders m where m.customer_id = c.id) as last_reminder
    from customers c join ledgers l on l.id = c.ledger_id
    where (${id ?? null}::int is null or c.id = ${id ?? null})
    order by lower(c.name)`;
}

/** Work out one customer's open bills and ageing from their balance. */
async function duesOf(q: Q, c: CustomerRow, asOf: string, defaults: { creditDays: number; openingDate: string }): Promise<CustomerDues> {
  // No credit days anywhere = no due dates (the shop doesn't usually fix a credit period).
  const creditDays = c.credit_days ?? (defaults.creditDays > 0 ? defaults.creditDays : null);
  const raw = (await openCreditBills(q, c.id)).filter((b) => b.invoice_date <= asOf);
  const bills: OpenBill[] = raw.map((b) => ({ id: b.id, number: b.number, date: b.invoice_date, dueDate: creditDays == null ? null : addDays(b.invoice_date, creditDays), totalPaise: b.total_paise, duePaise: Math.max(b.due_paise, 0), days: 0, overdue: false }));
  if (c.opening_dr_paise > 0) {
    const d = defaults.openingDate || c.created_at.slice(0, 10);
    bills.unshift({ id: null, number: 'Opening balance', date: d, dueDate: creditDays == null ? null : d, totalPaise: c.opening_dr_paise, duePaise: c.opening_dr_paise, days: 0, overdue: false });
  }
  // Unmatched payments / advances settle the oldest bills first.
  let extra = bills.reduce((t, b) => t + b.duePaise, 0) - Math.max(c.balance_paise, 0);
  for (const b of bills) {
    if (extra <= 0) break;
    const take = Math.min(b.duePaise, extra);
    b.duePaise -= take;
    extra -= take;
  }
  const open = bills.filter((b) => b.duePaise > 0);
  const buckets: [number, number, number, number] = [0, 0, 0, 0];
  let overdue = 0;
  let dueToday = 0;
  for (const b of open) {
    b.days = daysBetween(b.date, asOf);
    b.overdue = !c.dues_on_hold && b.dueDate != null && b.dueDate < asOf;
    buckets[ageBucket(b.days)] += b.duePaise;
    if (b.overdue) overdue += b.duePaise;
    if (!c.dues_on_hold && b.dueDate === asOf) dueToday += b.duePaise;
  }
  const upcoming = open.filter((b) => b.dueDate != null && b.dueDate >= asOf).map((b) => b.dueDate!).sort();
  return {
    customerId: c.id,
    name: c.name,
    phone: c.phone,
    balancePaise: c.balance_paise,
    creditLimitPaise: c.credit_limit_paise,
    creditDays,
    onHold: c.dues_on_hold,
    holdNote: c.hold_note,
    buckets,
    overduePaise: overdue,
    dueTodayPaise: dueToday,
    oldest: open[0] ?? null,
    nextDueDate: upcoming[0] ?? null,
    lastReceipt: c.last_receipt,
    lastReminder: c.last_reminder,
    bills: open,
  };
}

/** Every customer who owes us (or has paid in advance), with ageing. */
export async function customerAgeing(q: Q, ctx: Ctx, asOf = istDate()) {
  canSeeKhata(ctx);
  const s = await getSettings(q);
  const rows = (await customers(q, asOf)).filter((c) => c.balance_paise !== 0);
  const out: CustomerDues[] = [];
  for (const c of rows) out.push(await duesOf(q, c, asOf, { creditDays: s.creditDaysDefault, openingDate: s.openingDate }));
  const owing = out.filter((x) => x.balancePaise > 0);
  const totals = {
    receivablePaise: owing.reduce((t, x) => t + x.balancePaise, 0),
    advancesPaise: -out.filter((x) => x.balancePaise < 0).reduce((t, x) => t + x.balancePaise, 0),
    overduePaise: owing.reduce((t, x) => t + x.overduePaise, 0),
    onHoldPaise: owing.filter((x) => x.onHold).reduce((t, x) => t + x.balancePaise, 0),
    buckets: [0, 1, 2, 3].map((i) => owing.reduce((t, x) => t + x.buckets[i]!, 0)),
    customers: owing.length,
    overLimit: owing.filter((x) => x.creditLimitPaise != null && x.balancePaise > x.creditLimitPaise).length,
  };
  return { asOf, customers: out.sort((a, b) => b.overduePaise - a.overduePaise || b.balancePaise - a.balancePaise), totals };
}

/** For the dashboard: who should be asked for money today. */
export async function dueList(q: Q, ctx: Ctx, asOf = istDate()) {
  const a = await customerAgeing(q, ctx, asOf);
  const due = a.customers.filter((c) => !c.onHold && (c.overduePaise > 0 || c.dueTodayPaise > 0));
  // Without due dates, show who owes the most (old dues kept as a record are left out).
  const owing = a.customers.filter((c) => !c.onHold && c.balancePaise > 0).sort((x, y) => y.balancePaise - x.balancePaise);
  return {
    asOf,
    overduePaise: a.totals.overduePaise,
    dueTodayPaise: due.reduce((t, c) => t + c.dueTodayPaise, 0),
    count: due.length,
    owingPaise: owing.reduce((t, c) => t + c.balancePaise, 0),
    owing: owing.slice(0, 8).map((c) => ({ customerId: c.customerId, name: c.name, phone: c.phone, balancePaise: c.balancePaise, oldestDays: c.oldest?.days ?? 0, lastReminder: c.lastReminder })),
    customers: due.slice(0, 12).map((c) => ({ customerId: c.customerId, name: c.name, phone: c.phone, balancePaise: c.balancePaise, overduePaise: c.overduePaise, dueTodayPaise: c.dueTodayPaise, oldestDays: c.oldest?.days ?? 0, lastReminder: c.lastReminder })),
  };
}

export async function customerDues(q: Q, ctx: Ctx, customerId: number, asOf = istDate()) {
  canSeeKhata(ctx);
  const s = await getSettings(q);
  const [c] = await customers(q, asOf, customerId);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  return duesOf(q, c, asOf, { creditDays: s.creditDaysDefault, openingDate: s.openingDate });
}

// ------------------------------------------------------------------ statement

const DOC = `
  case v.ref_type
    when 'sales_invoice' then (select number from sales_invoices where id = v.ref_id)
    when 'receipt' then (select number from receipts where id = v.ref_id)
    when 'credit_note' then (select number from credit_notes where id = v.ref_id)
    when 'money_entry' then (select number from money_entries where id = v.ref_id)
  end`;

/** Customer statement for a period: opening balance, every bill / payment / return, running balance, closing. */
export async function customerStatementRange(q: Q, ctx: Ctx, customerId: number, r: { from: string; to: string }) {
  canSeeKhata(ctx);
  if (r.from > r.to) throw new AppError(400, 'BAD_RANGE', 'Choose a valid date range');
  const [c] = await q<{ id: number; name: string; phone: string | null; address: string | null; gstin: string | null; ledger_id: number; opening_dr_paise: number; credit_limit_paise: number | null }[]>`
    select c.id, c.name, c.phone, c.address, c.gstin, c.ledger_id, l.opening_dr_paise, c.credit_limit_paise from customers c join ledgers l on l.id = c.ledger_id where c.id = ${customerId}`;
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  const [ob] = await q<{ bal: number }[]>`
    select ${c.opening_dr_paise}::bigint + coalesce(sum(vl.dr_paise - vl.cr_paise), 0) as bal
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id where vl.ledger_id = ${c.ledger_id} and v.vdate < ${r.from}`;
  const rows = await q.unsafe<{ vdate: string; vtype: string; doc: string | null; narration: string | null; dr: number; cr: number; ref_type: string | null; ref_id: number | null }[]>(
    `select v.vdate::text as vdate, v.vtype, ${DOC} as doc, v.narration, sum(vl.dr_paise)::bigint as dr, sum(vl.cr_paise)::bigint as cr, v.ref_type, v.ref_id
     from voucher_lines vl join vouchers v on v.id = vl.voucher_id
     where vl.ledger_id = $1 and v.vdate between $2 and $3
     group by v.id order by v.vdate, v.id`,
    [c.ledger_id, r.from, r.to],
  );
  let bal = ob!.bal;
  const LABEL: Record<string, string> = { sales: 'Bill', receipt: 'Payment received', credit_note: 'Goods returned', reversal: 'Cancelled', journal: 'Adjustment' };
  const entries = rows.map((x) => {
    bal += x.dr - x.cr;
    return { date: x.vdate, type: LABEL[x.vtype] ?? x.vtype, doc: x.doc, narration: x.narration, debitPaise: x.dr, creditPaise: x.cr, balancePaise: bal };
  });
  const s = await getSettings(q);
  const dues = await customerDues(q, ctx, customerId, r.to);
  return {
    customer: { id: c.id, name: c.name, phone: c.phone, address: c.address, gstin: c.gstin, creditLimitPaise: c.credit_limit_paise },
    ...r,
    openingPaise: ob!.bal,
    entries,
    totalDebitPaise: rows.reduce((t, x) => t + x.dr, 0),
    totalCreditPaise: rows.reduce((t, x) => t + x.cr, 0),
    closingPaise: bal,
    openBills: dues.bills,
    overduePaise: dues.overduePaise,
    store: { name: s.storeName, address: s.storeAddress, phone: s.storePhone, gstin: s.storeGstin, upiId: s.storeUpiId, labels: s.invoiceLabels },
  };
}

// ------------------------------------------------------------------ reminders

/** Build the WhatsApp reminder for a customer and log it. The screen opens the returned link. */
export async function makeReminder(sql: Sql, ctx: Ctx, customerId: number, input: { language?: 'te' | 'en'; channel?: 'whatsapp' | 'call' | 'visit' | 'sms'; note?: string }) {
  if (!can(ctx, 'payments.receive') && !can(ctx, 'customers.manage')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to send reminders');
  const s = await getSettings(sql);
  const asOf = istDate();
  const [c] = await customers(sql, asOf, customerId);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  const d = await duesOf(sql, c, asOf, { creditDays: s.creditDaysDefault, openingDate: s.openingDate });
  const channel = input.channel ?? 'whatsapp';
  if (channel === 'whatsapp' && d.balancePaise <= 0) throw new AppError(400, 'NOTHING_DUE', `${c.name} does not owe anything`);
  if (channel === 'whatsapp' && c.dues_on_hold) throw new AppError(400, 'ON_HOLD', `${c.name}'s dues are marked as old dues (record only). Remove that mark in Customers to send reminders.`);
  const lang = input.language ?? c.language ?? s.reminderLanguage;
  const message = reminderMessage(lang, {
    customerName: c.name,
    balancePaise: d.balancePaise,
    overduePaise: d.overduePaise,
    oldestBill: d.oldest && d.oldest.id ? { number: d.oldest.number, date: d.oldest.date, days: d.oldest.days } : null,
    asOf,
    shopName: s.storeName,
    shopPhone: s.storePhone || null,
    upiId: s.storeUpiId || null,
  });
  let url: string | null = null;
  if (channel === 'whatsapp') {
    const phone = whatsappNumber(c.phone);
    if (!phone) throw new AppError(400, 'NO_MOBILE', `${c.name} has no mobile number. Add it in Customers.`);
    url = whatsappLink(phone, message);
  }
  const [r] = await sql<{ id: number }[]>`
    insert into reminders (customer_id, channel, language, balance_paise, overdue_paise, message, note, user_id, device_id)
    values (${c.id}, ${channel}, ${lang}, ${d.balancePaise}, ${d.overduePaise}, ${channel === 'whatsapp' ? message : null}, ${input.note?.trim() || null}, ${ctx.userId}, ${ctx.deviceId})
    returning id`;
  await audit(sql, ctx, 'customer.reminded', { entity: 'customer', entityId: c.id, details: { channel, balancePaise: d.balancePaise } });
  return { id: r!.id, url, message, language: lang };
}

export async function listReminders(q: Q, ctx: Ctx, customerId: number) {
  canSeeKhata(ctx);
  return q`
    select m.id, m.at, m.channel, m.language, m.balance_paise, m.overdue_paise, m.note, u.name as user_name
    from reminders m join users u on u.id = m.user_id where m.customer_id = ${customerId} order by m.id desc limit 50`;
}

import { formatPaise, istDate } from '@kph/core';
import type { Q } from '../db/connect.js';
import { AppError, can, type Ctx } from './common.js';
import { getSettings } from './settings.js';

/**
 * The owner's view (Phase 7): today on one phone screen, and a daily summary made at closing
 * time that can be sent on WhatsApp or by e-mail. (A WhatsApp Business API sender can be plugged
 * in later: the summary text is already built here.)
 */

const r = (p: number) => `₹${formatPaise(p).replace(/\.00$/, '')}`;

export async function ownerDay(q: Q, ctx: Ctx | null, date = istDate()) {
  if (ctx && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'Only the owner / admin can see this');
  const s = await getSettings(q);
  const [sales] = await q<{ bills: number; total: number; cash: number; upi: number; card: number; credit: number; discount: number; cancelled: number }[]>`
    select count(*) filter (where status = 'posted')::int as bills,
           coalesce(sum(total_paise) filter (where status = 'posted'), 0)::bigint as total,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'cash'), 0)::bigint as cash,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'upi'), 0)::bigint as upi,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'card'), 0)::bigint as card,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'credit'), 0)::bigint as credit,
           coalesce(sum(discount_paise) filter (where status = 'posted'), 0)::bigint as discount,
           count(*) filter (where status = 'cancelled')::int as cancelled
    from sales_invoices where invoice_date = ${date}`;
  const [coll] = await q<{ n: number; total: number }[]>`
    select count(*)::int as n, coalesce(sum(amount_paise), 0)::bigint as total from receipts where receipt_date = ${date} and status = 'posted'`;
  const [ret] = await q<{ n: number; total: number }[]>`
    select count(*)::int as n, coalesce(sum(total_paise), 0)::bigint as total from credit_notes where note_date = ${date} and status = 'posted'`;
  const [cash] = await q<{ bal: number }[]>`
    select l.opening_dr_paise + coalesce((select sum(vl.dr_paise - vl.cr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id where vl.ledger_id = l.id and v.vdate <= ${date}), 0) as bal
    from ledgers l where l.system_code = 'cash'`;
  const [exp] = await q<{ total: number }[]>`
    select coalesce(sum(amount_paise), 0)::bigint as total from money_entries where entry_date = ${date} and status = 'posted' and kind = 'expense'`;
  const [buy] = await q<{ n: number; total: number }[]>`
    select count(*)::int as n, coalesce(sum(total_paise), 0)::bigint as total from purchase_invoices where (at at time zone 'Asia/Kolkata')::date = ${date} and status = 'posted'`;
  const [stock] = await q<{ low: number; out: number }[]>`
    select count(*) filter (where coalesce(sb.qty_milli, 0) > 0 and coalesce(sb.qty_milli, 0) <= coalesce(p.reorder_level_milli, ${s.lowStockThresholdMilli}))::int as low,
           count(*) filter (where coalesce(sb.qty_milli, 0) <= 0)::int as out
    from products p left join stock_balances sb on sb.product_id = p.id where p.active`;
  const deliveries = await q<{ status: string; n: number }[]>`
    select status, count(*)::int as n from deliveries where status in ('pending', 'out') and delivery_date <= ${date} group by status`;
  const topPartners = await q<{ name: string; bills: number; total: number }[]>`
    select pa.name, count(*)::int as bills, coalesce(sum(si.total_paise), 0)::bigint as total
    from invoice_partners ip join sales_invoices si on si.id = ip.invoice_id join partners pa on pa.id = ip.partner_id
    where si.status = 'posted' and si.invoice_date = ${date} group by pa.name order by total desc limit 5`;
  const topItems = await q<{ name: string; qty: number; unit: string; amount: number }[]>`
    select l.product_name as name, sum(l.base_qty_milli)::bigint as qty, min(p.unit_code) as unit, sum(l.taxable_paise)::bigint as amount
    from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id join products p on p.id = l.product_id
    where si.status = 'posted' and si.invoice_date = ${date} group by l.product_name order by amount desc limit 5`;
  const alerts = await q<{ action: string; n: number; latest: string }[]>`
    select action, count(*)::int as n, max(at)::text as latest from audit_log
    where (at at time zone 'Asia/Kolkata')::date = ${date}
      and action in ('discount.over_limit', 'invoice.cancelled', 'override.approved', 'credit.over_limit', 'receipt.cancelled', 'stock.adjusted', 'stock.audit_closed', 'cash.closed', 'counter.closed')
    group by action`;
  const [diffs] = await q<{ cash_diff: number }[]>`
    select coalesce(sum(difference_paise), 0)::bigint as cash_diff from counter_closings where close_date = ${date}`;
  return {
    date,
    sales: sales!,
    collections: coll!,
    returns: ret!,
    cashInHandPaise: cash?.bal ?? 0,
    expensesPaise: exp!.total,
    purchases: buy!,
    stock: stock!,
    deliveries: { pending: deliveries.find((d) => d.status === 'pending')?.n ?? 0, out: deliveries.find((d) => d.status === 'out')?.n ?? 0 },
    topPartners,
    topItems,
    alerts: Object.fromEntries(alerts.map((a) => [a.action, a.n])) as Record<string, number>,
    counterCashDifferencePaise: diffs!.cash_diff,
  };
}

export type OwnerDay = Awaited<ReturnType<typeof ownerDay>>;

/** The day in a few lines, in English and Telugu. */
export function summaryText(d: OwnerDay, shop: string, extra: { overduePaise: number; runOutSoon: string[] }) {
  const dd = `${d.date.slice(8, 10)}-${d.date.slice(5, 7)}-${d.date.slice(0, 4)}`;
  const a = d.alerts;
  const alertsEn = [
    a['invoice.cancelled'] ? `${a['invoice.cancelled']} bill(s) cancelled` : null,
    a['discount.over_limit'] ? `${a['discount.over_limit']} discount(s) above limit` : null,
    a['override.approved'] ? `${a['override.approved']} admin PIN approval(s)` : null,
    a['credit.over_limit'] ? `${a['credit.over_limit']} credit bill(s) over limit` : null,
    d.counterCashDifferencePaise ? `counter cash difference ${r(d.counterCashDifferencePaise)}` : null,
  ].filter(Boolean);
  const alertsTe = [
    a['invoice.cancelled'] ? `${a['invoice.cancelled']} బిల్లులు రద్దు` : null,
    a['discount.over_limit'] ? `${a['discount.over_limit']} పరిమితికి మించిన డిస్కౌంట్లు` : null,
    a['override.approved'] ? `${a['override.approved']} అడ్మిన్ PIN అనుమతులు` : null,
    a['credit.over_limit'] ? `${a['credit.over_limit']} క్రెడిట్ పరిమితి దాటిన బిల్లులు` : null,
    d.counterCashDifferencePaise ? `కౌంటర్ నగదు తేడా ${r(d.counterCashDifferencePaise)}` : null,
  ].filter(Boolean);
  const en = [
    `${shop} — ${dd}`,
    `Sales ${r(d.sales.total)} (${d.sales.bills} bills): cash ${r(d.sales.cash)}, UPI ${r(d.sales.upi)}, card ${r(d.sales.card)}, credit ${r(d.sales.credit)}`,
    `Collected ${r(d.collections.total)} from ${d.collections.n} customer(s)${d.returns.n ? `; returns ${r(d.returns.total)}` : ''}`,
    `Expenses ${r(d.expensesPaise)}${d.purchases.n ? `; purchases ${r(d.purchases.total)} (${d.purchases.n})` : ''}`,
    `Cash in hand ${r(d.cashInHandPaise)}`,
    d.topItems.length ? `Top: ${d.topItems.slice(0, 3).map((i) => i.name).join(', ')}` : null,
    d.topPartners.length ? `Partners: ${d.topPartners.slice(0, 3).map((p) => `${p.name} ${r(p.total)}`).join(', ')}` : null,
    extra.overduePaise ? `Overdue from customers ${r(extra.overduePaise)}` : null,
    extra.runOutSoon.length ? `Running out: ${extra.runOutSoon.slice(0, 5).join(', ')}` : null,
    d.deliveries.pending + d.deliveries.out ? `Deliveries not done: ${d.deliveries.pending + d.deliveries.out}` : null,
    alertsEn.length ? `Check: ${alertsEn.join('; ')}` : 'No alerts.',
  ].filter(Boolean);
  const te = [
    `${shop} — ${dd}`,
    `అమ్మకాలు ${r(d.sales.total)} (${d.sales.bills} బిల్లులు): నగదు ${r(d.sales.cash)}, UPI ${r(d.sales.upi)}, కార్డ్ ${r(d.sales.card)}, అప్పు ${r(d.sales.credit)}`,
    `వసూలు ${r(d.collections.total)} (${d.collections.n} మంది)${d.returns.n ? `; వాపసులు ${r(d.returns.total)}` : ''}`,
    `ఖర్చులు ${r(d.expensesPaise)}${d.purchases.n ? `; కొనుగోళ్లు ${r(d.purchases.total)} (${d.purchases.n})` : ''}`,
    `చేతిలో నగదు ${r(d.cashInHandPaise)}`,
    d.topItems.length ? `ఎక్కువగా అమ్మినవి: ${d.topItems.slice(0, 3).map((i) => i.name).join(', ')}` : null,
    d.topPartners.length ? `భాగస్వాములు: ${d.topPartners.slice(0, 3).map((p) => `${p.name} ${r(p.total)}`).join(', ')}` : null,
    extra.overduePaise ? `గడువు దాటిన బాకీలు ${r(extra.overduePaise)}` : null,
    extra.runOutSoon.length ? `అయిపోతున్నవి: ${extra.runOutSoon.slice(0, 5).join(', ')}` : null,
    d.deliveries.pending + d.deliveries.out ? `పూర్తికాని డెలివరీలు: ${d.deliveries.pending + d.deliveries.out}` : null,
    alertsTe.length ? `చూడండి: ${alertsTe.join('; ')}` : 'హెచ్చరికలు లేవు.',
  ].filter(Boolean);
  return { en: en.join('\n'), te: te.join('\n') };
}

/** Make (or remake) the day's summary and keep it. Run by the daily job at closing time. */
export async function makeDailySummary(sql: import('../db/connect.js').Sql, date = istDate()) {
  const { ALL_PERMISSIONS } = await import('@kph/core');
  const [admin] = await sql<{ id: number }[]>`select id from users where role_id = 'admin' and active order by id limit 1`;
  if (!admin) throw new AppError(400, 'NO_ADMIN', 'No admin user');
  const ctx: Ctx = { userId: admin.id, deviceId: null, permissions: ALL_PERMISSIONS };
  const { dueList } = await import('./khata.js');
  const { stockInsights } = await import('./stockcontrol.js');
  const s = await getSettings(sql);
  const d = await ownerDay(sql, ctx, date);
  const due = await dueList(sql, ctx, date);
  const ins = await stockInsights(sql, ctx, { asOf: date });
  const extra = { overduePaise: due.overduePaise, runOutSoon: ins.daily.runOut3.map((x) => x.name) };
  const t = summaryText(d, s.storeName, extra);
  const data = { ...d, ...extra };
  await sql`
    insert into daily_summaries (summary_date, data, text_en, text_te) values (${date}, ${sql.json(data as never)}, ${t.en}, ${t.te})
    on conflict (summary_date) do update set data = excluded.data, text_en = excluded.text_en, text_te = excluded.text_te, made_at = now()`;
  return { date, ...t, data };
}

export async function getDailySummary(sql: import('../db/connect.js').Sql, ctx: Ctx, date: string) {
  if (!can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'Only the owner / admin can see this');
  const [row] = await sql<{ summary_date: string; made_at: string; text_en: string; text_te: string }[]>`
    select summary_date::text, made_at::text, text_en, text_te from daily_summaries where summary_date = ${date}`;
  if (row) return { date: row.summary_date, madeAt: row.made_at, en: row.text_en, te: row.text_te };
  const m = await makeDailySummary(sql, date);
  return { date, madeAt: new Date().toISOString(), en: m.en, te: m.te };
}

export async function listDailySummaries(q: Q, ctx: Ctx) {
  if (!can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'Only the owner / admin can see this');
  return q`select summary_date::text as date, made_at, text_en from daily_summaries order by summary_date desc limit 60`;
}

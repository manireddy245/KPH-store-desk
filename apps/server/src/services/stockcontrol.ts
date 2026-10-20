import { classify, costValuePaise, forecastDaily, formatQty, fyStartYear, istDate, reorderAdvice, type Movement } from '@kph/core';
import type { Q, Sql } from '../db/connect.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';
import { nextDocNumber } from './ledger.js';
import { lockProducts } from './products.js';
import { getSettings } from './settings.js';

/**
 * Phase 6B — stock control:
 *  - stock audits (count, compare with the books, adjust with a reason)
 *  - insights: fast / slow / dead, days of stock left, reorder suggestions with the numbers behind them
 *  - purchase orders from the reorder list (nothing is ever ordered without the owner)
 *  - day-end closing per counter
 */

const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

function canSeeStock(ctx: Ctx) {
  if (!can(ctx, 'stock.adjust') && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see stock insights');
}

// ------------------------------------------------------------------ insights

export interface InsightRow {
  productId: number;
  name: string;
  sku: string;
  unit: string;
  category: string | null;
  categoryId: number | null;
  brand: string | null;
  stockMilli: number;
  /** Cost per unit, 4 decimals (1/10,000 rupee). */
  costCp: number | null;
  valuePaise: number | null;
  soldMilli: number;
  soldPaise: number;
  prevSoldMilli: number;
  lastSale: string | null;
  daysSinceSale: number | null;
  movement: Movement;
  dailyMilli: number;
  seasonal: boolean;
  daysLeft: number | null;
  onOrderMilli: number;
  leadDays: number;
  targetDays: number;
  supplierId: number | null;
  supplierName: string | null;
  orderNow: boolean;
  suggestMilli: number;
  why: string;
  usualMaxMilli: number;
  decision: { action: string; note: string | null; at: string } | null;
}

export async function stockInsights(q: Q, ctx: Ctx, opts: { asOf?: string } = {}) {
  canSeeStock(ctx);
  const s = await getSettings(q);
  const today = opts.asOf ?? istDate();
  const N = s.insightDays;
  const rows = await q<{
    id: number; name: string; sku: string; unit_code: string; category_id: number | null; category: string | null; brand: string | null; target_days: number | null;
    stock: number; cost: number | null; age_days: number; sold: number; sold_value: number; prev_sold: number; last_sale: string | null;
    ly_same: number; ly_next: number; on_order: number; supplier_id: number | null; supplier_name: string | null; lead_days: number | null;
  }[]>`
    with sales as (
      select l.product_id, si.invoice_date as d, l.base_qty_milli as q, l.taxable_paise as v
      from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id
      where si.status = 'posted' and si.invoice_date > ${today}::date - 400
      union all
      select cl.product_id, cn.note_date, -cl.base_qty_milli, -cl.taxable_paise
      from credit_note_lines cl join credit_notes cn on cn.id = cl.credit_note_id
      where cn.status = 'posted' and cn.note_date > ${today}::date - 400
    ),
    agg as (
      select product_id,
             sum(q) filter (where d > ${today}::date - ${N}::int and d <= ${today}::date) as sold,
             sum(v) filter (where d > ${today}::date - ${N}::int and d <= ${today}::date) as sold_value,
             sum(q) filter (where d > ${today}::date - ${2 * N}::int and d <= ${today}::date - ${N}::int) as prev_sold,
             sum(q) filter (where d > ${today}::date - 365 - ${N}::int and d <= ${today}::date - 365) as ly_same,
             sum(q) filter (where d > ${today}::date - 365 and d <= ${today}::date - 365 + ${N}::int) as ly_next
      from sales group by product_id
    ),
    last_sale as (
      select l.product_id, max(si.invoice_date)::text as last_sale
      from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id where si.status = 'posted' group by l.product_id
    ),
    on_order as (
      select ol.product_id, sum(ol.qty_milli) as q from purchase_order_lines ol join purchase_orders po on po.id = ol.po_id
      where po.status in ('draft', 'sent') group by ol.product_id
    ),
    last_supplier as (
      select distinct on (pl.product_id) pl.product_id, pi.supplier_id
      from purchase_lines pl join purchase_invoices pi on pi.id = pl.purchase_id where pi.status = 'posted'
      order by pl.product_id, pi.id desc
    )
    select p.id, p.name, p.sku, p.unit_code, p.category_id, c.name as category, b.name as brand, c.target_days,
           coalesce(sb.qty_milli, 0) as stock, p.cost_price_cp as cost, (${today}::date - p.created_at::date) as age_days,
           coalesce(a.sold, 0)::bigint as sold, coalesce(a.sold_value, 0)::bigint as sold_value, coalesce(a.prev_sold, 0)::bigint as prev_sold,
           ls2.last_sale, coalesce(a.ly_same, 0)::bigint as ly_same, coalesce(a.ly_next, 0)::bigint as ly_next,
           coalesce(oo.q, 0)::bigint as on_order, ls.supplier_id, su.name as supplier_name, su.lead_time_days as lead_days
    from products p
    left join categories c on c.id = p.category_id left join brands b on b.id = p.brand_id
    left join stock_balances sb on sb.product_id = p.id
    left join agg a on a.product_id = p.id left join last_sale ls2 on ls2.product_id = p.id left join on_order oo on oo.product_id = p.id
    left join last_supplier ls on ls.product_id = p.id left join suppliers su on su.id = ls.supplier_id
    where p.active and not p.is_service
    order by lower(p.name)`;
  const [{ first } = { first: null }] = await q<{ first: string | null }[]>`select min(invoice_date)::text as first from sales_invoices where status = 'posted'`;
  const hasYear = !!first && first <= new Date(Date.parse(today) - 365 * 86_400_000).toISOString().slice(0, 10);
  const decisions = await q<{ product_id: number; action: string; note: string | null; at: string }[]>`
    select distinct on (product_id) product_id, action, note, at::text from stock_decisions order by product_id, id desc`;
  const decided = new Map(decisions.map((d) => [d.product_id, d]));

  const daysSince = (d: string | null) => (d ? Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000) : null);
  const classes = classify(
    rows.map((r) => ({ productId: r.id, categoryId: r.category_id, soldMilli: Math.max(r.sold, 0), soldPaise: Math.max(r.sold_value, 0), daysSinceSale: daysSince(r.last_sale), ageDays: r.age_days })),
    { periodDays: N, deadDays: s.deadStockDays },
  );
  const showCost = can(ctx, 'products.view_cost');

  const out: InsightRow[] = rows.map((r) => {
    const recent = Math.max(r.sold, 0) / N;
    const daily = Math.round(hasYear ? forecastDaily(recent, Math.max(r.ly_next, 0) / N, Math.max(r.ly_same, 0) / N) : recent);
    const targetDays = r.target_days ?? s.targetDaysDefault;
    const leadDays = r.lead_days ?? s.leadDaysDefault;
    const fmt = (m: number) => `${formatQty(Math.round(m))} ${r.unit_code}`;
    const a = reorderAdvice({ stockMilli: r.stock, onOrderMilli: r.on_order, dailyMilli: daily, targetDays, leadDays }, fmt);
    const movement = classes.get(r.id)!;
    // slow and dead items shouldn't be bought beyond their usual level
    const usualMaxMilli = movement === 'dead' ? 0 : Math.round(daily * (targetDays + leadDays) * 1.5);
    const sold = `sold ${fmt(Math.max(r.sold, 0))} in the last ${N} days`;
    return {
      productId: r.id,
      name: r.name,
      sku: r.sku,
      unit: r.unit_code,
      category: r.category,
      categoryId: r.category_id,
      brand: r.brand,
      stockMilli: r.stock,
      costCp: showCost ? r.cost : null,
      valuePaise: showCost ? costValuePaise(Math.max(r.stock, 0), r.cost ?? 0) : null,
      soldMilli: r.sold,
      soldPaise: r.sold_value,
      prevSoldMilli: r.prev_sold,
      lastSale: r.last_sale,
      daysSinceSale: daysSince(r.last_sale),
      movement,
      dailyMilli: daily,
      seasonal: hasYear && daily !== Math.round(recent),
      daysLeft: a.daysLeft,
      onOrderMilli: r.on_order,
      leadDays,
      targetDays,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      orderNow: a.orderNow && movement !== 'dead',
      suggestMilli: movement === 'dead' || decided.get(r.id)?.action === 'dont_reorder' ? 0 : a.suggestMilli,
      why: `${sold}; ${a.why}`,
      usualMaxMilli,
      decision: decided.get(r.id) ?? null,
    };
  });

  const slowDead = out.filter((r) => r.movement === 'slow' || r.movement === 'dead');
  const changes = out
    .filter((r) => r.prevSoldMilli > 0 || r.soldMilli > 0)
    .map((r) => ({ ...r, ratio: r.prevSoldMilli > 0 ? r.soldMilli / r.prevSoldMilli : r.soldMilli > 0 ? 9 : 0 }))
    .filter((r) => (r.ratio >= 1.5 || r.ratio <= 0.67) && Math.max(r.soldMilli, r.prevSoldMilli) >= 5000);
  return {
    asOf: today,
    periodDays: N,
    deadDays: s.deadStockDays,
    seasonal: hasYear,
    rows: out,
    daily: {
      runOut3: out.filter((r) => r.daysLeft != null && r.daysLeft <= 3 && r.movement !== 'dead'),
      runOut7: out.filter((r) => r.daysLeft != null && r.daysLeft > 3 && r.daysLeft <= 7 && r.movement !== 'dead'),
      fastBelowTarget: out.filter((r) => r.movement === 'fast' && r.daysLeft != null && r.daysLeft < r.targetDays),
      topSlowByValue: [...slowDead].sort((a, b) => (b.valuePaise ?? b.stockMilli) - (a.valuePaise ?? a.stockMilli)).slice(0, 5),
      newlyDead: out.filter((r) => r.movement === 'dead' && r.daysSinceSale != null && r.daysSinceSale < s.deadStockDays + 7),
    },
    weekly: {
      spedUp: changes.filter((r) => r.ratio >= 1.5).sort((a, b) => b.ratio - a.ratio).slice(0, 10),
      slowedDown: changes.filter((r) => r.ratio <= 0.67).sort((a, b) => a.ratio - b.ratio).slice(0, 10),
      slowDeadValuePaise: showCost ? slowDead.reduce((t, r) => t + (r.valuePaise ?? 0), 0) : null,
      slowDeadItems: slowDead.length,
    },
  };
}

export async function decideItem(sql: Sql, ctx: Ctx, productId: number, input: { action: 'dont_reorder' | 'offer' | 'tell_partners' | 'return_to_supplier' | 'keep'; note?: string }) {
  if (!can(ctx, 'stock.adjust') && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to do this');
  const [d] = await sql<{ id: number }[]>`insert into stock_decisions (product_id, action, note, user_id) values (${productId}, ${input.action}, ${clean(input.note)}, ${ctx.userId}) returning id`;
  await audit(sql, ctx, 'stock.decision', { entity: 'product', entityId: productId, details: input });
  return { id: d!.id };
}

export async function setTargetDays(sql: Sql, ctx: Ctx, categoryId: number, days: number | null) {
  requirePerm(ctx, 'products.manage', 'Only admin can change this');
  if (days != null && (!Number.isInteger(days) || days < 1 || days > 180)) throw new AppError(400, 'BAD_DAYS', 'Target days must be 1–180');
  await sql`update categories set target_days = ${days} where id = ${categoryId}`;
  return { ok: true };
}

// ------------------------------------------------------------------ purchase orders

/** Make draft purchase orders from chosen reorder suggestions, one per supplier. */
export async function createPurchaseOrders(sql: Sql, ctx: Ctx, items: { productId: number; qtyMilli: number; supplierId: number }[]) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can make purchase orders');
  const good = items.filter((i) => i.qtyMilli > 0);
  if (!good.length) throw new AppError(400, 'NO_LINES', 'Choose what to order');
  const bySupplier = new Map<number, typeof good>();
  for (const i of good) bySupplier.set(i.supplierId, [...(bySupplier.get(i.supplierId) ?? []), i]);
  const s = await getSettings(sql);
  return sql.begin(async (tx) => {
    const made: { id: number; number: string; supplierId: number }[] = [];
    for (const [supplierId, lines] of bySupplier) {
      const [sup] = await tx`select 1 from suppliers where id = ${supplierId}`;
      if (!sup) throw new AppError(400, 'NO_SUPPLIER', 'Supplier not found');
      const fy = fyStartYear(new Date());
      const n = await nextDocNumber(tx, 'po', s.poPrefix, fy);
      const [po] = await tx<{ id: number }[]>`insert into purchase_orders (number, fy_start, seq, supplier_id, user_id) values (${n.number}, ${fy}, ${n.seq}, ${supplierId}, ${ctx.userId}) returning id`;
      const merged = new Map<number, number>();
      for (const l of lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.qtyMilli);
      await tx`insert into purchase_order_lines ${tx([...merged].map(([product_id, qty_milli]) => ({ po_id: po!.id, product_id, qty_milli })))}`;
      made.push({ id: po!.id, number: n.number, supplierId });
    }
    await audit(tx, ctx, 'po.created', { details: { orders: made.map((m) => m.number) } });
    return made;
  });
}

export async function listPurchaseOrders(q: Q, ctx: Ctx, f: { status?: string }) {
  canSeeStock(ctx);
  return q`
    select po.id, po.number, po.status, po.created_at, po.sent_at, po.expected_on, s.name as supplier_name, s.phone as supplier_phone,
           (select count(*)::int from purchase_order_lines l where l.po_id = po.id) as items
    from purchase_orders po join suppliers s on s.id = po.supplier_id
    where (${f.status ?? null}::text is null or po.status = ${f.status ?? null})
    order by po.id desc limit 300`;
}

export async function getPurchaseOrder(q: Q, ctx: Ctx, id: number) {
  canSeeStock(ctx);
  const [po] = await q`
    select po.*, s.name as supplier_name, s.phone as supplier_phone, s.address as supplier_address, s.gstin as supplier_gstin, u.name as user_name
    from purchase_orders po join suppliers s on s.id = po.supplier_id join users u on u.id = po.user_id where po.id = ${id}`;
  if (!po) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found');
  const lines = await q`
    select l.id, l.product_id, p.name, p.sku, p.unit_code, l.qty_milli, l.note,
           coalesce((select qty_milli from stock_balances where product_id = p.id), 0) as stock_milli
    from purchase_order_lines l join products p on p.id = l.product_id where l.po_id = ${id} order by p.name`;
  const s = await getSettings(q);
  return { ...po, lines, store: { name: s.storeName, address: s.storeAddress, phone: s.storePhone, gstin: s.storeGstin, labels: s.invoiceLabels } };
}

export async function updatePurchaseOrder(sql: Sql, ctx: Ctx, id: number, input: { lines?: { productId: number; qtyMilli: number }[]; status?: 'draft' | 'sent' | 'received' | 'cancelled'; expectedOn?: string | null; notes?: string | null }) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can change purchase orders');
  return sql.begin(async (tx) => {
    const [po] = await tx<{ status: string; number: string }[]>`select status, number from purchase_orders where id = ${id} for update`;
    if (!po) throw new AppError(404, 'NOT_FOUND', 'Purchase order not found');
    if (po.status === 'received' || po.status === 'cancelled') throw new AppError(409, 'CLOSED', `${po.number} is ${po.status}`);
    if (input.lines) {
      if (po.status !== 'draft') throw new AppError(409, 'SENT', 'Only a draft order can be changed');
      await tx`delete from purchase_order_lines where po_id = ${id}`;
      const lines = input.lines.filter((l) => l.qtyMilli > 0);
      if (lines.length) await tx`insert into purchase_order_lines ${tx(lines.map((l) => ({ po_id: id, product_id: l.productId, qty_milli: l.qtyMilli })))}`;
    }
    if (input.status) {
      await tx`update purchase_orders set status = ${input.status},
               sent_at = case when ${input.status} = 'sent' then now() else sent_at end,
               closed_at = case when ${input.status} in ('received', 'cancelled') then now() else closed_at end where id = ${id}`;
    }
    if (input.expectedOn !== undefined) await tx`update purchase_orders set expected_on = ${input.expectedOn} where id = ${id}`;
    if (input.notes !== undefined) await tx`update purchase_orders set notes = ${clean(input.notes)} where id = ${id}`;
    await audit(tx, ctx, 'po.updated', { entity: 'purchase_order', entityId: id, details: { number: po.number, status: input.status } });
    return { ok: true };
  });
}

// ------------------------------------------------------------------ stock audit

export async function startAudit(sql: Sql, ctx: Ctx, input: { title?: string; categoryId?: number | null }) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can count stock');
  const s = await getSettings(sql);
  return sql.begin(async (tx) => {
    const fy = fyStartYear(new Date());
    const n = await nextDocNumber(tx, 'audit', s.auditPrefix, fy);
    const [a] = await tx<{ id: number }[]>`
      insert into stock_audits (number, fy_start, seq, title, category_id, user_id) values (${n.number}, ${fy}, ${n.seq}, ${clean(input.title)}, ${input.categoryId ?? null}, ${ctx.userId}) returning id`;
    return { id: a!.id, number: n.number };
  });
}

export async function getAudit(q: Q, ctx: Ctx, id: number) {
  canSeeStock(ctx);
  const [a] = await q<{ id: number; number: string; title: string | null; category_id: number | null; category: string | null; status: string; started_at: string; closed_at: string | null; user_name: string }[]>`
    select a.id, a.number, a.title, a.category_id, c.name as category, a.status, a.started_at, a.closed_at, u.name as user_name
    from stock_audits a left join categories c on c.id = a.category_id join users u on u.id = a.user_id where a.id = ${id}`;
  if (!a) throw new AppError(404, 'NOT_FOUND', 'Stock count not found');
  const items = await q<{ product_id: number; name: string; sku: string; unit_code: string; category: string | null; book_milli: number; cost: number | null; line_id: number | null; system_milli: number | null; counted_milli: number | null; reason: string | null; note: string | null; adjusted: boolean | null; counted_by: string | null }[]>`
    select p.id as product_id, p.name, p.sku, p.unit_code, c.name as category, coalesce(sb.qty_milli, 0) as book_milli, p.cost_price_cp as cost,
           l.id as line_id, l.system_milli, l.counted_milli, l.reason, l.note, l.adjusted, u.name as counted_by
    from products p left join categories c on c.id = p.category_id left join stock_balances sb on sb.product_id = p.id
         left join stock_audit_lines l on l.product_id = p.id and l.audit_id = ${id} left join users u on u.id = l.counted_by
    where p.active and not p.is_service and (${a.category_id}::int is null or p.category_id = ${a.category_id})
    order by c.name nulls last, lower(p.name)`;
  const showCost = can(ctx, 'products.view_cost');
  const counted = items.filter((i) => i.line_id != null);
  const diffs = counted.filter((i) => i.counted_milli! !== i.system_milli!);
  return {
    ...a,
    items: items.map((i) => ({ ...i, cost: showCost ? i.cost : null, diff_milli: i.line_id != null ? i.counted_milli! - i.system_milli! : null })),
    summary: {
      products: items.length,
      counted: counted.length,
      differences: diffs.length,
      shortValuePaise: showCost ? diffs.filter((i) => i.counted_milli! < i.system_milli!).reduce((t, i) => t + costValuePaise(i.system_milli! - i.counted_milli!, i.cost ?? 0), 0) : null,
      excessValuePaise: showCost ? diffs.filter((i) => i.counted_milli! > i.system_milli!).reduce((t, i) => t + costValuePaise(i.counted_milli! - i.system_milli!, i.cost ?? 0), 0) : null,
    },
  };
}

export async function listAudits(q: Q, ctx: Ctx) {
  canSeeStock(ctx);
  return q`
    select a.id, a.number, a.title, c.name as category, a.status, a.started_at, a.closed_at, u.name as user_name,
           (select count(*)::int from stock_audit_lines l where l.audit_id = a.id) as counted,
           (select count(*)::int from stock_audit_lines l where l.audit_id = a.id and l.counted_milli <> l.system_milli) as differences
    from stock_audits a left join categories c on c.id = a.category_id join users u on u.id = a.user_id order by a.id desc limit 100`;
}

/** Record what was counted on the shelf. The book figure is noted at the same moment, so later sales don't confuse the difference. */
export async function recordCount(sql: Sql, ctx: Ctx, auditId: number, input: { productId: number; countedMilli: number; reason?: string | null; note?: string | null }) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can count stock');
  if (!Number.isSafeInteger(input.countedMilli) || input.countedMilli < 0) throw new AppError(400, 'BAD_QTY', 'Enter the quantity counted');
  return sql.begin(async (tx) => {
    const [a] = await tx<{ status: string }[]>`select status from stock_audits where id = ${auditId} for update`;
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Stock count not found');
    if (a.status !== 'open') throw new AppError(409, 'CLOSED', 'This stock count is closed');
    await lockProducts(tx, [input.productId]);
    const [b] = await tx<{ q: number }[]>`select coalesce((select qty_milli from stock_balances where product_id = ${input.productId}), 0) as q`;
    await tx`
      insert into stock_audit_lines (audit_id, product_id, system_milli, counted_milli, reason, note, counted_by)
      values (${auditId}, ${input.productId}, ${b!.q}, ${input.countedMilli}, ${input.reason ?? null}, ${clean(input.note)}, ${ctx.userId})
      on conflict (audit_id, product_id) do update set system_milli = excluded.system_milli, counted_milli = excluded.counted_milli,
        reason = excluded.reason, note = excluded.note, counted_by = excluded.counted_by, counted_at = now()`;
    return { systemMilli: b!.q, diffMilli: input.countedMilli - b!.q };
  });
}

/** Close the count: every difference becomes a stock adjustment with its reason. */
export async function closeAudit(sql: Sql, ctx: Ctx, auditId: number) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can close a stock count');
  return sql.begin(async (tx) => {
    const [a] = await tx<{ status: string; number: string }[]>`select status, number from stock_audits where id = ${auditId} for update`;
    if (!a) throw new AppError(404, 'NOT_FOUND', 'Stock count not found');
    if (a.status !== 'open') throw new AppError(409, 'CLOSED', 'This stock count is already closed');
    const lines = await tx<{ id: number; product_id: number; name: string; system_milli: number; counted_milli: number; reason: string | null; note: string | null; cost: number | null }[]>`
      select l.id, l.product_id, p.name, l.system_milli, l.counted_milli, l.reason, l.note, p.cost_price_cp as cost
      from stock_audit_lines l join products p on p.id = l.product_id where l.audit_id = ${auditId} and l.counted_milli <> l.system_milli and not l.adjusted`;
    const missing = lines.filter((l) => !l.reason);
    if (missing.length) throw new AppError(400, 'REASON_REQUIRED', `Give a reason for every difference (${missing.slice(0, 3).map((m) => m.name).join(', ')}${missing.length > 3 ? '…' : ''})`, { productIds: missing.map((m) => m.product_id) });
    if (lines.length) {
      await lockProducts(tx, lines.map((l) => l.product_id));
      await tx`insert into stock_movements ${tx(
        lines.map((l) => ({
          product_id: l.product_id,
          qty_milli: l.counted_milli - l.system_milli,
          kind: 'audit',
          ref_type: 'stock_audit',
          ref_id: auditId,
          unit_cost_cp: l.cost,
          reason: `${a.number}: ${l.reason}${l.note ? ` — ${l.note}` : ''}`,
          user_id: ctx.userId,
          device_id: ctx.deviceId,
        })),
      )}`;
      await tx`update stock_audit_lines set adjusted = true where id = any(${lines.map((l) => l.id)})`;
    }
    await tx`update stock_audits set status = 'closed', closed_at = now(), closed_by = ${ctx.userId} where id = ${auditId}`;
    await audit(tx, ctx, 'stock.audit_closed', { entity: 'stock_audit', entityId: auditId, details: { number: a.number, adjustments: lines.length } });
    return { adjusted: lines.length };
  });
}

// ------------------------------------------------------------------ day-end closing per counter

/** What one counter took today: by payment mode, by staff, collections, refunds and cash paid out. */
export async function counterSummary(q: Q, ctx: Ctx, input: { date: string; deviceId: number | null; floatPaise?: number }) {
  if (!can(ctx, 'payments.receive') && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to close a counter');
  const dev = input.deviceId;
  const [sales] = await q<{ bills: number; total: number; cash: number; upi: number; card: number; credit: number; cancelled: number }[]>`
    select count(*) filter (where status = 'posted')::int as bills,
           coalesce(sum(total_paise) filter (where status = 'posted'), 0)::bigint as total,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'cash'), 0)::bigint as cash,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'upi'), 0)::bigint as upi,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'card'), 0)::bigint as card,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'credit'), 0)::bigint as credit,
           count(*) filter (where status = 'cancelled')::int as cancelled
    from sales_invoices where invoice_date = ${input.date} and device_id is not distinct from ${dev}`;
  const [rec] = await q<{ n: number; total: number; cash: number; upi: number; card: number; bank: number; cheque: number }[]>`
    select count(*)::int as n, coalesce(sum(amount_paise), 0)::bigint as total,
           coalesce(sum(amount_paise) filter (where mode = 'cash'), 0)::bigint as cash,
           coalesce(sum(amount_paise) filter (where mode = 'upi'), 0)::bigint as upi,
           coalesce(sum(amount_paise) filter (where mode = 'card'), 0)::bigint as card,
           coalesce(sum(amount_paise) filter (where mode = 'bank'), 0)::bigint as bank,
           coalesce(sum(amount_paise) filter (where mode = 'cheque'), 0)::bigint as cheque
    from receipts where receipt_date = ${input.date} and status = 'posted' and device_id is not distinct from ${dev}`;
  const [ref] = await q<{ cash: number; other: number }[]>`
    select coalesce(sum(total_paise) filter (where refund_mode = 'cash'), 0)::bigint as cash,
           coalesce(sum(total_paise) filter (where refund_mode in ('upi', 'card', 'bank')), 0)::bigint as other
    from credit_notes where note_date = ${input.date} and status = 'posted' and device_id is not distinct from ${dev}`;
  const [out] = await q<{ cash: number }[]>`
    select coalesce(sum(m.amount_paise), 0)::bigint as cash from money_entries m join ledgers l on l.id = m.from_ledger_id
    where m.entry_date = ${input.date} and m.status = 'posted' and l.kind = 'cash' and m.kind in ('expense', 'payment', 'contra') and m.device_id is not distinct from ${dev}`;
  const staff = await q<{ user_name: string; bills: number; total: number; discount: number }[]>`
    select u.name as user_name, count(*)::int as bills, coalesce(sum(si.total_paise), 0)::bigint as total, coalesce(sum(si.discount_paise), 0)::bigint as discount
    from sales_invoices si join users u on u.id = si.user_id
    where si.invoice_date = ${input.date} and si.status = 'posted' and si.device_id is not distinct from ${dev}
    group by u.name order by total desc`;
  const float = input.floatPaise ?? 0;
  const expectedCash = float + sales!.cash + rec!.cash - ref!.cash - out!.cash;
  return {
    date: input.date,
    deviceId: dev,
    floatPaise: float,
    sales: sales!,
    collections: rec!,
    refunds: ref!,
    cashPaidOutPaise: out!.cash,
    staff,
    expectedCashPaise: expectedCash,
    upiPaise: sales!.upi + rec!.upi,
    cardPaise: sales!.card + rec!.card,
    creditGivenPaise: sales!.credit,
  };
}

export async function closeCounter(sql: Sql, ctx: Ctx, input: { date?: string; deviceId?: number | null; floatPaise?: number; countedCashPaise: number; note?: string }) {
  const date = input.date ?? istDate();
  const deviceId = input.deviceId === undefined ? ctx.deviceId : input.deviceId;
  if (deviceId !== ctx.deviceId && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'You can close only this counter');
  if (!Number.isSafeInteger(input.countedCashPaise) || input.countedCashPaise < 0) throw new AppError(400, 'BAD_AMOUNT', 'Enter the cash counted');
  const s = await counterSummary(sql, ctx, { date, deviceId, floatPaise: input.floatPaise });
  const diff = input.countedCashPaise - s.expectedCashPaise;
  const [c] = await sql<{ id: number }[]>`
    insert into counter_closings (close_date, device_id, expected_cash_paise, counted_cash_paise, difference_paise, summary, note, user_id)
    values (${date}, ${deviceId}, ${s.expectedCashPaise}, ${input.countedCashPaise}, ${diff}, ${sql.json(s as never)}, ${clean(input.note)}, ${ctx.userId}) returning id`;
  await audit(sql, ctx, 'counter.closed', { entity: 'counter_closing', entityId: c!.id, details: { date, deviceId, expected: s.expectedCashPaise, counted: input.countedCashPaise, difference: diff } });
  return { id: c!.id, expectedCashPaise: s.expectedCashPaise, differencePaise: diff };
}

export async function listCounterClosings(q: Q, ctx: Ctx, f: { from: string; to: string }) {
  if (!can(ctx, 'reports.view') && !can(ctx, 'payments.receive')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to see closings');
  return q`
    select c.id, c.close_date, c.device_id, d.name as device_name, c.expected_cash_paise, c.counted_cash_paise, c.difference_paise, c.summary, c.note, c.at, u.name as user_name
    from counter_closings c left join devices d on d.id = c.device_id join users u on u.id = c.user_id
    where c.close_date between ${f.from} and ${f.to} and (${can(ctx, 'reports.view')} or c.device_id = ${ctx.deviceId})
    order by c.close_date desc, c.id desc limit 500`;
}

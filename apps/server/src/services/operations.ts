import { addDays, calcBill, daysBetween, formatPaise, fyStartYear, inclFromExcl, istDate, type PriceMode } from '@kph/core';
import type { Q, Sql } from '../db/connect.js';
import { createInvoice, listRate, PRODUCT_FOR_BILL_COLUMNS, unitOf, type ProductForBill } from './billing.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';
import { nextDocNumber } from './ledger.js';
import { updateProduct } from './products.js';
import { getSettings } from './settings.js';

/**
 * Building-materials operations (Phase 6A): daily rate board, quotations / estimates,
 * delivery challans, and cement stock age (oldest first).
 */

const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

// ------------------------------------------------------------------ rate board

export async function rateBoard(q: Q) {
  const rows = await q<{ id: number; name: string; unit_code: string; sale_price_paise: number; price_includes_tax: boolean; gst_rate_bp: number; category: string | null; qty_milli: number; changed_at: string | null; previous_paise: number | null }[]>`
    select p.id, p.name, p.unit_code, p.sale_price_paise, p.price_includes_tax, p.gst_rate_bp, c.name as category,
           coalesce((select qty_milli from stock_balances where product_id = p.id), 0) as qty_milli,
           (select max(at)::text from price_history h where h.product_id = p.id and h.field = 'sale_price_paise') as changed_at,
           (select h.old_value from price_history h where h.product_id = p.id and h.field = 'sale_price_paise' order by h.id desc limit 1)::bigint as previous_paise
    from products p left join categories c on c.id = p.category_id
    where p.active and p.on_rate_board
    order by c.name nulls last, lower(p.name)`;
  return rows.map((r) => ({ ...r, incl_paise: r.price_includes_tax ? r.sale_price_paise : inclFromExcl(r.sale_price_paise, r.gst_rate_bp) }));
}

/** Update today's prices in one go (price history is kept by the product update). */
export async function setRates(sql: Sql, ctx: Ctx, rates: { productId: number; salePricePaise: number }[]) {
  requirePerm(ctx, 'products.edit_price', 'Only admin can change prices');
  let changed = 0;
  for (const r of rates) {
    const [p] = await sql<{ sale_price_paise: number }[]>`select sale_price_paise from products where id = ${r.productId}`;
    if (!p || p.sale_price_paise === r.salePricePaise) continue;
    await updateProduct(sql, ctx, r.productId, { salePricePaise: r.salePricePaise });
    changed++;
  }
  return { changed };
}

export async function setOnRateBoard(sql: Sql, ctx: Ctx, productId: number, on: boolean) {
  requirePerm(ctx, 'products.edit_price', 'Only admin can change the rate board');
  await sql`update products set on_rate_board = ${on}, updated_at = now() where id = ${productId}`;
  return { ok: true };
}

export async function priceHistory(q: Q, productId: number) {
  return q`
    select h.at, h.old_value, h.new_value, u.name as user_name from price_history h left join users u on u.id = h.user_id
    where h.product_id = ${productId} and h.field = 'sale_price_paise' order by h.id desc limit 100`;
}

/** Today's rates as a WhatsApp message (prices including GST, rounded to the rupee). */
export async function rateMessage(q: Q, lang: 'te' | 'en') {
  const s = await getSettings(q);
  const rows = await rateBoard(q);
  const d = istDate();
  const date = `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
  const lines = rows.map((r) => `• ${r.name}: ₹${formatPaise(Math.round(r.incl_paise / 100) * 100).replace(/\.00$/, '')}/${r.unit_code}`);
  const head = lang === 'te' ? `${s.storeName}\nఈ రోజు ధరలు (${date}) — GST తో కలిపి:` : `${s.storeName}\nToday's rates (${date}), including GST:`;
  const foot = lang === 'te' ? `ఆర్డర్ కోసం: ${s.storePhone || ''}`.trim() : `To order: ${s.storePhone || ''}`.trim();
  return { text: [head, ...lines, foot].join('\n'), count: rows.length };
}

// ------------------------------------------------------------------ quotations

export const FULL_HOUSE_STAGES = ['Foundation & structure', 'Plumbing & wiring', 'Tiles & walls', 'Final coat'] as const;

export interface QuoteInput {
  customerId?: number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  partnerId?: number | null;
  site?: string | null;
  template?: 'full_house' | null;
  priceMode?: PriceMode;
  placeOfSupply?: string;
  validUntil?: string;
  notes?: string | null;
  terms?: string | null;
  lines: { stage?: string | null; productId: number; unitCode?: string; qtyMilli: number; ratePaise?: number; rateMode?: PriceMode; discountBp?: number }[];
}

async function priceQuote(q: Q, input: QuoteInput, shopState: string) {
  if (!input.lines.length) throw new AppError(400, 'NO_LINES', 'Add at least one item');
  const ids = [...new Set(input.lines.map((l) => l.productId))];
  const products = await q.unsafe<ProductForBill[]>(`select ${PRODUCT_FOR_BILL_COLUMNS} from products p left join categories c on c.id = p.category_id where p.id = any($1)`, [ids]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const mode: PriceMode = input.priceMode ?? 'excl';
  const prepared = input.lines.map((l, i) => {
    const p = byId.get(l.productId);
    if (!p) throw new AppError(400, 'NO_PRODUCT', `Line ${i + 1}: product not found`);
    if (!Number.isSafeInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new AppError(400, 'BAD_QTY', `Line ${i + 1}: enter the quantity`);
    const unit = unitOf(p, l.unitCode);
    const lineMode = l.rateMode ?? mode;
    const rate = l.ratePaise ?? listRate(p, unit, lineMode);
    return { p, l, unit, rate, lineMode, discountBp: l.discountBp ?? 0 };
  });
  const pos = input.placeOfSupply ?? shopState;
  const totals = calcBill(prepared.map((x) => ({ qtyMilli: x.l.qtyMilli, ratePaise: x.rate, discountBp: x.discountBp, gstRateBp: x.p.gst_rate_bp, mode: x.lineMode })), pos === shopState ? 'intra' : 'inter');
  return { prepared, totals, pos };
}

export async function saveQuote(sql: Sql, ctx: Ctx, id: number | null, input: QuoteInput) {
  requirePerm(ctx, 'billing.create');
  const s = await getSettings(sql);
  const { prepared, totals, pos } = await priceQuote(sql, input, s.stateCode);
  return sql.begin(async (tx) => {
    const today = istDate();
    const fields = {
      customer_id: input.customerId ?? null,
      customer_name: clean(input.customerName),
      customer_phone: clean(input.customerPhone),
      customer_address: clean(input.customerAddress),
      partner_id: input.partnerId ?? null,
      site: clean(input.site),
      template: input.template ?? null,
      price_mode: input.priceMode ?? 'excl',
      place_of_supply: pos,
      valid_until: input.validUntil ?? addDays(today, s.quoteValidDays),
      gross_paise: totals.grossPaise,
      discount_paise: totals.discountPaise,
      taxable_paise: totals.taxablePaise,
      cgst_paise: totals.cgstPaise,
      sgst_paise: totals.sgstPaise,
      igst_paise: totals.igstPaise,
      round_off_paise: totals.roundOffPaise,
      total_paise: totals.totalPaise,
      notes: clean(input.notes),
      terms: clean(input.terms),
    };
    let quoteId: number;
    let number: string;
    if (id == null) {
      const fy = fyStartYear(new Date());
      const n = await nextDocNumber(tx, 'quote', s.quotePrefix, fy);
      number = n.number;
      const [row] = await tx<{ id: number }[]>`insert into quotations ${tx({ ...fields, number, fy_start: fy, seq: n.seq, quote_date: today, user_id: ctx.userId } as never)} returning id`;
      quoteId = row!.id;
    } else {
      const [cur] = await tx<{ status: string; number: string }[]>`select status, number from quotations where id = ${id} for update`;
      if (!cur) throw new AppError(404, 'NOT_FOUND', 'Quotation not found');
      if (cur.status !== 'open') throw new AppError(409, 'NOT_OPEN', `Quotation ${cur.number} is ${cur.status}`);
      await tx`update quotations set ${tx({ ...fields, updated_at: new Date() } as never)} where id = ${id}`;
      await tx`delete from quotation_lines where quotation_id = ${id}`;
      quoteId = id;
      number = cur.number;
    }
    await tx`insert into quotation_lines ${tx(
      prepared.map((x, i) => {
        const r = totals.lines[i]!;
        return {
          quotation_id: quoteId,
          line_no: i + 1,
          stage: clean(x.l.stage),
          product_id: x.p.id,
          product_name: x.p.name,
          unit_code: x.unit.code,
          qty_milli: x.l.qtyMilli,
          rate_paise: x.rate,
          rate_mode: x.lineMode,
          discount_bp: x.discountBp,
          gst_rate_bp: x.p.gst_rate_bp,
          taxable_paise: r.taxablePaise,
          total_paise: r.totalPaise,
          amount_paise: r.amountPaise,
        };
      }),
    )}`;
    await audit(tx, ctx, id == null ? 'quote.created' : 'quote.updated', { entity: 'quotation', entityId: quoteId, details: { number, totalPaise: totals.totalPaise } });
    return { id: quoteId, number, totalPaise: totals.totalPaise };
  });
}

export async function listQuotes(q: Q, f: { status?: string; search?: string }) {
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  return q`
    select qt.id, qt.number, qt.quote_date, qt.valid_until, coalesce(c.name, qt.customer_name) as customer_name, qt.site, qt.template,
           qt.total_paise, qt.status, qt.valid_until < current_date and qt.status = 'open' as expired, si.number as invoice_number, pa.name as partner_name,
           (select count(*)::int from quotation_lines l where l.quotation_id = qt.id) as items
    from quotations qt left join customers c on c.id = qt.customer_id left join sales_invoices si on si.id = qt.converted_invoice_id left join partners pa on pa.id = qt.partner_id
    where (${f.status ?? null}::text is null or qt.status = ${f.status ?? null})
      and (${search}::text is null or lower(qt.number) like ${search} or lower(coalesce(c.name, qt.customer_name, '')) like ${search} or lower(coalesce(qt.site, '')) like ${search})
    order by qt.id desc limit 300`;
}

export async function getQuote(q: Q, id: number) {
  const [qt] = await q`
    select qt.*, coalesce(c.name, qt.customer_name) as display_name, coalesce(c.phone, qt.customer_phone) as display_phone,
           coalesce(c.address, qt.customer_address) as display_address, c.gstin as customer_gstin, pa.name as partner_name, si.number as invoice_number,
           qt.valid_until < current_date and qt.status = 'open' as expired, u.name as user_name
    from quotations qt left join customers c on c.id = qt.customer_id left join partners pa on pa.id = qt.partner_id
         left join sales_invoices si on si.id = qt.converted_invoice_id join users u on u.id = qt.user_id
    where qt.id = ${id}`;
  if (!qt) throw new AppError(404, 'NOT_FOUND', 'Quotation not found');
  const lines = await q`
    select l.*, coalesce((select qty_milli from stock_balances where product_id = l.product_id), 0) as stock_milli
    from quotation_lines l where l.quotation_id = ${id} order by l.line_no`;
  const s = await getSettings(q);
  return { ...qt, lines, store: { name: s.storeName, address: s.storeAddress, phone: s.storePhone, gstin: s.storeGstin, terms: s.invoiceTerms, labels: s.invoiceLabels } };
}

export async function cancelQuote(sql: Sql, ctx: Ctx, id: number) {
  requirePerm(ctx, 'billing.create');
  const [r] = await sql<{ number: string }[]>`update quotations set status = 'cancelled', updated_at = now() where id = ${id} and status = 'open' returning number`;
  if (!r) throw new AppError(409, 'NOT_OPEN', 'Only an open quotation can be cancelled');
  await audit(sql, ctx, 'quote.cancelled', { entity: 'quotation', entityId: id, details: { number: r.number } });
  return { ok: true };
}

/**
 * Turn a quotation into a bill. Stock, discount limits and the credit limit are checked as for any bill.
 * prices: 'quoted' keeps the quoted rates (needs price permission if today's list price differs), 'today' uses today's list prices.
 */
export async function convertQuote(
  sql: Sql,
  ctx: Ctx,
  id: number,
  input: { paymentMode: 'cash' | 'upi' | 'card' | 'credit'; prices?: 'quoted' | 'today'; clientRef?: string; creditOverrideToken?: string },
) {
  requirePerm(ctx, 'billing.create');
  const qt = (await getQuote(sql, id)) as unknown as {
    status: string; number: string; customer_id: number | null; customer_name: string | null; customer_phone: string | null; customer_address: string | null;
    partner_id: number | null; place_of_supply: string; lines: { product_id: number; unit_code: string; qty_milli: number; rate_paise: number; rate_mode: PriceMode; discount_bp: number }[];
  };
  if (qt.status !== 'open') throw new AppError(409, 'NOT_OPEN', `Quotation ${qt.number} is ${qt.status}`);
  const keepRates = (input.prices ?? 'quoted') === 'quoted';
  const inv = await createInvoice(sql, ctx, {
    clientRef: input.clientRef,
    customerId: qt.customer_id,
    customerName: qt.customer_id ? undefined : (qt.customer_name ?? undefined),
    customerPhone: qt.customer_id ? undefined : (qt.customer_phone ?? undefined),
    customerAddress: qt.customer_id ? undefined : (qt.customer_address ?? undefined),
    placeOfSupply: qt.place_of_supply,
    paymentMode: input.paymentMode,
    partnerId: qt.partner_id,
    creditOverrideToken: input.creditOverrideToken,
    notes: `From quotation ${qt.number}`,
    lines: qt.lines.map((l) => ({ productId: l.product_id, qtyMilli: l.qty_milli, unitCode: l.unit_code, rateMode: l.rate_mode, ratePaise: keepRates ? l.rate_paise : undefined, discountBp: l.discount_bp })),
  });
  await sql`update quotations set status = 'converted', converted_invoice_id = ${inv.id}, updated_at = now() where id = ${id} and status = 'open'`;
  await audit(sql, ctx, 'quote.converted', { entity: 'quotation', entityId: id, details: { number: qt.number, invoice: inv.number } });
  return inv;
}

// ------------------------------------------------------------------ deliveries

/** What is left to deliver on each line of a bill (sold − returned − already sent). */
export async function deliverable(q: Q, invoiceId: number) {
  return q<{ id: number; line_no: number; product_name: string; unit_code: string; qty_milli: number; returned_milli: number; delivered_milli: number; remaining_milli: number }[]>`
    select x.*, x.qty_milli - x.returned_milli - x.delivered_milli as remaining_milli from (
      select l.id, l.line_no, l.product_name, l.unit_code, l.qty_milli,
             coalesce((select sum(cl.qty_milli) from credit_note_lines cl join credit_notes cn on cn.id = cl.credit_note_id where cl.invoice_line_id = l.id and cn.status = 'posted'), 0)::bigint as returned_milli,
             coalesce((select sum(dl.qty_milli) from delivery_lines dl join deliveries d on d.id = dl.delivery_id where dl.invoice_line_id = l.id and d.status <> 'cancelled'), 0)::bigint as delivered_milli
      from sales_invoice_lines l where l.invoice_id = ${invoiceId}
    ) x order by x.line_no`;
}

export async function createDelivery(
  sql: Sql,
  ctx: Ctx,
  invoiceId: number,
  input: { date?: string; siteAddress?: string; contactPhone?: string; vehicleNo?: string; driverName?: string; driverPhone?: string; chargePaise?: number; notes?: string; lines: { invoiceLineId: number; qtyMilli: number }[] },
) {
  if (!can(ctx, 'billing.create') && !can(ctx, 'stock.adjust')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to plan deliveries');
  const lines = input.lines.filter((l) => l.qtyMilli > 0);
  if (!lines.length) throw new AppError(400, 'NO_LINES', 'Choose what goes in this delivery');
  return sql.begin(async (tx) => {
    const [inv] = await tx<{ id: number; number: string; status: string; customer_address: string | null; customer_phone: string | null }[]>`
      select id, number, status, customer_address, customer_phone from sales_invoices where id = ${invoiceId} for update`;
    if (!inv) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
    if (inv.status !== 'posted') throw new AppError(400, 'CANCELLED', 'This bill is cancelled');
    const left = new Map((await deliverable(tx, invoiceId)).map((l) => [l.id, l]));
    for (const l of lines) {
      const d = left.get(l.invoiceLineId);
      if (!d) throw new AppError(400, 'BAD_LINE', 'That item is not on this bill');
      if (l.qtyMilli > d.remaining_milli) throw new AppError(400, 'TOO_MUCH', `${d.product_name}: only ${d.remaining_milli / 1000} ${d.unit_code} left to deliver`);
    }
    const s = await getSettings(tx);
    const date = input.date ?? istDate();
    const fy = fyStartYear(new Date(`${date}T12:00:00+05:30`));
    const n = await nextDocNumber(tx, 'challan', s.challanPrefix, fy);
    const [d] = await tx<{ id: number }[]>`
      insert into deliveries (number, fy_start, seq, invoice_id, delivery_date, site_address, contact_phone, vehicle_no, driver_name, driver_phone, charge_paise, notes, user_id)
      values (${n.number}, ${fy}, ${n.seq}, ${invoiceId}, ${date}, ${clean(input.siteAddress) ?? inv.customer_address}, ${clean(input.contactPhone) ?? inv.customer_phone},
              ${clean(input.vehicleNo)?.toUpperCase().replace(/\s+/g, '') ?? null}, ${clean(input.driverName)}, ${clean(input.driverPhone)}, ${input.chargePaise ?? 0}, ${clean(input.notes)}, ${ctx.userId})
      returning id`;
    await tx`insert into delivery_lines ${tx(lines.map((l) => ({ delivery_id: d!.id, invoice_line_id: l.invoiceLineId, qty_milli: l.qtyMilli })))}`;
    await audit(tx, ctx, 'delivery.created', { entity: 'delivery', entityId: d!.id, details: { number: n.number, invoice: inv.number } });
    return { id: d!.id, number: n.number };
  });
}

export async function setDeliveryStatus(sql: Sql, ctx: Ctx, id: number, input: { status: 'pending' | 'out' | 'delivered' | 'cancelled'; receivedBy?: string; vehicleNo?: string; driverName?: string }) {
  if (!can(ctx, 'billing.create') && !can(ctx, 'stock.adjust')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to update deliveries');
  const [d] = await sql<{ status: string; number: string }[]>`select status, number from deliveries where id = ${id}`;
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
  if (d.status === 'cancelled' || d.status === 'delivered') {
    if (input.status !== d.status) throw new AppError(409, 'CLOSED', `Delivery ${d.number} is already ${d.status}`);
  }
  await sql`
    update deliveries set status = ${input.status},
      out_at = case when ${input.status} = 'out' then now() else out_at end,
      delivered_at = case when ${input.status} = 'delivered' then now() else delivered_at end,
      received_by = coalesce(${clean(input.receivedBy)}, received_by),
      vehicle_no = coalesce(${clean(input.vehicleNo)?.toUpperCase().replace(/\s+/g, '') ?? null}, vehicle_no),
      driver_name = coalesce(${clean(input.driverName)}, driver_name)
    where id = ${id}`;
  await audit(sql, ctx, `delivery.${input.status}`, { entity: 'delivery', entityId: id, details: { number: d.number } });
  return { ok: true };
}

export async function listDeliveries(q: Q, f: { date?: string; status?: string; invoiceId?: number }) {
  return q`
    select d.id, d.number, d.delivery_date, d.status, d.site_address, d.contact_phone, d.vehicle_no, d.driver_name, d.driver_phone, d.charge_paise,
           d.out_at, d.delivered_at, d.received_by, si.id as invoice_id, si.number as invoice_number, coalesce(si.customer_name, 'Walk-in') as customer_name,
           (select string_agg(l.product_name || ' × ' || trim(to_char(dl.qty_milli / 1000.0, 'FM999999990.###')) || ' ' || l.unit_code, ', ' order by l.line_no)
              from delivery_lines dl join sales_invoice_lines l on l.id = dl.invoice_line_id where dl.delivery_id = d.id) as items
    from deliveries d join sales_invoices si on si.id = d.invoice_id
    where (${f.date ?? null}::date is null or d.delivery_date = ${f.date ?? null}::date)
      and (${f.status ?? null}::text is null or d.status = ${f.status ?? null})
      and (${f.invoiceId ?? null}::bigint is null or d.invoice_id = ${f.invoiceId ?? null})
    order by case d.status when 'out' then 0 when 'pending' then 1 when 'delivered' then 2 else 3 end, d.id desc
    limit 500`;
}

export async function getDelivery(q: Q, id: number) {
  const [d] = await q`
    select d.*, si.number as invoice_number, si.invoice_date, coalesce(si.customer_name, 'Walk-in') as customer_name, si.customer_gstin, u.name as user_name
    from deliveries d join sales_invoices si on si.id = d.invoice_id join users u on u.id = d.user_id where d.id = ${id}`;
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
  const lines = await q`
    select l.line_no, l.product_name, l.hsn, l.unit_code, dl.qty_milli from delivery_lines dl join sales_invoice_lines l on l.id = dl.invoice_line_id
    where dl.delivery_id = ${id} order by l.line_no`;
  const s = await getSettings(q);
  return { ...d, lines, store: { name: s.storeName, address: s.storeAddress, phone: s.storePhone, gstin: s.storeGstin, labels: s.invoiceLabels } };
}

// ------------------------------------------------------------------ cement stock age (oldest first)

export interface StockLayer {
  received: string;
  packedOn: string | null;
  batch: string | null;
  qtyMilli: number;
  ageDays: number;
}

/**
 * Stock age for batch-tracked products (cement): stock is assumed to be sold oldest first, so the
 * stock on hand is made of the newest receipts. Age counts from the packing date when known.
 */
export async function stockAge(q: Q, f: { productIds?: number[] } = {}) {
  const s = await getSettings(q);
  const today = istDate();
  const products = await q<{ id: number; name: string; unit_code: string; qty: number }[]>`
    select p.id, p.name, p.unit_code, coalesce(sb.qty_milli, 0) as qty from products p left join stock_balances sb on sb.product_id = p.id
    where p.active and p.track_batches and (${f.productIds ?? null}::int[] is null or p.id = any(${f.productIds ?? null}::int[]))`;
  if (!products.length) return { warnDays: s.oldStockDays, products: [] };
  const ids = products.map((p) => p.id);
  const receipts = await q<{ product_id: number; received: string; packed_on: string | null; batch: string | null; qty: number }[]>`
    select l.product_id, (pi.at at time zone 'Asia/Kolkata')::date::text as received, l.packed_on::text as packed_on, l.batch_code as batch, l.qty_milli as qty
    from purchase_lines l join purchase_invoices pi on pi.id = l.purchase_id
    where pi.status = 'posted' and l.product_id = any(${ids})
    union all
    select m.product_id, (m.at at time zone 'Asia/Kolkata')::date::text, null, 'opening stock', m.qty_milli
    from stock_movements m where m.kind = 'opening' and m.product_id = any(${ids}) and m.qty_milli > 0
    order by 2 desc, 3 desc nulls last`;
  const out = products.map((p) => {
    let left = Math.max(p.qty, 0);
    const layers: StockLayer[] = [];
    for (const r of receipts.filter((x) => x.product_id === p.id)) {
      if (left <= 0) break;
      const take = Math.min(left, r.qty);
      left -= take;
      const from = r.packed_on ?? r.received;
      layers.push({ received: r.received, packedOn: r.packed_on, batch: r.batch, qtyMilli: take, ageDays: daysBetween(from, today) });
    }
    layers.sort((a, b) => b.ageDays - a.ageDays); // oldest first
    const oldest = layers[0] ?? null;
    return {
      productId: p.id,
      name: p.name,
      unit: p.unit_code,
      stockMilli: p.qty,
      layers,
      oldest,
      unknownMilli: left, // stock older than any recorded receipt
      warn: layers.some((l) => l.ageDays > s.oldStockDays) || left > 0,
    };
  });
  return { warnDays: s.oldStockDays, products: out.sort((a, b) => (b.oldest?.ageDays ?? 0) - (a.oldest?.ageDays ?? 0)) };
}

export async function setTrackBatches(sql: Sql, ctx: Ctx, productId: number, on: boolean) {
  requirePerm(ctx, 'products.manage', 'Only admin can change this');
  await sql`update products set track_batches = ${on}, updated_at = now() where id = ${productId}`;
  return { ok: true };
}

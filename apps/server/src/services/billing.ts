import {
  calcBill,
  effectiveMaxDiscountBp,
  formatQty,
  fyStartYear,
  istDate,
  type DiscountLimit,
} from '@kph/core';
import type { Q, Sql, Tx } from '../db/connect.js';
import { consumeOverride } from './auth.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';
import { ledgerBalance, nextDocNumber, postVoucher, reverseVoucher, systemLedgerIds } from './ledger.js';
import { lockProducts } from './products.js';
import { getSettings } from './settings.js';

export type PaymentMode = 'cash' | 'upi' | 'card' | 'credit';

export interface InvoiceLineInput {
  productId: number;
  qtyMilli: number;
  /** Rate excluding GST. Defaults to the product's price; changing it needs products.edit_price. */
  ratePaise?: number;
  discountBp: number;
  /** Token from an admin PIN approval, when the discount is above the limit. */
  overrideToken?: string;
}

export interface InvoiceInput {
  clientRef?: string;
  customerId?: number | null;
  /** Optional name/phone for a walk-in customer. */
  customerName?: string;
  customerPhone?: string;
  paymentMode: PaymentMode;
  notes?: string;
  lines: InvoiceLineInput[];
}

interface ProductForBill {
  id: number;
  sku: string;
  name: string;
  hsn: string | null;
  unit_code: string;
  gst_rate_bp: number;
  sale_price_paise: number;
  cost_price_paise: number | null;
  active: boolean;
  max_disc_type: 'pct' | 'amt' | null;
  max_disc_value: number | null;
  cat_disc_type: 'pct' | 'amt' | null;
  cat_disc_value: number | null;
}

interface CustomerSnap {
  id: number;
  name: string;
  phone: string | null;
  gstin: string | null;
  address: string | null;
  ledger_id: number;
}

/** Reserve the next id first, so the voucher can point at the document before it is inserted. */
async function nextId(tx: Tx, sequence: 'sales_invoices_id_seq' | 'receipts_id_seq'): Promise<number> {
  const [r] = await tx<{ id: number }[]>`select nextval(${sequence})::bigint as id`;
  return r!.id;
}

const limitOf = (type: 'pct' | 'amt' | null, value: number | null): DiscountLimit | null =>
  type && value != null ? { type, value } : null;

/**
 * Save a bill. Everything happens in one database transaction — stock check,
 * invoice number, stock movements, accounting voucher, audit — so either all of
 * it is saved or none of it.
 */
export async function createInvoice(sql: Sql, ctx: Ctx, input: InvoiceInput, opts: { at?: Date } = {}) {
  requirePerm(ctx, 'billing.create');
  if (!input.lines.length) throw new AppError(400, 'EMPTY_BILL', 'Add at least one item to the bill');
  if (input.paymentMode === 'credit' && !input.customerId) {
    throw new AppError(400, 'CREDIT_NEEDS_CUSTOMER', 'Choose a customer for a credit bill');
  }

  const findExisting = async (q: Q) => {
    if (!input.clientRef) return null;
    const [existing] = await q<{ id: number; number: string }[]>`select id, number from sales_invoices where client_ref = ${input.clientRef}`;
    return existing ? { ...existing, duplicate: true } : null;
  };
  try {
    return await saveInvoice(sql, ctx, input, opts, findExisting);
  } catch (e) {
    // Same bill submitted twice at once (double click): return the one that was saved.
    const err = e as { code?: string; constraint_name?: string };
    if (err.code === '23505' && err.constraint_name === 'sales_invoices_client_ref_key') {
      const existing = await findExisting(sql);
      if (existing) return existing;
    }
    throw e;
  }
}

async function saveInvoice(
  sql: Sql,
  ctx: Ctx,
  input: InvoiceInput,
  opts: { at?: Date },
  findExisting: (q: Q) => Promise<{ id: number; number: string; duplicate: boolean } | null>,
) {
  return sql.begin(async (tx) => {
    const existing = await findExisting(tx);
    if (existing) return existing;
    const settings = await getSettings(tx);
    const productIds = [...new Set(input.lines.map((l) => l.productId))].sort((a, b) => a - b);
    const products = await tx<ProductForBill[]>`
      select p.id, p.sku, p.name, p.hsn, p.unit_code, p.gst_rate_bp, p.sale_price_paise, p.cost_price_paise, p.active,
             p.max_disc_type, p.max_disc_value, c.max_disc_type as cat_disc_type, c.max_disc_value as cat_disc_value
      from products p left join categories c on c.id = p.category_id
      where p.id in ${tx(productIds)}`;
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const id of productIds) {
      const p = byId.get(id);
      if (!p) throw new AppError(400, 'NO_PRODUCT', 'One of the items no longer exists. Remove it and add it again.');
      if (!p.active) throw new AppError(400, 'INACTIVE_PRODUCT', `"${p.name}" is no longer sold (inactive)`);
    }

    // Lock the products (in a fixed order, to avoid deadlocks between counters), then read stock.
    // Another counter selling the same item waits here until this bill commits or fails.
    await lockProducts(tx, productIds);
    const balances = await tx<{ product_id: number; qty_milli: number }[]>`
      select product_id, qty_milli from stock_balances where product_id in ${tx(productIds)}`;
    const available = new Map(balances.map((b) => [b.product_id, b.qty_milli]));
    const needed = new Map<number, number>();
    for (const l of input.lines) needed.set(l.productId, (needed.get(l.productId) ?? 0) + l.qtyMilli);
    if (!settings.allowNegativeStock) {
      const short = [...needed]
        .filter(([id, qty]) => qty > (available.get(id) ?? 0))
        .map(([id, qty]) => ({ productId: id, name: byId.get(id)!.name, unit: byId.get(id)!.unit_code, neededMilli: qty, availableMilli: available.get(id) ?? 0 }));
      if (short.length) {
        const msg = short.map((s) => `${s.name}: need ${formatQty(s.neededMilli)}, only ${formatQty(s.availableMilli)} ${s.unit} in stock`).join('; ');
        throw new AppError(409, 'INSUFFICIENT_STOCK', `Not enough stock — ${msg}`, { items: short });
      }
    }

    const [me] = await tx<{ discount_cap_bp: number | null }[]>`select discount_cap_bp from users where id = ${ctx.userId}`;
    const staffCapBp = me?.discount_cap_bp ?? null;

    const prepared = [];
    const overLimit: { lineNo: number; productId: number; name: string; discountBp: number; maxBp: number; approvedBy: number | null; overrideId: number | null }[] = [];
    for (const [i, l] of input.lines.entries()) {
      const p = byId.get(l.productId)!;
      const ratePaise = l.ratePaise ?? p.sale_price_paise;
      if (ratePaise !== p.sale_price_paise && !can(ctx, 'products.edit_price')) {
        throw new AppError(403, 'PRICE_CHANGE_NOT_ALLOWED', `Only admin can change the price of "${p.name}"`);
      }
      const maxBp = effectiveMaxDiscountBp({
        productLimit: limitOf(p.max_disc_type, p.max_disc_value),
        categoryLimit: limitOf(p.cat_disc_type, p.cat_disc_value),
        staffCapBp: can(ctx, 'billing.discount_over_limit') ? null : staffCapBp,
        ratePaise,
      });
      let overrideId: number | null = null;
      if (l.discountBp > maxBp) {
        let approvedBy: number | null = null;
        if (!can(ctx, 'billing.discount_over_limit')) {
          if (!l.overrideToken) {
            throw new AppError(403, 'NEEDS_OVERRIDE', `Discount on "${p.name}" is above the allowed limit. Admin PIN needed.`, {
              permission: 'billing.discount_over_limit',
              lineIndex: i,
              productId: p.id,
            });
          }
          const o = await consumeOverride(tx, ctx, l.overrideToken, 'billing.discount_over_limit', (c) =>
            c.productId === p.id && typeof c.discountBp === 'number' && c.discountBp >= l.discountBp,
          );
          overrideId = o.id;
          approvedBy = o.approvedBy;
        }
        overLimit.push({ lineNo: i + 1, productId: p.id, name: p.name, discountBp: l.discountBp, maxBp, approvedBy, overrideId });
      }
      prepared.push({ p, l, ratePaise, maxBp, overrideId });
    }

    const totals = calcBill(
      prepared.map(({ p, l, ratePaise }) => ({ qtyMilli: l.qtyMilli, ratePaise, discountBp: l.discountBp, gstRateBp: p.gst_rate_bp })),
      'intra',
    );

    let customer: CustomerSnap | null = null;
    if (input.customerId) {
      const [c] = await tx<CustomerSnap[]>`
        select id, name, phone, gstin, address, ledger_id from customers where id = ${input.customerId} and active`;
      if (!c) throw new AppError(400, 'NO_CUSTOMER', 'Customer not found or inactive');
      customer = c;
    }

    const at = opts.at ?? new Date();
    const date = istDate(at);
    const fy = fyStartYear(at);
    const { seq, number } = await nextDocNumber(tx, 'sales', settings.invoicePrefix, fy);
    const id = await nextId(tx, 'sales_invoices_id_seq');

    const L = await systemLedgerIds(tx);
    const debitLedger = input.paymentMode === 'credit' ? customer!.ledger_id : L[input.paymentMode];
    const voucherId = await postVoucher(tx, ctx, {
      vtype: 'sales',
      vdate: date,
      narration: `Sales bill ${number}${customer ? ' — ' + customer.name : ''}`,
      refType: 'sales_invoice',
      refId: id,
      lines: [
        { ledgerId: debitLedger, amountPaise: totals.totalPaise },
        { ledgerId: L.sales, amountPaise: -totals.taxablePaise },
        { ledgerId: L.output_cgst, amountPaise: -totals.cgstPaise },
        { ledgerId: L.output_sgst, amountPaise: -totals.sgstPaise },
        { ledgerId: L.output_igst, amountPaise: -totals.igstPaise },
        { ledgerId: L.round_off, amountPaise: -totals.roundOffPaise },
      ],
    });

    await tx`
      insert into sales_invoices (id, number, fy_start, seq, invoice_date, at, customer_id, customer_name, customer_phone,
        customer_gstin, customer_address, payment_mode, gross_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise,
        igst_paise, round_off_paise, total_paise, voucher_id, notes, user_id, device_id, client_ref)
      values (${id}, ${number}, ${fy}, ${seq}, ${date}, ${at}, ${customer?.id ?? null},
        ${customer?.name ?? (input.customerName?.trim() || null)}, ${customer?.phone ?? (input.customerPhone?.trim() || null)},
        ${customer?.gstin ?? null}, ${customer?.address ?? null}, ${input.paymentMode}, ${totals.grossPaise},
        ${totals.discountPaise}, ${totals.taxablePaise}, ${totals.cgstPaise}, ${totals.sgstPaise}, ${totals.igstPaise},
        ${totals.roundOffPaise}, ${totals.totalPaise}, ${voucherId}, ${input.notes?.trim() || null}, ${ctx.userId},
        ${ctx.deviceId}, ${input.clientRef ?? null})`;

    await tx`insert into sales_invoice_lines ${tx(
      prepared.map(({ p, l, ratePaise, maxBp, overrideId }, i) => {
        const r = totals.lines[i]!;
        return {
          invoice_id: id,
          line_no: i + 1,
          product_id: p.id,
          product_name: p.name,
          sku: p.sku,
          hsn: p.hsn,
          unit_code: p.unit_code,
          qty_milli: l.qtyMilli,
          rate_paise: ratePaise,
          discount_bp: l.discountBp,
          max_discount_bp: maxBp,
          gross_paise: r.grossPaise,
          discount_paise: r.discountPaise,
          taxable_paise: r.taxablePaise,
          gst_rate_bp: p.gst_rate_bp,
          cgst_paise: r.cgstPaise,
          sgst_paise: r.sgstPaise,
          igst_paise: r.igstPaise,
          total_paise: r.totalPaise,
          cost_price_paise: p.cost_price_paise,
          override_id: overrideId,
        };
      }),
    )}`;

    await tx`insert into stock_movements ${tx(
      prepared.map(({ p, l }) => ({
        product_id: p.id,
        qty_milli: -l.qtyMilli,
        kind: 'sale',
        ref_type: 'sales_invoice',
        ref_id: id,
        unit_cost_paise: p.cost_price_paise,
        user_id: ctx.userId,
        device_id: ctx.deviceId,
        at,
      })),
    )}`;

    await audit(tx, ctx, 'invoice.created', {
      entity: 'sales_invoice',
      entityId: id,
      details: { number, totalPaise: totals.totalPaise, paymentMode: input.paymentMode, items: prepared.length, customerId: customer?.id ?? null },
    });
    for (const o of overLimit) {
      await audit(tx, ctx, 'discount.over_limit', {
        entity: 'sales_invoice',
        entityId: id,
        details: { number, lineNo: o.lineNo, productId: o.productId, product: o.name, discountBp: o.discountBp, maxBp: o.maxBp, overrideId: o.overrideId },
        approvedBy: o.approvedBy,
      });
    }
    return { id, number, duplicate: false };
  });
}

export async function getInvoice(q: Q, id: number, opts: { withCost?: boolean } = {}) {
  const [inv] = await q`
    select si.*, u.name as user_name, d.name as device_name, cu.name as cancelled_by_name, ap.name as cancel_approved_by_name
    from sales_invoices si
    join users u on u.id = si.user_id
    left join devices d on d.id = si.device_id
    left join users cu on cu.id = si.cancelled_by
    left join users ap on ap.id = si.cancel_approved_by
    where si.id = ${id}`;
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  const lines = await q`select * from sales_invoice_lines where invoice_id = ${id} order by line_no`;
  if (!opts.withCost) for (const l of lines) delete l.cost_price_paise;
  return { ...inv, lines };
}

export async function listInvoices(
  q: Q,
  f: { from?: string; to?: string; search?: string; status?: string; customerId?: number; paymentMode?: string; limit?: number },
) {
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  return q`
    select si.id, si.number, si.invoice_date, si.at, si.customer_id, si.customer_name, si.customer_phone, si.payment_mode,
           si.total_paise, si.discount_paise, si.status, u.name as user_name, d.name as device_name,
           (select count(*)::int from sales_invoice_lines l where l.invoice_id = si.id) as item_count
    from sales_invoices si join users u on u.id = si.user_id left join devices d on d.id = si.device_id
    where (${f.from ?? null}::date is null or si.invoice_date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or si.invoice_date <= ${f.to ?? null}::date)
      and (${f.status ?? null}::text is null or si.status = ${f.status ?? null})
      and (${f.paymentMode ?? null}::text is null or si.payment_mode = ${f.paymentMode ?? null})
      and (${f.customerId ?? null}::int is null or si.customer_id = ${f.customerId ?? null})
      and (${search}::text is null or lower(si.number) like ${search} or lower(coalesce(si.customer_name, '')) like ${search}
           or coalesce(si.customer_phone, '') like ${search})
    order by si.id desc
    limit ${Math.min(f.limit ?? 200, 1000)}`;
}

/** Cancel a bill: reverses stock and accounts. The bill and its number stay, marked CANCELLED. */
export async function cancelInvoice(sql: Sql, ctx: Ctx, id: number, input: { reason: string; overrideToken?: string }) {
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason for cancelling');
  return sql.begin(async (tx) => {
    const [inv] = await tx<{ id: number; number: string; status: string; voucher_id: number | null; total_paise: number }[]>`
      select id, number, status, voucher_id, total_paise from sales_invoices where id = ${id} for update`;
    if (!inv) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
    if (inv.status === 'cancelled') throw new AppError(409, 'ALREADY_CANCELLED', `Bill ${inv.number} is already cancelled`);

    let approvedBy: number | null = null;
    if (!can(ctx, 'billing.cancel')) {
      if (!input.overrideToken) {
        throw new AppError(403, 'NEEDS_OVERRIDE', 'Cancelling a bill needs the admin PIN', { permission: 'billing.cancel', invoiceId: id });
      }
      approvedBy = (await consumeOverride(tx, ctx, input.overrideToken, 'billing.cancel', (c) => c.invoiceId === id)).approvedBy;
    }

    const date = istDate();
    const cancelVoucherId = inv.voucher_id
      ? await reverseVoucher(tx, ctx, inv.voucher_id, date, `Cancelled bill ${inv.number}: ${reason}`)
      : null;
    const lines = await tx<{ product_id: number; qty_milli: number; cost_price_paise: number | null }[]>`
      select product_id, qty_milli, cost_price_paise from sales_invoice_lines where invoice_id = ${id}`;
    await tx`insert into stock_movements ${tx(
      lines.map((l) => ({
        product_id: l.product_id,
        qty_milli: l.qty_milli,
        kind: 'sale_cancel',
        ref_type: 'sales_invoice',
        ref_id: id,
        unit_cost_paise: l.cost_price_paise,
        reason,
        user_id: ctx.userId,
        device_id: ctx.deviceId,
      })),
    )}`;
    await tx`
      update sales_invoices set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = now(),
        cancelled_by = ${ctx.userId}, cancel_approved_by = ${approvedBy}, cancel_voucher_id = ${cancelVoucherId}
      where id = ${id}`;
    await audit(tx, ctx, 'invoice.cancelled', {
      entity: 'sales_invoice',
      entityId: id,
      details: { number: inv.number, totalPaise: inv.total_paise },
      reason,
      approvedBy,
    });
    return { id, number: inv.number };
  });
}

// ------------------------------------------------------------------ receipts (customer payments)

export async function createReceipt(
  sql: Sql,
  ctx: Ctx,
  input: { clientRef?: string; customerId: number; mode: 'cash' | 'upi' | 'card' | 'bank' | 'cheque'; amountPaise: number; reference?: string; notes?: string },
  opts: { at?: Date } = {},
) {
  requirePerm(ctx, 'payments.receive');
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Enter an amount more than zero');
  return sql.begin(async (tx) => {
    if (input.clientRef) {
      const [existing] = await tx<{ id: number; number: string }[]>`select id, number from receipts where client_ref = ${input.clientRef}`;
      if (existing) return existing;
    }
    const [c] = await tx<{ id: number; name: string; ledger_id: number }[]>`select id, name, ledger_id from customers where id = ${input.customerId}`;
    if (!c) throw new AppError(400, 'NO_CUSTOMER', 'Customer not found');
    const settings = await getSettings(tx);
    const at = opts.at ?? new Date();
    const date = istDate(at);
    const fy = fyStartYear(at);
    const { seq, number } = await nextDocNumber(tx, 'receipt', settings.receiptPrefix, fy);
    const id = await nextId(tx, 'receipts_id_seq');
    const L = await systemLedgerIds(tx);
    const voucherId = await postVoucher(tx, ctx, {
      vtype: 'receipt',
      vdate: date,
      narration: `Receipt ${number} from ${c.name}${input.reference ? ' — ' + input.reference : ''}`,
      refType: 'receipt',
      refId: id,
      lines: [
        { ledgerId: L[input.mode], amountPaise: input.amountPaise },
        { ledgerId: c.ledger_id, amountPaise: -input.amountPaise },
      ],
    });
    await tx`
      insert into receipts (id, number, fy_start, seq, receipt_date, at, customer_id, mode, amount_paise, reference, notes,
                            voucher_id, user_id, device_id, client_ref)
      values (${id}, ${number}, ${fy}, ${seq}, ${date}, ${at}, ${c.id}, ${input.mode}, ${input.amountPaise},
              ${input.reference?.trim() || null}, ${input.notes?.trim() || null}, ${voucherId}, ${ctx.userId}, ${ctx.deviceId},
              ${input.clientRef ?? null})`;
    await audit(tx, ctx, 'receipt.created', {
      entity: 'receipt',
      entityId: id,
      details: { number, customerId: c.id, customer: c.name, amountPaise: input.amountPaise, mode: input.mode },
    });
    const balancePaise = await ledgerBalance(tx, c.ledger_id);
    return { id, number, balancePaise };
  });
}

export async function cancelReceipt(sql: Sql, ctx: Ctx, id: number, input: { reason: string; overrideToken?: string }) {
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason for cancelling');
  return sql.begin(async (tx) => {
    const [r] = await tx<{ id: number; number: string; status: string; voucher_id: number | null; amount_paise: number }[]>`
      select id, number, status, voucher_id, amount_paise from receipts where id = ${id} for update`;
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Receipt not found');
    if (r.status === 'cancelled') throw new AppError(409, 'ALREADY_CANCELLED', `Receipt ${r.number} is already cancelled`);
    let approvedBy: number | null = null;
    if (!can(ctx, 'billing.cancel')) {
      if (!input.overrideToken) throw new AppError(403, 'NEEDS_OVERRIDE', 'Cancelling a receipt needs the admin PIN', { permission: 'billing.cancel', receiptId: id });
      approvedBy = (await consumeOverride(tx, ctx, input.overrideToken, 'billing.cancel', (c) => c.receiptId === id)).approvedBy;
    }
    const cancelVoucherId = r.voucher_id ? await reverseVoucher(tx, ctx, r.voucher_id, istDate(), `Cancelled receipt ${r.number}: ${reason}`) : null;
    await tx`update receipts set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = now(), cancelled_by = ${ctx.userId},
             cancel_voucher_id = ${cancelVoucherId} where id = ${id}`;
    await audit(tx, ctx, 'receipt.cancelled', { entity: 'receipt', entityId: id, details: { number: r.number, amountPaise: r.amount_paise }, reason, approvedBy });
    return { id, number: r.number };
  });
}

// ------------------------------------------------------------------ drafts (never lose a half-made bill)

export async function saveDraft(sql: Sql, ctx: Ctx, data: unknown) {
  if (!ctx.deviceId) return;
  await sql`
    insert into bill_drafts (device_id, user_id, data, updated_at) values (${ctx.deviceId}, ${ctx.userId}, ${sql.json(data as never)}, now())
    on conflict (device_id, user_id) do update set data = excluded.data, updated_at = now()`;
}

export async function getDraft(sql: Sql, ctx: Ctx) {
  if (!ctx.deviceId) return null;
  const [d] = await sql<{ data: unknown; updated_at: Date }[]>`select data, updated_at from bill_drafts where device_id = ${ctx.deviceId} and user_id = ${ctx.userId}`;
  return d ?? null;
}

export async function clearDraft(sql: Sql, ctx: Ctx) {
  if (!ctx.deviceId) return;
  await sql`delete from bill_drafts where device_id = ${ctx.deviceId} and user_id = ${ctx.userId}`;
}

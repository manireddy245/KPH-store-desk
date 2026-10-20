import {
  B2C_DETAILS_THRESHOLD_PAISE,
  BASE,
  STATES,
  calcBill,
  convertRate,
  effectiveMaxDiscountBp,
  formatQty,
  fyStartYear,
  istDate,
  stateFromGstin,
  toBase,
  unitPrice,
  type DiscountLimit,
  type PriceMode,
  type SupplyType,
  type UnitFactor,
} from '@kph/core';
import type { Q, Sql, Tx } from '../db/connect.js';
import { consumeOverride } from './auth.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';
import { assertMonthOpen } from './gst.js';
import { ledgerBalance, nextDocNumber, postVoucher, reverseVoucher, systemLedgerIds } from './ledger.js';
import { lockProducts } from './products.js';
import { reverseRewardsOnCancel, tagInvoicePartner } from './partners.js';
import { getSettings } from './settings.js';

export type PaymentMode = 'cash' | 'upi' | 'card' | 'credit';

export interface InvoiceLineInput {
  productId: number;
  /** Quantity in the chosen unit (thousandths). */
  qtyMilli: number;
  /** Unit sold in; default the product's base unit. */
  unitCode?: string;
  /** Rate per unit in rateMode. Defaults to the product's price; changing it needs products.edit_price. */
  ratePaise?: number;
  /** Price typed excluding or including GST. Default: how the product's price is kept. */
  rateMode?: PriceMode;
  discountBp: number;
  /** Token from an admin PIN approval, when the discount is above the limit. */
  overrideToken?: string;
}

export interface InvoiceInput {
  clientRef?: string;
  customerId?: number | null;
  /** Optional details for a walk-in customer (required for bills of ₹50,000 or more). */
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  /** GST place of supply (state code). Default: the business customer's state, else the shop's state. */
  placeOfSupply?: string;
  paymentMode: PaymentMode;
  notes?: string;
  lines: InvoiceLineInput[];
  /** Admin approval to go over the customer's credit limit (credit bills). */
  creditOverrideToken?: string;
  /** Trade partner (painter, mason…) who brought this bill, and their site. */
  partnerId?: number | null;
  siteId?: number | null;
  /** Ship-to, customer PAN and delivery boxes printed on the bill (all optional). */
  details?: InvoiceDetailsInput;
}

export interface InvoiceDetailsInput {
  shipToName?: string | null;
  shipToAddress?: string | null;
  shipToContact?: string | null;
  shipToPhone?: string | null;
  customerPan?: string | null;
  deliveryNote?: string | null;
  reference?: string | null;
  otherReferences?: string | null;
  dispatchedThrough?: string | null;
  destination?: string | null;
  termsOfDelivery?: string | null;
}

const DETAIL_COLUMNS: Record<keyof InvoiceDetailsInput, string> = {
  shipToName: 'ship_to_name',
  shipToAddress: 'ship_to_address',
  shipToContact: 'ship_to_contact',
  shipToPhone: 'ship_to_phone',
  customerPan: 'customer_pan',
  deliveryNote: 'delivery_note',
  reference: 'reference',
  otherReferences: 'other_references',
  dispatchedThrough: 'dispatched_through',
  destination: 'destination',
  termsOfDelivery: 'terms_of_delivery',
};

/** Trimmed details as table columns; blanks become null. */
function detailRow(d: InvoiceDetailsInput) {
  const row: Record<string, string | null> = {};
  for (const [k, col] of Object.entries(DETAIL_COLUMNS)) {
    const v = d[k as keyof InvoiceDetailsInput];
    if (v === undefined) continue;
    const t = v?.trim() || null;
    row[col] = col === 'customer_pan' && t ? t.toUpperCase() : t;
  }
  if (row.customer_pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(row.customer_pan)) throw new AppError(400, 'BAD_PAN', 'PAN should be 10 characters, e.g. ABCDE1234F');
  return row;
}

/** Add or correct the ship-to, PAN and delivery details of a saved bill (they are not tax figures, so they may change). */
export async function saveInvoiceDetails(sql: Sql, ctx: Ctx, invoiceId: number, input: InvoiceDetailsInput) {
  requirePerm(ctx, 'billing.create');
  const row = detailRow(input);
  return sql.begin(async (tx) => {
    const [inv] = await tx<{ number: string }[]>`select number from sales_invoices where id = ${invoiceId}`;
    if (!inv) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const full: Record<string, any> = { invoice_id: invoiceId, ...row, updated_by: ctx.userId, updated_at: new Date() };
    const cols = Object.keys(full).filter((k) => k !== 'invoice_id');
    await tx`insert into invoice_details ${tx(full)} on conflict (invoice_id) do update set ${tx(full, ...cols)}`;
    await audit(tx, ctx, 'invoice.details_changed', { entity: 'sales_invoice', entityId: invoiceId, details: { number: inv.number, ...row } });
    return { ok: true };
  });
}

export interface ProductForBill {
  id: number;
  sku: string;
  name: string;
  hsn: string | null;
  unit_code: string;
  gst_rate_bp: number;
  sale_price_paise: number;
  price_includes_tax: boolean;
  cost_price_paise: number | null;
  active: boolean;
  max_disc_type: 'pct' | 'amt' | null;
  max_disc_value: number | null;
  /** A service (loading charges, transport…): billed like an item but no stock. */
  is_service: boolean;
  cat_disc_type: 'pct' | 'amt' | null;
  cat_disc_value: number | null;
  units: { unit_code: string; factor_num: number; factor_den: number; for_sale: boolean; for_purchase?: boolean; price_paise: number | null }[];
}

interface CustomerSnap {
  id: number;
  name: string;
  phone: string | null;
  gstin: string | null;
  address: string | null;
  state_code: string;
  ledger_id: number;
}

/** Reserve the next id first, so the voucher can point at the document before it is inserted. */
async function nextId(tx: Tx, sequence: 'sales_invoices_id_seq' | 'receipts_id_seq'): Promise<number> {
  const [r] = await tx<{ id: number }[]>`select nextval(${sequence})::bigint as id`;
  return r!.id;
}

/** A ₹-per-unit limit is per BASE unit; scale it to the unit being sold. */
const limitOf = (type: 'pct' | 'amt' | null, value: number | null, f: UnitFactor): DiscountLimit | null =>
  type && value != null ? (type === 'amt' ? { type, value: unitPrice(value, f) } : { type, value }) : null;

/** The unit a line is sold in, and its factor to the base unit. */
export function unitOf(p: Pick<ProductForBill, 'name' | 'unit_code' | 'units'>, unitCode: string | undefined, purpose: 'sale' | 'purchase' = 'sale') {
  if (!unitCode || unitCode === p.unit_code) return { code: p.unit_code, factor: BASE, ownPrice: null as number | null };
  const u = p.units.find((x) => x.unit_code === unitCode && (purpose === 'sale' ? x.for_sale : x.for_purchase !== false));
  if (!u) throw new AppError(400, 'BAD_UNIT', `"${p.name}" is not ${purpose === 'sale' ? 'sold' : 'bought'} in ${unitCode}`);
  return { code: u.unit_code, factor: { num: u.factor_num, den: u.factor_den }, ownPrice: u.price_paise };
}

/** The product's list price for a unit, in the requested mode. */
export function listRate(p: Pick<ProductForBill, 'sale_price_paise' | 'price_includes_tax' | 'gst_rate_bp'>, unit: { factor: UnitFactor; ownPrice: number | null }, mode: PriceMode) {
  const pm: PriceMode = p.price_includes_tax ? 'incl' : 'excl';
  const inProductMode = unit.ownPrice ?? unitPrice(p.sale_price_paise, unit.factor);
  return convertRate(inProductMode, pm, mode, p.gst_rate_bp);
}

export const PRODUCT_FOR_BILL_COLUMNS = `
  p.id, p.sku, p.name, p.hsn, p.unit_code, p.gst_rate_bp, p.sale_price_paise, p.price_includes_tax, p.cost_price_paise, p.active, p.is_service,
  p.max_disc_type, p.max_disc_value, c.max_disc_type as cat_disc_type, c.max_disc_value as cat_disc_value,
  coalesce((select json_agg(json_build_object('unit_code', u.unit_code, 'factor_num', u.factor_num, 'factor_den', u.factor_den,
            'for_sale', u.for_sale, 'for_purchase', u.for_purchase, 'price_paise', u.price_paise)) from product_units u where u.product_id = p.id), '[]'::json) as units`;

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
  if (input.placeOfSupply && !STATES[input.placeOfSupply]) throw new AppError(400, 'BAD_STATE', 'Place of supply is not a valid state');

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
    const details = input.details ? detailRow(input.details) : {};
    const productIds = [...new Set(input.lines.map((l) => l.productId))].sort((a, b) => a - b);
    const products = await tx.unsafe<ProductForBill[]>(
      `select ${PRODUCT_FOR_BILL_COLUMNS} from products p left join categories c on c.id = p.category_id where p.id = any($1::int[])`,
      [productIds as never],
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const id of productIds) {
      const p = byId.get(id);
      if (!p) throw new AppError(400, 'NO_PRODUCT', 'One of the items no longer exists. Remove it and add it again.');
      if (!p.active) throw new AppError(400, 'INACTIVE_PRODUCT', `"${p.name}" is no longer sold (inactive)`);
    }

    // Each line: unit, base quantity, rate in its mode.
    const resolved = input.lines.map((l) => {
      const p = byId.get(l.productId)!;
      const unit = unitOf(p, l.unitCode);
      const { baseMilli } = toBase(l.qtyMilli, unit.factor);
      if (baseMilli <= 0) throw new AppError(400, 'BAD_QTY', `Quantity of "${p.name}" is too small`);
      const mode: PriceMode = l.rateMode ?? (p.price_includes_tax ? 'incl' : 'excl');
      const list = listRate(p, unit, mode);
      const ratePaise = l.ratePaise ?? list;
      return { p, l, unit, baseMilli, mode, ratePaise, list };
    });

    // Lock the products (in a fixed order, to avoid deadlocks between counters), then read stock.
    // Another counter selling the same item waits here until this bill commits or fails.
    await lockProducts(tx, productIds);
    const balances = await tx<{ product_id: number; qty_milli: number }[]>`
      select product_id, qty_milli from stock_balances where product_id in ${tx(productIds)}`;
    const available = new Map(balances.map((b) => [b.product_id, b.qty_milli]));
    const needed = new Map<number, number>();
    for (const r of resolved) if (!r.p.is_service) needed.set(r.p.id, (needed.get(r.p.id) ?? 0) + r.baseMilli);
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
    for (const [i, r] of resolved.entries()) {
      const { p, l, unit, ratePaise, list, mode } = r;
      if (ratePaise !== list && !can(ctx, 'products.edit_price')) {
        throw new AppError(403, 'PRICE_CHANGE_NOT_ALLOWED', `Only admin can change the price of "${p.name}"`);
      }
      const maxBp = effectiveMaxDiscountBp({
        productLimit: limitOf(p.max_disc_type, p.max_disc_value, unit.factor),
        categoryLimit: limitOf(p.cat_disc_type, p.cat_disc_value, unit.factor),
        staffCapBp: can(ctx, 'billing.discount_over_limit') ? null : staffCapBp,
        ratePaise: convertRate(ratePaise, mode, 'excl', p.gst_rate_bp),
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
      prepared.push({ ...r, maxBp, overrideId });
    }

    let customer: CustomerSnap | null = null;
    if (input.customerId) {
      const [c] = await tx<CustomerSnap[]>`
        select id, name, phone, gstin, address, state_code, ledger_id from customers where id = ${input.customerId} and active`;
      if (!c) throw new AppError(400, 'NO_CUSTOMER', 'Customer not found or inactive');
      customer = c;
    }

    // GST place of supply: intra-state (CGST + SGST) or inter-state (IGST).
    const shopState = settings.stateCode;
    const pos = input.placeOfSupply ?? (customer?.gstin ? (stateFromGstin(customer.gstin) ?? shopState) : shopState);
    const supply: SupplyType = pos === shopState ? 'intra' : 'inter';

    const totals = calcBill(
      prepared.map(({ p, l, ratePaise, mode }) => ({ qtyMilli: l.qtyMilli, ratePaise, discountBp: l.discountBp, gstRateBp: p.gst_rate_bp, mode })),
      supply,
    );

    // GST invoice rules.
    const recipientName = customer?.name ?? (input.customerName?.trim() || null);
    const recipientAddress = customer?.address ?? (input.customerAddress?.trim() || null);
    if (customer?.gstin && !customer.address) {
      throw new AppError(400, 'B2B_NEEDS_ADDRESS', `${customer.name} is a registered business (GSTIN ${customer.gstin}). Add their address in Customers — it must be on the GST bill.`);
    }
    if (!customer?.gstin && totals.totalPaise >= B2C_DETAILS_THRESHOLD_PAISE && (!recipientName || !recipientAddress)) {
      throw new AppError(400, 'B2C_NEEDS_DETAILS', 'For a bill of ₹50,000 or more, GST rules need the customer’s name and address. Choose the customer or type the name and address.');
    }

    // Credit limit: going over it needs the admin (or their PIN). Lock the customer so two counters can't both slip under it.
    let overCredit: { balancePaise: number; limitPaise: number; afterPaise: number; approvedBy: number | null } | null = null;
    if (input.paymentMode === 'credit' && customer) {
      const [lim] = await tx<{ credit_limit_paise: number | null }[]>`select credit_limit_paise from customers where id = ${customer.id} for no key update`;
      if (lim?.credit_limit_paise != null) {
        const balancePaise = await ledgerBalance(tx, customer.ledger_id);
        const afterPaise = balancePaise + totals.totalPaise;
        if (afterPaise > lim.credit_limit_paise) {
          let approvedBy: number | null = null;
          if (!can(ctx, 'billing.over_credit_limit')) {
            if (!input.creditOverrideToken)
              throw new AppError(403, 'NEEDS_OVERRIDE', `${customer.name} would owe ₹${(afterPaise / 100).toFixed(2)}, over their credit limit of ₹${(lim.credit_limit_paise / 100).toFixed(2)}. Admin PIN needed.`, {
                permission: 'billing.over_credit_limit',
                customerId: customer.id,
                balancePaise,
                limitPaise: lim.credit_limit_paise,
                afterPaise,
              });
            approvedBy = (await consumeOverride(tx, ctx, input.creditOverrideToken, 'billing.over_credit_limit', (c) => c.customerId === customer!.id && typeof c.upToPaise === 'number' && c.upToPaise >= afterPaise)).approvedBy;
          }
          overCredit = { balancePaise, limitPaise: lim.credit_limit_paise, afterPaise, approvedBy };
        }
      }
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
        customer_gstin, customer_address, supply_type, place_of_supply, payment_mode, gross_paise, discount_paise, taxable_paise,
        cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, voucher_id, notes, user_id, device_id, client_ref)
      values (${id}, ${number}, ${fy}, ${seq}, ${date}, ${at}, ${customer?.id ?? null},
        ${recipientName}, ${customer?.phone ?? (input.customerPhone?.trim() || null)},
        ${customer?.gstin ?? null}, ${recipientAddress}, ${supply}, ${pos}, ${input.paymentMode}, ${totals.grossPaise},
        ${totals.discountPaise}, ${totals.taxablePaise}, ${totals.cgstPaise}, ${totals.sgstPaise}, ${totals.igstPaise},
        ${totals.roundOffPaise}, ${totals.totalPaise}, ${voucherId}, ${input.notes?.trim() || null}, ${ctx.userId},
        ${ctx.deviceId}, ${input.clientRef ?? null})`;

    await tx`insert into sales_invoice_lines ${tx(
      prepared.map(({ p, l, unit, baseMilli, mode, ratePaise, maxBp, overrideId }, i) => {
        const r = totals.lines[i]!;
        return {
          invoice_id: id,
          line_no: i + 1,
          product_id: p.id,
          product_name: p.name,
          sku: p.sku,
          hsn: p.hsn,
          unit_code: unit.code,
          qty_milli: l.qtyMilli,
          factor_num: unit.factor.num,
          factor_den: unit.factor.den,
          base_qty_milli: baseMilli,
          rate_paise: ratePaise,
          rate_mode: mode,
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
          amount_paise: r.amountPaise,
          cost_price_paise: p.cost_price_paise,
          override_id: overrideId,
        };
      }),
    )}`;

    const goods = prepared.filter(({ p }) => !p.is_service);
    if (goods.length) await tx`insert into stock_movements ${tx(
      goods.map(({ p, baseMilli }) => ({
        product_id: p.id,
        qty_milli: -baseMilli,
        kind: 'sale',
        ref_type: 'sales_invoice',
        ref_id: id,
        unit_cost_paise: p.cost_price_paise,
        user_id: ctx.userId,
        device_id: ctx.deviceId,
        at,
      })),
    )}`;

    if (Object.values(details).some((v) => v)) {
      await tx`insert into invoice_details ${tx({ invoice_id: id, ...details, updated_by: ctx.userId })}`;
    }

    if (input.partnerId) await tagInvoicePartner(tx, ctx, id, input.partnerId, input.siteId ?? null);

    await audit(tx, ctx, 'invoice.created', {
      entity: 'sales_invoice',
      entityId: id,
      details: { number, totalPaise: totals.totalPaise, paymentMode: input.paymentMode, items: prepared.length, customerId: customer?.id ?? null, supply },
    });
    if (overCredit) {
      await audit(tx, ctx, 'credit.over_limit', {
        entity: 'sales_invoice',
        entityId: id,
        details: { number, customerId: customer!.id, customer: customer!.name, balancePaise: overCredit.balancePaise, limitPaise: overCredit.limitPaise, afterPaise: overCredit.afterPaise },
        approvedBy: overCredit.approvedBy,
      });
    }
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
  const lines = await q`
    select l.*, (select p.is_service from products p where p.id = l.product_id) as is_service, coalesce((select sum(cl.qty_milli) from credit_note_lines cl join credit_notes cn on cn.id = cl.credit_note_id
                          where cl.invoice_line_id = l.id and cn.status = 'posted'), 0) as returned_qty_milli
    from sales_invoice_lines l where l.invoice_id = ${id} order by l.line_no`;
  if (!opts.withCost) for (const l of lines) delete l.cost_price_paise;
  const creditNotes = await q`select id, number, note_date, total_paise, status from credit_notes where invoice_id = ${id} order by id`;
  const [details] = await q`select * from invoice_details where invoice_id = ${id}`;
  // Printed when the bill's own boxes are blank: the quotation it came from, and its delivery challans.
  const [quote] = await q<{ number: string; quote_date: string }[]>`select number, quote_date::text from quotations where converted_invoice_id = ${id} limit 1`;
  const challans = await q<{ number: string }[]>`select number from deliveries where invoice_id = ${id} and status <> 'cancelled' order by id`;
  return { ...inv, lines, credit_notes: creditNotes, details: details ?? null, quotation: quote ?? null, challans: challans.map((c) => c.number) };
}

export async function listInvoices(
  q: Q,
  f: { from?: string; to?: string; search?: string; status?: string; customerId?: number; paymentMode?: string; limit?: number },
) {
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  return q`
    select si.id, si.number, si.invoice_date, si.at, si.customer_id, si.customer_name, si.customer_phone, si.payment_mode,
           si.total_paise, si.discount_paise, si.status, si.supply_type, si.customer_gstin, u.name as user_name, d.name as device_name,
           (select count(*)::int from sales_invoice_lines l where l.invoice_id = si.id) as item_count,
           (select count(*)::int from credit_notes cn where cn.invoice_id = si.id and cn.status = 'posted') as return_count
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
    const [inv] = await tx<{ id: number; number: string; status: string; voucher_id: number | null; total_paise: number; invoice_date: string }[]>`
      select id, number, status, voucher_id, total_paise, invoice_date from sales_invoices where id = ${id} for update`;
    if (!inv) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
    if (inv.status === 'cancelled') throw new AppError(409, 'ALREADY_CANCELLED', `Bill ${inv.number} is already cancelled`);
    await assertMonthOpen(tx, inv.invoice_date, `Bill ${inv.number} is in a month whose GSTR-1 is filed, so it can't be cancelled. Use “Return items” to issue a credit note instead.`);
    const [ret] = await tx`select 1 from credit_notes where invoice_id = ${id} and status = 'posted' limit 1`;
    if (ret) throw new AppError(409, 'HAS_RETURNS', `Bill ${inv.number} already has a sales return. Use “Return items” for the rest instead of cancelling.`);

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
    const lines = await tx<{ product_id: number; base_qty_milli: number; cost_price_paise: number | null }[]>`
      select l.product_id, l.base_qty_milli, l.cost_price_paise from sales_invoice_lines l join products p on p.id = l.product_id
      where l.invoice_id = ${id} and not p.is_service`;
    if (lines.length) await tx`insert into stock_movements ${tx(
      lines.map((l) => ({
        product_id: l.product_id,
        qty_milli: l.base_qty_milli,
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
    await reverseRewardsOnCancel(tx, ctx, id, inv.number);
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
  input: { clientRef?: string; customerId: number; mode: 'cash' | 'upi' | 'card' | 'bank' | 'cheque'; amountPaise: number; reference?: string; notes?: string; allocations?: { invoiceId: number; amountPaise: number }[] },
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
    // Settle specific credit bills (the rest stays "on account" and settles the oldest bills first).
    const allocs = (input.allocations ?? []).filter((a) => a.amountPaise > 0);
    if (allocs.length) {
      if (allocs.reduce((t, a) => t + a.amountPaise, 0) > input.amountPaise) throw new AppError(400, 'OVER_ALLOCATED', 'The bills ticked add up to more than the payment');
      const open = new Map((await openCreditBills(tx, c.id)).map((b) => [b.id, b]));
      for (const a of allocs) {
        const b = open.get(a.invoiceId);
        if (!b) throw new AppError(400, 'BAD_BILL', 'A ticked bill is not an unpaid credit bill of this customer');
        if (a.amountPaise > b.due_paise) throw new AppError(400, 'OVER_BILL', `Bill ${b.number} has only ₹${(b.due_paise / 100).toFixed(2)} left to pay`);
      }
      await tx`insert into receipt_allocations ${tx(allocs.map((a) => ({ receipt_id: id, invoice_id: a.invoiceId, amount_paise: a.amountPaise })))}`;
    }
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

/**
 * A customer's credit bills with what is still due on each: bill total, less receipts marked
 * against it, less returns credited to their account. (Payments "on account" are not here;
 * the ageing report applies them to the oldest bills.)
 */
export async function openCreditBills(q: Q, customerId: number) {
  return q<{ id: number; number: string; invoice_date: string; total_paise: number; paid_paise: number; returned_paise: number; due_paise: number }[]>`
    select x.*, x.total_paise - x.paid_paise - x.returned_paise as due_paise from (
      select si.id, si.number, si.invoice_date, si.total_paise,
             coalesce((select sum(a.amount_paise) from receipt_allocations a join receipts r on r.id = a.receipt_id
                       where a.invoice_id = si.id and r.status = 'posted'), 0)::bigint as paid_paise,
             coalesce((select sum(cn.total_paise) from credit_notes cn
                       where cn.invoice_id = si.id and cn.status = 'posted' and cn.refund_mode = 'account'), 0)::bigint as returned_paise
      from sales_invoices si
      where si.customer_id = ${customerId} and si.status = 'posted' and si.payment_mode = 'credit'
    ) x
    order by x.invoice_date, x.id`;
}

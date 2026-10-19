import { exclFromIncl, fyStartYear, istDate, mulDivRound, toBase } from '@kph/core';
import { PRODUCT_FOR_BILL_COLUMNS, unitOf, type ProductForBill } from './billing.js';
import type { Q, Sql } from '../db/connect.js';
import { consumeOverride } from './auth.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';
import { nextDocNumber, postVoucher, reverseVoucher, systemLedgerIds } from './ledger.js';
import { normalizeText } from './matching.js';
import { lockProducts } from './products.js';
import { getSettings } from './settings.js';

/**
 * A purchase is a supplier's bill entered into Store Desk (typed by hand or read
 * by the scanner). Saving it, in one transaction:
 *   - adds every line to stock ("purchase" stock movements, at cost)
 *   - posts the accounts: Purchases + Input GST + Freight  →  supplier owes-to balance
 *   - updates each product's cost price to the latest purchase cost
 *   - remembers how this supplier names each product, for the next scan
 * The same supplier bill number can't be entered twice.
 */

export interface NewProductInput {
  name: string;
  sku?: string;
  unitCode: string;
  hsn?: string | null;
  categoryId?: number | null;
  salePricePaise?: number;
}

export interface PurchaseLineInput {
  productId?: number;
  newProduct?: NewProductInput;
  description?: string;
  /** Quantity in unitCode (default: the product's base unit). */
  qtyMilli: number;
  unitCode?: string;
  /** Actual count received in the base unit, e.g. rods counted off a 5-tonne load. Overrides the conversion. */
  baseQtyMilli?: number;
  /** Value of the line excluding GST, after any trade discount — as on the supplier's bill. */
  taxablePaise?: number;
  /** Or: the line value as typed in amountMode (incl = including GST). */
  amountPaise?: number;
  amountMode?: 'excl' | 'incl';
  gstRateBp: number;
  hsn?: string | null;
}

function lineTaxable(l: PurchaseLineInput): number {
  if (l.amountMode === 'incl') {
    if (l.amountPaise == null) return NaN;
    return exclFromIncl(l.amountPaise, l.gstRateBp);
  }
  return l.taxablePaise ?? l.amountPaise ?? NaN;
}

export interface PurchaseInput {
  clientRef?: string;
  supplierId: number;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  supplyType?: 'intra' | 'inter';
  freightPaise?: number;
  /** The grand total printed on the bill. Small differences (≤ ₹10) go to round-off. */
  billTotalPaise?: number;
  notes?: string;
  scanId?: number;
  updateCostPrice?: boolean;
  lines: PurchaseLineInput[];
}

export const MAX_ROUND_OFF_PAISE = 1000;

export function calcPurchaseLine(l: { taxablePaise: number; gstRateBp: number }, supply: 'intra' | 'inter') {
  if (supply === 'inter') {
    const igst = mulDivRound(l.taxablePaise, l.gstRateBp, 10000);
    return { cgst: 0, sgst: 0, igst, total: l.taxablePaise + igst };
  }
  const half = mulDivRound(l.taxablePaise, l.gstRateBp, 20000);
  return { cgst: half, sgst: half, igst: 0, total: l.taxablePaise + 2 * half };
}

export async function createPurchase(sql: Sql, ctx: Ctx, input: PurchaseInput) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can enter purchases');
  const billNo = input.supplierInvoiceNo?.trim();
  if (!billNo) throw new AppError(400, 'BILL_NO_REQUIRED', "Enter the supplier's bill number");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.supplierInvoiceDate)) throw new AppError(400, 'BAD_DATE', "Enter the supplier's bill date");
  if (input.supplierInvoiceDate > istDate()) throw new AppError(400, 'FUTURE_DATE', 'The bill date is in the future');
  if (!input.lines.length) throw new AppError(400, 'NO_LINES', 'Add at least one item');
  const supply = input.supplyType ?? 'intra';
  const freight = input.freightPaise ?? 0;
  if (!Number.isSafeInteger(freight) || freight < 0) throw new AppError(400, 'BAD_FREIGHT', 'Freight must be zero or more');
  const lines = input.lines.map((l) => ({ ...l, taxablePaise: lineTaxable(l) }));
  for (const [i, l] of lines.entries()) {
    if (!l.productId && !l.newProduct) throw new AppError(400, 'NO_PRODUCT', `Line ${i + 1}: choose our product or create a new one`);
    if (!Number.isSafeInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new AppError(400, 'BAD_QTY', `Line ${i + 1}: quantity must be more than zero`);
    if (l.baseQtyMilli != null && (!Number.isSafeInteger(l.baseQtyMilli) || l.baseQtyMilli <= 0)) throw new AppError(400, 'BAD_QTY', `Line ${i + 1}: counted quantity must be more than zero`);
    if (!Number.isSafeInteger(l.taxablePaise) || l.taxablePaise < 0) throw new AppError(400, 'BAD_AMOUNT', `Line ${i + 1}: amount is not valid`);
    if (!Number.isSafeInteger(l.gstRateBp) || l.gstRateBp < 0 || l.gstRateBp > 10000) throw new AppError(400, 'BAD_GST', `Line ${i + 1}: GST rate is not valid`);
    if (l.newProduct && !can(ctx, 'products.manage')) throw new AppError(403, 'FORBIDDEN', `Line ${i + 1}: only admin can create new products. Ask admin, or pick an existing product.`);
  }

  const computed = lines.map((l) => ({ l, base: 0, billUnit: '', ...calcPurchaseLine(l, supply) }));
  const taxable = computed.reduce((s, c) => s + c.l.taxablePaise, 0);
  const cgst = computed.reduce((s, c) => s + c.cgst, 0);
  const sgst = computed.reduce((s, c) => s + c.sgst, 0);
  const igst = computed.reduce((s, c) => s + c.igst, 0);
  const raw = taxable + cgst + sgst + igst + freight;
  const total = input.billTotalPaise ?? raw;
  const roundOff = total - raw;
  if (Math.abs(roundOff) > MAX_ROUND_OFF_PAISE) {
    throw new AppError(400, 'TOTAL_MISMATCH', `The bill total (₹${(total / 100).toFixed(2)}) differs from the items (₹${(raw / 100).toFixed(2)}) by more than ₹10. Check quantities, amounts and GST.`, {
      billTotalPaise: total,
      computedPaise: raw,
    });
  }

  try {
    return await sql.begin(async (tx) => {
      if (input.clientRef) {
        const [e] = await tx<{ id: number; number: string }[]>`select id, number from purchase_invoices where client_ref = ${input.clientRef}`;
        if (e) return { ...e, duplicate: true, createdProducts: [] as number[] };
      }
      const [supplier] = await tx<{ id: number; name: string; ledger_id: number }[]>`select id, name, ledger_id from suppliers where id = ${input.supplierId}`;
      if (!supplier) throw new AppError(400, 'NO_SUPPLIER', 'Choose the supplier');
      const [dup] = await tx<{ number: string }[]>`
        select number from purchase_invoices where supplier_id = ${supplier.id} and lower(supplier_invoice_no) = ${billNo.toLowerCase()} and status = 'posted'`;
      if (dup) throw new AppError(409, 'DUPLICATE_BILL', `This bill (${billNo} from ${supplier.name}) was already entered as ${dup.number}. It was not added again.`);

      // New products first, so every line has a product.
      const createdProducts: number[] = [];
      const productIds: number[] = [];
      for (const c of computed) {
        if (c.l.productId) {
          productIds.push(c.l.productId);
          continue;
        }
        const np = c.l.newProduct!;
        const sku = np.sku?.trim() || (await nextAutoSku(tx));
        const [p] = await tx<{ id: number }[]>`
          insert into products (sku, name, category_id, unit_code, hsn, gst_rate_bp, sale_price_paise, cost_price_paise)
          values (${sku}, ${np.name.trim()}, ${np.categoryId ?? null}, ${np.unitCode}, ${np.hsn?.trim() || c.l.hsn || null},
                  ${c.l.gstRateBp}, ${np.salePricePaise ?? 0}, ${mulDivRound(c.l.taxablePaise, 1000, c.l.baseQtyMilli ?? c.l.qtyMilli)})
          on conflict do nothing
          returning id`;
        if (!p) throw new AppError(409, 'DUPLICATE_SKU', `A product with SKU ${sku} already exists`);
        await audit(tx, ctx, 'product.created', { entity: 'product', entityId: p.id, details: { sku, name: np.name, from: 'purchase' } });
        createdProducts.push(p.id);
        c.l.productId = p.id;
        productIds.push(p.id);
      }

      await lockProducts(tx, productIds);
      const products = await tx.unsafe<ProductForBill[]>(
        `select ${PRODUCT_FOR_BILL_COLUMNS} from products p left join categories c on c.id = p.category_id where p.id = any($1::int[])`,
        [[...new Set(productIds)] as never],
      );
      const byId = new Map(products.map((p) => [p.id, p]));
      for (const id of productIds) if (!byId.get(id)) throw new AppError(400, 'NO_PRODUCT', 'One of the products no longer exists');
      // Bought in another unit (e.g. tonnes) → stock in the base unit (e.g. rods), or the count actually received.
      for (const [i, c] of computed.entries()) {
        const p = byId.get(c.l.productId!)!;
        const unit = c.l.newProduct ? { code: p.unit_code, factor: { num: 1, den: 1 } } : unitOf(p, c.l.unitCode, 'purchase');
        c.billUnit = unit.code;
        c.base = c.l.baseQtyMilli ?? toBase(c.l.qtyMilli, unit.factor).baseMilli;
        if (c.base <= 0) throw new AppError(400, 'BAD_QTY', `Line ${i + 1}: quantity is too small`);
      }

      const settings = await getSettings(tx);
      const now = new Date();
      const fy = fyStartYear(now);
      const { seq, number } = await nextDocNumber(tx, 'purchase', settings.purchasePrefix, fy);
      const [{ id }] = (await tx<{ id: number }[]>`select nextval('purchase_invoices_id_seq')::bigint as id`) as unknown as [{ id: number }];

      const L = await systemLedgerIds(tx);
      const voucherId = await postVoucher(tx, ctx, {
        vtype: 'purchase',
        vdate: input.supplierInvoiceDate,
        narration: `Purchase ${number} — ${supplier.name} bill ${billNo}`,
        refType: 'purchase_invoice',
        refId: id,
        lines: [
          { ledgerId: L.purchases, amountPaise: taxable },
          { ledgerId: L.input_cgst, amountPaise: cgst },
          { ledgerId: L.input_sgst, amountPaise: sgst },
          { ledgerId: L.input_igst, amountPaise: igst },
          { ledgerId: L.freight_in, amountPaise: freight },
          { ledgerId: L.round_off, amountPaise: roundOff },
          { ledgerId: supplier.ledger_id, amountPaise: -total },
        ],
      });

      await tx`
        insert into purchase_invoices (id, number, fy_start, seq, supplier_id, supplier_invoice_no, supplier_invoice_date, supply_type,
          taxable_paise, cgst_paise, sgst_paise, igst_paise, freight_paise, round_off_paise, total_paise, source, scan_id,
          voucher_id, notes, user_id, device_id, client_ref)
        values (${id}, ${number}, ${fy}, ${seq}, ${supplier.id}, ${billNo}, ${input.supplierInvoiceDate}, ${supply},
          ${taxable}, ${cgst}, ${sgst}, ${igst}, ${freight}, ${roundOff}, ${total}, ${input.scanId ? 'scan' : 'manual'},
          ${input.scanId ?? null}, ${voucherId}, ${input.notes?.trim() || null}, ${ctx.userId}, ${ctx.deviceId}, ${input.clientRef ?? null})`;

      const rows = computed.map((c, i) => {
        const p = byId.get(c.l.productId!)!;
        return {
          purchase_id: id,
          line_no: i + 1,
          product_id: p.id,
          description: c.l.description?.trim() || null,
          hsn: c.l.hsn?.trim() || p.hsn,
          qty_milli: c.base,
          unit_code: p.unit_code,
          bill_unit_code: c.billUnit,
          bill_qty_milli: c.l.qtyMilli,
          amount_mode: c.l.amountMode ?? 'excl',
          unit_cost_paise: mulDivRound(c.l.taxablePaise, 1000, c.base),
          taxable_paise: c.l.taxablePaise,
          gst_rate_bp: c.l.gstRateBp,
          cgst_paise: c.cgst,
          sgst_paise: c.sgst,
          igst_paise: c.igst,
          total_paise: c.total,
        };
      });
      await tx`insert into purchase_lines ${tx(rows)}`;
      await tx`insert into stock_movements ${tx(
        rows.map((r) => ({
          product_id: r.product_id,
          qty_milli: r.qty_milli,
          kind: 'purchase',
          ref_type: 'purchase_invoice',
          ref_id: id,
          unit_cost_paise: r.unit_cost_paise,
          user_id: ctx.userId,
          device_id: ctx.deviceId,
        })),
      )}`;

      // Latest cost price, with history.
      if (input.updateCostPrice !== false) {
        for (const r of rows) {
          const p = byId.get(r.product_id)!;
          if (p.cost_price_paise === r.unit_cost_paise) continue;
          await tx`update products set cost_price_paise = ${r.unit_cost_paise}, updated_at = now() where id = ${p.id}`;
          await tx`insert into price_history (product_id, field, old_value, new_value, user_id, device_id)
                   values (${p.id}, 'cost_price_paise', ${p.cost_price_paise}, ${r.unit_cost_paise}, ${ctx.userId}, ${ctx.deviceId})`;
          p.cost_price_paise = r.unit_cost_paise;
        }
      }

      // Remember "supplier text → our product" for the next scan.
      for (const c of computed) {
        const alias = c.l.description ? normalizeText(c.l.description) : '';
        if (!alias) continue;
        await tx`
          insert into product_aliases (supplier_id, alias, product_id) values (${supplier.id}, ${alias}, ${c.l.productId!})
          on conflict (coalesce(supplier_id, 0), alias) do update set product_id = excluded.product_id, last_used_at = now()`;
      }

      if (input.scanId) await tx`update purchase_scans set status = 'used', purchase_id = ${id} where id = ${input.scanId}`;

      await audit(tx, ctx, 'purchase.created', {
        entity: 'purchase_invoice',
        entityId: id,
        details: { number, supplier: supplier.name, billNo, totalPaise: total, items: rows.length, source: input.scanId ? 'scan' : 'manual', newProducts: createdProducts.length },
      });
      return { id, number, duplicate: false, createdProducts };
    });
  } catch (e) {
    const err = e as { code?: string; constraint_name?: string };
    if (err.code === '23505' && err.constraint_name === 'purchase_invoices_supplier_bill_uq') {
      throw new AppError(409, 'DUPLICATE_BILL', `This supplier bill (${billNo}) has already been entered. It was not added again.`);
    }
    throw e;
  }
}

async function nextAutoSku(q: Q) {
  const [r] = await q<{ n: number }[]>`select count(*)::int + 1 as n from products where sku like 'NEW-%'`;
  return `NEW-${String(r!.n).padStart(5, '0')}`;
}

export async function listPurchases(q: Q, f: { from?: string; to?: string; supplierId?: number; search?: string }) {
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  return q`
    select p.id, p.number, p.supplier_invoice_no, p.supplier_invoice_date, p.at, p.total_paise, p.status, p.source,
           s.name as supplier_name, u.name as user_name, d.name as device_name,
           (select count(*)::int from purchase_lines l where l.purchase_id = p.id) as item_count
    from purchase_invoices p join suppliers s on s.id = p.supplier_id join users u on u.id = p.user_id left join devices d on d.id = p.device_id
    where (${f.from ?? null}::date is null or p.supplier_invoice_date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or p.supplier_invoice_date <= ${f.to ?? null}::date)
      and (${f.supplierId ?? null}::int is null or p.supplier_id = ${f.supplierId ?? null})
      and (${search}::text is null or lower(p.number) like ${search} or lower(p.supplier_invoice_no) like ${search} or lower(s.name) like ${search})
    order by p.id desc limit 500`;
}

export async function getPurchase(q: Q, id: number) {
  const [p] = await q`
    select p.*, s.name as supplier_name, s.gstin as supplier_gstin, u.name as user_name, d.name as device_name,
           cu.name as cancelled_by_name, sc.page_files
    from purchase_invoices p join suppliers s on s.id = p.supplier_id join users u on u.id = p.user_id
    left join devices d on d.id = p.device_id left join users cu on cu.id = p.cancelled_by
    left join purchase_scans sc on sc.id = p.scan_id
    where p.id = ${id}`;
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Purchase not found');
  const lines = await q`
    select l.*, pr.name as product_name, pr.sku from purchase_lines l join products pr on pr.id = l.product_id
    where l.purchase_id = ${id} order by l.line_no`;
  return { ...p, page_count: (p.page_files as string[] | null)?.length ?? 0, page_files: undefined, lines };
}

/** Cancel a purchase entered by mistake: stock comes off again and the accounts are reversed. */
export async function cancelPurchase(sql: Sql, ctx: Ctx, id: number, input: { reason: string; overrideToken?: string }) {
  requirePerm(ctx, 'stock.adjust');
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason for cancelling');
  return sql.begin(async (tx) => {
    const [p] = await tx<{ id: number; number: string; status: string; voucher_id: number | null; total_paise: number }[]>`
      select id, number, status, voucher_id, total_paise from purchase_invoices where id = ${id} for update`;
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Purchase not found');
    if (p.status === 'cancelled') throw new AppError(409, 'ALREADY_CANCELLED', `${p.number} is already cancelled`);
    let approvedBy: number | null = null;
    if (!can(ctx, 'billing.cancel')) {
      if (!input.overrideToken) throw new AppError(403, 'NEEDS_OVERRIDE', 'Cancelling a purchase needs the admin PIN', { permission: 'billing.cancel', purchaseId: id });
      approvedBy = (await consumeOverride(tx, ctx, input.overrideToken, 'billing.cancel', (c) => c.purchaseId === id)).approvedBy;
    }
    const [dn] = await tx`select 1 from debit_notes where purchase_id = ${id} and status = 'posted' limit 1`;
    if (dn) throw new AppError(409, 'HAS_RETURNS', `${p.number} already has goods returned to the supplier, so it can't be cancelled.`);
    const lines = await tx<{ product_id: number; qty_milli: number; unit_cost_paise: number }[]>`
      select product_id, qty_milli, unit_cost_paise from purchase_lines where purchase_id = ${id}`;
    await lockProducts(tx, lines.map((l) => l.product_id));
    const settings = await getSettings(tx);
    if (!settings.allowNegativeStock) {
      const bal = await tx<{ product_id: number; qty_milli: number; name: string }[]>`
        select p.id as product_id, coalesce(sb.qty_milli, 0) as qty_milli, p.name from products p left join stock_balances sb on sb.product_id = p.id
        where p.id in ${tx(lines.map((l) => l.product_id))}`;
      const need = new Map<number, number>();
      for (const l of lines) need.set(l.product_id, (need.get(l.product_id) ?? 0) + l.qty_milli);
      const short = bal.filter((b) => b.qty_milli < (need.get(b.product_id) ?? 0));
      if (short.length) throw new AppError(409, 'STOCK_ALREADY_SOLD', `Some of these items have already been sold, so the purchase can't be cancelled: ${short.map((s) => s.name).join(', ')}. Use a stock adjustment or purchase return instead.`);
    }
    const cancelVoucherId = p.voucher_id ? await reverseVoucher(tx, ctx, p.voucher_id, istDate(), `Cancelled purchase ${p.number}: ${reason}`) : null;
    await tx`insert into stock_movements ${tx(
      lines.map((l) => ({ product_id: l.product_id, qty_milli: -l.qty_milli, kind: 'purchase_return', ref_type: 'purchase_invoice', ref_id: id, unit_cost_paise: l.unit_cost_paise, reason: `Purchase cancelled: ${reason}`, user_id: ctx.userId, device_id: ctx.deviceId })),
    )}`;
    await tx`update purchase_invoices set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = now(), cancelled_by = ${ctx.userId},
             cancel_approved_by = ${approvedBy}, cancel_voucher_id = ${cancelVoucherId} where id = ${id}`;
    await audit(tx, ctx, 'purchase.cancelled', { entity: 'purchase_invoice', entityId: id, details: { number: p.number, totalPaise: p.total_paise }, reason, approvedBy });
    return { id, number: p.number };
  });
}

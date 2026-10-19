import { fyStartYear, istDate, mulDivRound, roundToRupee, toBase } from '@kph/core';
import type { Q, Sql } from '../db/connect.js';
import { consumeOverride } from './auth.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';
import { nextDocNumber, postVoucher, systemLedgerIds } from './ledger.js';
import { lockProducts } from './products.js';
import { reverseRewardsOnReturn } from './partners.js';
import { getSettings } from './settings.js';

/**
 * Returns never edit the original bill or purchase. They are new documents:
 *   sales return    → credit note  CN/26-27/000001 (stock back, GST and customer balance reduced, or refund)
 *   purchase return → debit note   DN/26-27/000001 (stock out, supplier balance and input GST reduced)
 * A line can be returned in parts; the last part takes exactly what is left, so the
 * returns of a line always add up to the original to the paisa.
 */

function taxes(taxable: number, rateBp: number, supply: 'intra' | 'inter') {
  if (supply === 'inter') return { cgst: 0, sgst: 0, igst: mulDivRound(taxable, rateBp, 10000) };
  const half = mulDivRound(taxable, rateBp, 20000);
  return { cgst: half, sgst: half, igst: 0 };
}

// ================================================================== sales returns

export type RefundMode = 'account' | 'cash' | 'upi' | 'card' | 'bank';

export interface CreditNoteInput {
  clientRef?: string;
  reason: string;
  refundMode: RefundMode;
  overrideToken?: string;
  lines: { invoiceLineId: number; qtyMilli: number; restock: boolean }[];
}

interface InvLine {
  id: number;
  line_no: number;
  product_id: number;
  product_name: string;
  unit_code: string;
  qty_milli: number;
  base_qty_milli: number;
  factor_num: number;
  factor_den: number;
  taxable_paise: number;
  gst_rate_bp: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  cost_price_paise: number | null;
  ret_qty: number;
  ret_base: number;
  ret_taxable: number;
  ret_cgst: number;
  ret_sgst: number;
  ret_igst: number;
}

export async function createCreditNote(sql: Sql, ctx: Ctx, invoiceId: number, input: CreditNoteInput) {
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason for the return');
  if (!input.lines.length) throw new AppError(400, 'NO_LINES', 'Choose what is being returned');
  return sql.begin(async (tx) => {
    if (input.clientRef) {
      const [e] = await tx<{ id: number; number: string }[]>`select id, number from credit_notes where client_ref = ${input.clientRef}`;
      if (e) return e;
    }
    const [inv] = await tx<{ id: number; number: string; status: string; customer_id: number | null; customer_name: string | null; supply_type: 'intra' | 'inter'; total_paise: number; invoice_date: string }[]>`
      select id, number, status, customer_id, customer_name, supply_type, total_paise, invoice_date from sales_invoices where id = ${invoiceId} for update`;
    if (!inv) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
    if (inv.status !== 'posted') throw new AppError(409, 'NOT_POSTED', `Bill ${inv.number} is cancelled; nothing can be returned`);

    let approvedBy: number | null = null;
    if (!can(ctx, 'returns.create')) {
      if (!input.overrideToken) throw new AppError(403, 'NEEDS_OVERRIDE', 'Taking back goods needs the admin PIN', { permission: 'returns.create', invoiceId });
      approvedBy = (await consumeOverride(tx, ctx, input.overrideToken, 'returns.create', (c) => c.invoiceId === invoiceId)).approvedBy;
    }
    if (input.refundMode === 'account' && !inv.customer_id) throw new AppError(400, 'NO_ACCOUNT', 'This was a walk-in bill, so there is no account to credit. Choose a cash or UPI refund.');

    const lines = await tx<InvLine[]>`
      select l.id, l.line_no, l.product_id, l.product_name, l.unit_code, l.qty_milli, l.base_qty_milli, l.factor_num, l.factor_den,
             l.taxable_paise, l.gst_rate_bp, l.cgst_paise, l.sgst_paise, l.igst_paise, l.cost_price_paise,
             coalesce(sum(cl.qty_milli), 0) as ret_qty, coalesce(sum(cl.base_qty_milli), 0) as ret_base,
             coalesce(sum(cl.taxable_paise), 0) as ret_taxable, coalesce(sum(cl.cgst_paise), 0) as ret_cgst,
             coalesce(sum(cl.sgst_paise), 0) as ret_sgst, coalesce(sum(cl.igst_paise), 0) as ret_igst
      from sales_invoice_lines l
      left join credit_note_lines cl on cl.invoice_line_id = l.id
        and exists (select 1 from credit_notes cn where cn.id = cl.credit_note_id and cn.status = 'posted')
      where l.invoice_id = ${invoiceId}
      group by l.id order by l.line_no`;
    const byId = new Map(lines.map((l) => [l.id, l]));

    const seen = new Set<number>();
    const rows = input.lines.map((r, i) => {
      const l = byId.get(r.invoiceLineId);
      if (!l) throw new AppError(400, 'BAD_LINE', `Line ${i + 1} is not on bill ${inv.number}`);
      if (seen.has(l.id)) throw new AppError(400, 'BAD_LINE', `${l.product_name} is listed twice`);
      seen.add(l.id);
      const left = l.qty_milli - l.ret_qty;
      if (!Number.isSafeInteger(r.qtyMilli) || r.qtyMilli <= 0) throw new AppError(400, 'BAD_QTY', `${l.product_name}: enter the quantity returned`);
      if (r.qtyMilli > left) throw new AppError(400, 'TOO_MUCH', `${l.product_name}: only ${left / 1000} ${l.unit_code} can still be returned from this bill`);
      const last = r.qtyMilli === left;
      const base = last ? l.base_qty_milli - l.ret_base : toBase(r.qtyMilli, { num: l.factor_num, den: l.factor_den }).baseMilli;
      const taxable = last ? l.taxable_paise - l.ret_taxable : mulDivRound(l.taxable_paise, r.qtyMilli, l.qty_milli);
      const t = last
        ? { cgst: l.cgst_paise - l.ret_cgst, sgst: l.sgst_paise - l.ret_sgst, igst: l.igst_paise - l.ret_igst }
        : taxes(taxable, l.gst_rate_bp, inv.supply_type);
      return { r, l, base, taxable, ...t, total: taxable + t.cgst + t.sgst + t.igst, last };
    });

    const taxable = rows.reduce((s, x) => s + x.taxable, 0);
    const cgst = rows.reduce((s, x) => s + x.cgst, 0);
    const sgst = rows.reduce((s, x) => s + x.sgst, 0);
    const igst = rows.reduce((s, x) => s + x.igst, 0);
    const raw = taxable + cgst + sgst + igst;
    // Returning everything that's left on the bill → refund exactly what remains of the bill total.
    const everythingLeft = lines.every((l) => {
      const row = rows.find((x) => x.l.id === l.id);
      return l.qty_milli - l.ret_qty === 0 || (row && row.last);
    });
    const [prev] = await tx<{ t: number }[]>`select coalesce(sum(total_paise), 0) as t from credit_notes where invoice_id = ${invoiceId} and status = 'posted'`;
    const total = everythingLeft ? inv.total_paise - prev!.t : roundToRupee(raw);
    const roundOff = total - raw;

    const settings = await getSettings(tx);
    const now = new Date();
    const date = istDate(now);
    const fy = fyStartYear(now);
    const { seq, number } = await nextDocNumber(tx, 'credit_note', settings.creditNotePrefix, fy);
    const [{ id }] = (await tx<{ id: number }[]>`select nextval('credit_notes_id_seq')::bigint as id`) as unknown as [{ id: number }];
    const L = await systemLedgerIds(tx);
    let refundLedger: number;
    if (input.refundMode === 'account') {
      const [c] = await tx<{ ledger_id: number }[]>`select ledger_id from customers where id = ${inv.customer_id}`;
      refundLedger = c!.ledger_id;
    } else refundLedger = L[input.refundMode];

    const voucherId = await postVoucher(tx, ctx, {
      vtype: 'credit_note',
      vdate: date,
      narration: `Sales return ${number} against bill ${inv.number}${inv.customer_name ? ' — ' + inv.customer_name : ''}: ${reason}`,
      refType: 'credit_note',
      refId: id,
      lines: [
        { ledgerId: L.sales_returns, amountPaise: taxable },
        { ledgerId: L.output_cgst, amountPaise: cgst },
        { ledgerId: L.output_sgst, amountPaise: sgst },
        { ledgerId: L.output_igst, amountPaise: igst },
        { ledgerId: L.round_off, amountPaise: roundOff },
        { ledgerId: refundLedger, amountPaise: -total },
      ],
    });

    await tx`
      insert into credit_notes (id, number, fy_start, seq, note_date, invoice_id, customer_id, reason, refund_mode, supply_type,
        taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, voucher_id, approved_by, user_id, device_id, client_ref)
      values (${id}, ${number}, ${fy}, ${seq}, ${date}, ${invoiceId}, ${inv.customer_id}, ${reason}, ${input.refundMode}, ${inv.supply_type},
        ${taxable}, ${cgst}, ${sgst}, ${igst}, ${roundOff}, ${total}, ${voucherId}, ${approvedBy}, ${ctx.userId}, ${ctx.deviceId}, ${input.clientRef ?? null})`;
    await tx`insert into credit_note_lines ${tx(
      rows.map((x, i) => ({
        credit_note_id: id,
        line_no: i + 1,
        invoice_line_id: x.l.id,
        product_id: x.l.product_id,
        qty_milli: x.r.qtyMilli,
        base_qty_milli: x.base,
        restocked: x.r.restock,
        taxable_paise: x.taxable,
        gst_rate_bp: x.l.gst_rate_bp,
        cgst_paise: x.cgst,
        sgst_paise: x.sgst,
        igst_paise: x.igst,
        total_paise: x.total,
      })),
    )}`;

    // Goods come back into stock; damaged goods are then written off with a reason, so the trail is complete.
    const moves = [];
    for (const x of rows) {
      moves.push({ product_id: x.l.product_id, qty_milli: x.base, kind: 'sale_return', ref_type: 'credit_note', ref_id: id, unit_cost_paise: x.l.cost_price_paise, reason, user_id: ctx.userId, device_id: ctx.deviceId });
      if (!x.r.restock)
        moves.push({ product_id: x.l.product_id, qty_milli: -x.base, kind: 'adjustment', ref_type: 'credit_note', ref_id: id, unit_cost_paise: x.l.cost_price_paise, reason: `Returned damaged, not resaleable (${number})`, user_id: ctx.userId, device_id: ctx.deviceId });
    }
    await lockProducts(tx, rows.map((x) => x.l.product_id));
    await tx`insert into stock_movements ${tx(moves)}`;
    await reverseRewardsOnReturn(tx, ctx, invoiceId, id, number, rows.map((x) => ({ invoiceLineId: x.l.id, baseQtyMilli: x.base, lineBaseQtyMilli: x.l.base_qty_milli })));

    await audit(tx, ctx, 'credit_note.created', {
      entity: 'credit_note',
      entityId: id,
      details: { number, invoice: inv.number, totalPaise: total, refundMode: input.refundMode, items: rows.length, damaged: rows.filter((x) => !x.r.restock).length },
      reason,
      approvedBy,
    });
    return { id, number, totalPaise: total };
  });
}

export async function listCreditNotes(q: Q, f: { from?: string; to?: string }) {
  return q`
    select cn.id, cn.number, cn.note_date, cn.at, cn.total_paise, cn.refund_mode, cn.reason, cn.status, si.number as invoice_number, si.id as invoice_id,
           coalesce(c.name, si.customer_name) as customer_name, u.name as user_name, d.name as device_name
    from credit_notes cn join sales_invoices si on si.id = cn.invoice_id left join customers c on c.id = cn.customer_id
    join users u on u.id = cn.user_id left join devices d on d.id = cn.device_id
    where (${f.from ?? null}::date is null or cn.note_date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or cn.note_date <= ${f.to ?? null}::date)
    order by cn.id desc limit 500`;
}

export async function getCreditNote(q: Q, id: number) {
  const [cn] = await q`
    select cn.*, si.number as invoice_number, si.invoice_date, si.customer_name, si.customer_phone, si.customer_gstin, si.customer_address,
           si.place_of_supply, u.name as user_name, d.name as device_name, ap.name as approved_by_name
    from credit_notes cn join sales_invoices si on si.id = cn.invoice_id join users u on u.id = cn.user_id
    left join devices d on d.id = cn.device_id left join users ap on ap.id = cn.approved_by
    where cn.id = ${id}`;
  if (!cn) throw new AppError(404, 'NOT_FOUND', 'Credit note not found');
  const lines = await q`
    select cl.*, l.product_name, l.sku, l.hsn, l.unit_code, l.rate_paise, l.rate_mode
    from credit_note_lines cl join sales_invoice_lines l on l.id = cl.invoice_line_id where cl.credit_note_id = ${id} order by cl.line_no`;
  return { ...cn, lines };
}

// ================================================================== purchase returns

export interface DebitNoteInput {
  clientRef?: string;
  reason: string;
  lines: { purchaseLineId: number; baseQtyMilli: number }[];
}

export async function createDebitNote(sql: Sql, ctx: Ctx, purchaseId: number, input: DebitNoteInput) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can return goods to suppliers');
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason for the return');
  if (!input.lines.length) throw new AppError(400, 'NO_LINES', 'Choose what is going back');
  return sql.begin(async (tx) => {
    if (input.clientRef) {
      const [e] = await tx<{ id: number; number: string }[]>`select id, number from debit_notes where client_ref = ${input.clientRef}`;
      if (e) return e;
    }
    const [pu] = await tx<{ id: number; number: string; status: string; supplier_id: number; supplier_invoice_no: string; supply_type: 'intra' | 'inter' }[]>`
      select id, number, status, supplier_id, supplier_invoice_no, supply_type from purchase_invoices where id = ${purchaseId} for update`;
    if (!pu) throw new AppError(404, 'NOT_FOUND', 'Purchase not found');
    if (pu.status !== 'posted') throw new AppError(409, 'NOT_POSTED', `${pu.number} is cancelled`);
    const lines = await tx<{ id: number; product_id: number; product_name: string; unit_code: string; qty_milli: number; unit_cost_paise: number; taxable_paise: number; gst_rate_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number; ret_base: number; ret_taxable: number; ret_cgst: number; ret_sgst: number; ret_igst: number }[]>`
      select l.id, l.product_id, p.name as product_name, l.unit_code, l.qty_milli, l.unit_cost_paise, l.taxable_paise, l.gst_rate_bp,
             l.cgst_paise, l.sgst_paise, l.igst_paise,
             coalesce(sum(dl.base_qty_milli), 0) as ret_base, coalesce(sum(dl.taxable_paise), 0) as ret_taxable,
             coalesce(sum(dl.cgst_paise), 0) as ret_cgst, coalesce(sum(dl.sgst_paise), 0) as ret_sgst, coalesce(sum(dl.igst_paise), 0) as ret_igst
      from purchase_lines l join products p on p.id = l.product_id
      left join debit_note_lines dl on dl.purchase_line_id = l.id and exists (select 1 from debit_notes dn where dn.id = dl.debit_note_id and dn.status = 'posted')
      where l.purchase_id = ${purchaseId} group by l.id, p.name order by l.line_no`;
    const byId = new Map(lines.map((l) => [l.id, l]));
    const rows = input.lines.map((r, i) => {
      const l = byId.get(r.purchaseLineId);
      if (!l) throw new AppError(400, 'BAD_LINE', `Line ${i + 1} is not on ${pu.number}`);
      const left = l.qty_milli - l.ret_base;
      if (!Number.isSafeInteger(r.baseQtyMilli) || r.baseQtyMilli <= 0) throw new AppError(400, 'BAD_QTY', `${l.product_name}: enter the quantity going back`);
      if (r.baseQtyMilli > left) throw new AppError(400, 'TOO_MUCH', `${l.product_name}: only ${left / 1000} ${l.unit_code} can still be returned from this purchase`);
      const last = r.baseQtyMilli === left;
      const taxable = last ? l.taxable_paise - l.ret_taxable : mulDivRound(l.taxable_paise, r.baseQtyMilli, l.qty_milli);
      const t = last ? { cgst: l.cgst_paise - l.ret_cgst, sgst: l.sgst_paise - l.ret_sgst, igst: l.igst_paise - l.ret_igst } : taxes(taxable, l.gst_rate_bp, pu.supply_type);
      return { r, l, taxable, ...t, total: taxable + t.cgst + t.sgst + t.igst };
    });

    // The goods must still be here to send back.
    await lockProducts(tx, rows.map((x) => x.l.product_id));
    const settings = await getSettings(tx);
    if (!settings.allowNegativeStock) {
      const bal = await tx<{ product_id: number; qty_milli: number }[]>`select product_id, qty_milli from stock_balances where product_id in ${tx(rows.map((x) => x.l.product_id))}`;
      const have = new Map(bal.map((b) => [b.product_id, b.qty_milli]));
      for (const x of rows) if ((have.get(x.l.product_id) ?? 0) < x.r.baseQtyMilli) throw new AppError(409, 'INSUFFICIENT_STOCK', `${x.l.product_name}: only ${(have.get(x.l.product_id) ?? 0) / 1000} ${x.l.unit_code} in stock to send back`);
    }

    const taxable = rows.reduce((s, x) => s + x.taxable, 0);
    const cgst = rows.reduce((s, x) => s + x.cgst, 0);
    const sgst = rows.reduce((s, x) => s + x.sgst, 0);
    const igst = rows.reduce((s, x) => s + x.igst, 0);
    const total = taxable + cgst + sgst + igst;
    const now = new Date();
    const date = istDate(now);
    const fy = fyStartYear(now);
    const { seq, number } = await nextDocNumber(tx, 'debit_note', settings.debitNotePrefix, fy);
    const [{ id }] = (await tx<{ id: number }[]>`select nextval('debit_notes_id_seq')::bigint as id`) as unknown as [{ id: number }];
    const [sup] = await tx<{ ledger_id: number; name: string }[]>`select ledger_id, name from suppliers where id = ${pu.supplier_id}`;
    const L = await systemLedgerIds(tx);
    const voucherId = await postVoucher(tx, ctx, {
      vtype: 'debit_note',
      vdate: date,
      narration: `Purchase return ${number} to ${sup!.name} against bill ${pu.supplier_invoice_no}: ${reason}`,
      refType: 'debit_note',
      refId: id,
      lines: [
        { ledgerId: sup!.ledger_id, amountPaise: total },
        { ledgerId: L.purchase_returns, amountPaise: -taxable },
        { ledgerId: L.input_cgst, amountPaise: -cgst },
        { ledgerId: L.input_sgst, amountPaise: -sgst },
        { ledgerId: L.input_igst, amountPaise: -igst },
      ],
    });
    await tx`
      insert into debit_notes (id, number, fy_start, seq, note_date, purchase_id, supplier_id, reason, supply_type, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, voucher_id, user_id, device_id, client_ref)
      values (${id}, ${number}, ${fy}, ${seq}, ${date}, ${purchaseId}, ${pu.supplier_id}, ${reason}, ${pu.supply_type}, ${taxable}, ${cgst}, ${sgst}, ${igst}, ${total}, ${voucherId}, ${ctx.userId}, ${ctx.deviceId}, ${input.clientRef ?? null})`;
    await tx`insert into debit_note_lines ${tx(
      rows.map((x, i) => ({ debit_note_id: id, line_no: i + 1, purchase_line_id: x.l.id, product_id: x.l.product_id, base_qty_milli: x.r.baseQtyMilli, taxable_paise: x.taxable, gst_rate_bp: x.l.gst_rate_bp, cgst_paise: x.cgst, sgst_paise: x.sgst, igst_paise: x.igst, total_paise: x.total })),
    )}`;
    await tx`insert into stock_movements ${tx(
      rows.map((x) => ({ product_id: x.l.product_id, qty_milli: -x.r.baseQtyMilli, kind: 'purchase_return', ref_type: 'debit_note', ref_id: id, unit_cost_paise: x.l.unit_cost_paise, reason, user_id: ctx.userId, device_id: ctx.deviceId })),
    )}`;
    await audit(tx, ctx, 'debit_note.created', { entity: 'debit_note', entityId: id, details: { number, purchase: pu.number, supplier: sup!.name, totalPaise: total, items: rows.length }, reason });
    return { id, number, totalPaise: total };
  });
}

export async function listDebitNotes(q: Q, f: { from?: string; to?: string }) {
  return q`
    select dn.id, dn.number, dn.note_date, dn.at, dn.total_paise, dn.reason, dn.status, p.number as purchase_number, p.id as purchase_id,
           p.supplier_invoice_no, s.name as supplier_name, u.name as user_name
    from debit_notes dn join purchase_invoices p on p.id = dn.purchase_id join suppliers s on s.id = dn.supplier_id join users u on u.id = dn.user_id
    where (${f.from ?? null}::date is null or dn.note_date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or dn.note_date <= ${f.to ?? null}::date)
    order by dn.id desc limit 500`;
}

export async function getDebitNote(q: Q, id: number) {
  const [dn] = await q`
    select dn.*, p.number as purchase_number, p.supplier_invoice_no, p.supplier_invoice_date, s.name as supplier_name, s.gstin as supplier_gstin, s.address as supplier_address, u.name as user_name
    from debit_notes dn join purchase_invoices p on p.id = dn.purchase_id join suppliers s on s.id = dn.supplier_id join users u on u.id = dn.user_id
    where dn.id = ${id}`;
  if (!dn) throw new AppError(404, 'NOT_FOUND', 'Debit note not found');
  const lines = await q`
    select dl.*, pr.name as product_name, pr.sku, l.hsn, l.unit_code, l.unit_cost_paise
    from debit_note_lines dl join purchase_lines l on l.id = dl.purchase_line_id join products pr on pr.id = dl.product_id
    where dl.debit_note_id = ${id} order by dl.line_no`;
  return { ...dn, lines };
}

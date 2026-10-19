import { gstDate, gstr1Section, stateName, uqcFor, type Gstr1Section } from '@kph/core';
import type { Q } from '../db/connect.js';
import { AppError, requirePerm, type Ctx } from './common.js';

/**
 * Registers, GST return figures and the discount report. All read-only, all from the
 * saved bills — never from the ledgers' running balances — so a CA can tie every
 * figure back to a bill number.
 */

export interface Range {
  from: string;
  to: string;
}

function checkRange(r: Range) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to) || r.from > r.to) throw new AppError(400, 'BAD_RANGE', 'Choose a valid date range');
  const days = (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000;
  if (days > 400) throw new AppError(400, 'BAD_RANGE', 'At most one year at a time');
}

const pos = (code: string) => `${code}-${stateName(code)}`;
const rate = (bp: number) => bp / 100;

// ------------------------------------------------------------------ registers

export async function salesRegister(q: Q, ctx: Ctx, r: Range) {
  requirePerm(ctx, 'reports.view');
  checkRange(r);
  const invoices = await q<
    {
      id: number; number: string; invoice_date: string; customer_name: string | null; customer_gstin: string | null; place_of_supply: string; supply_type: string;
      payment_mode: string; gross_paise: number; discount_paise: number; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number;
      round_off_paise: number; total_paise: number; status: string; user_name: string; ewb_no: string | null;
    }[]
  >`
    select si.id, si.number, si.invoice_date, si.customer_name, si.customer_gstin, si.place_of_supply, si.supply_type, si.payment_mode,
           si.gross_paise, si.discount_paise, si.taxable_paise, si.cgst_paise, si.sgst_paise, si.igst_paise, si.round_off_paise, si.total_paise,
           si.status, u.name as user_name, t.ewb_no
    from sales_invoices si join users u on u.id = si.user_id left join invoice_transport t on t.invoice_id = si.id
    where si.invoice_date between ${r.from} and ${r.to}
    order by si.fy_start, si.seq`;
  const creditNotes = await q<
    { id: number; number: string; note_date: string; invoice_number: string; customer_name: string | null; customer_gstin: string | null; reason: string; refund_mode: string; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; round_off_paise: number; total_paise: number; status: string }[]
  >`
    select cn.id, cn.number, cn.note_date, si.number as invoice_number, si.customer_name, si.customer_gstin, cn.reason, cn.refund_mode,
           cn.taxable_paise, cn.cgst_paise, cn.sgst_paise, cn.igst_paise, cn.round_off_paise, cn.total_paise, cn.status
    from credit_notes cn join sales_invoices si on si.id = cn.invoice_id
    where cn.note_date between ${r.from} and ${r.to}
    order by cn.fy_start, cn.seq`;
  const sum = <T extends { status: string }>(rows: T[], k: keyof T) => rows.filter((x) => x.status === 'posted').reduce((s, x) => s + Number(x[k]), 0);
  return {
    ...r,
    invoices,
    creditNotes,
    totals: {
      bills: invoices.filter((x) => x.status === 'posted').length,
      cancelled: invoices.filter((x) => x.status === 'cancelled').length,
      taxable: sum(invoices, 'taxable_paise'),
      cgst: sum(invoices, 'cgst_paise'),
      sgst: sum(invoices, 'sgst_paise'),
      igst: sum(invoices, 'igst_paise'),
      roundOff: sum(invoices, 'round_off_paise'),
      total: sum(invoices, 'total_paise'),
      discount: sum(invoices, 'discount_paise'),
      returnsTotal: sum(creditNotes, 'total_paise'),
      returnsTaxable: sum(creditNotes, 'taxable_paise'),
    },
  };
}

export async function purchaseRegister(q: Q, ctx: Ctx, r: Range) {
  requirePerm(ctx, 'reports.view');
  checkRange(r);
  const purchases = await q<
    { id: number; number: string; supplier_invoice_no: string; supplier_invoice_date: string; entered_on: string; supplier_name: string; supplier_gstin: string | null; supply_type: string; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; freight_paise: number; round_off_paise: number; total_paise: number; status: string }[]
  >`
    select p.id, p.number, p.supplier_invoice_no, p.supplier_invoice_date, (p.at at time zone 'Asia/Kolkata')::date::text as entered_on,
           s.name as supplier_name, s.gstin as supplier_gstin, p.supply_type, p.taxable_paise, p.cgst_paise, p.sgst_paise, p.igst_paise,
           p.freight_paise, p.round_off_paise, p.total_paise, p.status
    from purchase_invoices p join suppliers s on s.id = p.supplier_id
    where p.supplier_invoice_date between ${r.from} and ${r.to}
    order by p.supplier_invoice_date, p.id`;
  const debitNotes = await q<
    { id: number; number: string; note_date: string; purchase_number: string; supplier_invoice_no: string; supplier_name: string; supplier_gstin: string | null; reason: string; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; status: string }[]
  >`
    select d.id, d.number, d.note_date, p.number as purchase_number, p.supplier_invoice_no, s.name as supplier_name, s.gstin as supplier_gstin, d.reason,
           d.taxable_paise, d.cgst_paise, d.sgst_paise, d.igst_paise, d.total_paise, d.status
    from debit_notes d join purchase_invoices p on p.id = d.purchase_id join suppliers s on s.id = d.supplier_id
    where d.note_date between ${r.from} and ${r.to}
    order by d.fy_start, d.seq`;
  const sum = <T extends { status: string }>(rows: T[], k: keyof T) => rows.filter((x) => x.status === 'posted').reduce((s, x) => s + Number(x[k]), 0);
  return {
    ...r,
    purchases,
    debitNotes,
    totals: {
      bills: purchases.filter((x) => x.status === 'posted').length,
      taxable: sum(purchases, 'taxable_paise'),
      cgst: sum(purchases, 'cgst_paise'),
      sgst: sum(purchases, 'sgst_paise'),
      igst: sum(purchases, 'igst_paise'),
      freight: sum(purchases, 'freight_paise'),
      total: sum(purchases, 'total_paise'),
      returnsTotal: sum(debitNotes, 'total_paise'),
    },
  };
}

// ------------------------------------------------------------------ GSTR-1

interface RateRow {
  rateBp: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface Gstr1 {
  from: string;
  to: string;
  b2b: { gstin: string; name: string; number: string; date: string; value: number; pos: string; rate: number; taxable: number; igst: number; cgst: number; sgst: number }[];
  b2cl: { number: string; date: string; value: number; pos: string; rate: number; taxable: number; igst: number }[];
  b2cs: { pos: string; rate: number; taxable: number; igst: number; cgst: number; sgst: number }[];
  cdnr: { gstin: string; name: string; number: string; date: string; value: number; pos: string; rate: number; taxable: number; igst: number; cgst: number; sgst: number; invoiceNumber: string }[];
  cdnur: { number: string; date: string; value: number; pos: string; rate: number; taxable: number; igst: number; invoiceNumber: string }[];
  hsnB2b: HsnRow[];
  hsnB2c: HsnRow[];
  docs: { nature: string; from: string; to: string; total: number; cancelled: number }[];
  summary: Record<'b2b' | 'b2cl' | 'b2cs' | 'cdnr' | 'cdnur', { count: number; taxable: number; tax: number }>;
  warnings: string[];
}

export interface HsnRow {
  hsn: string;
  description: string;
  uqc: string;
  qty: number;
  value: number;
  rate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}

/**
 * GSTR-1 figures for a period. Money is in paise; quantities in milli-units.
 * Credit notes for registered buyers go to CDNR, for large inter-state B2C bills to CDNUR,
 * and all others reduce B2CS in the month the note is issued.
 */
export async function gstr1(q: Q, ctx: Ctx, r: Range): Promise<Gstr1> {
  requirePerm(ctx, 'reports.view');
  checkRange(r);
  const warnings: string[] = [];

  const invs = await q<{ id: number; number: string; invoice_date: string; customer_name: string | null; customer_gstin: string | null; supply_type: 'intra' | 'inter'; place_of_supply: string; total_paise: number }[]>`
    select id, number, invoice_date, customer_name, customer_gstin, supply_type, place_of_supply, total_paise
    from sales_invoices where status = 'posted' and invoice_date between ${r.from} and ${r.to} order by fy_start, seq`;
  const invRates = await q<(RateRow & { invoice_id: number })[]>`
    select l.invoice_id, l.gst_rate_bp as "rateBp", sum(l.taxable_paise) as taxable, sum(l.cgst_paise) as cgst, sum(l.sgst_paise) as sgst, sum(l.igst_paise) as igst
    from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id
    where si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}
    group by l.invoice_id, l.gst_rate_bp order by l.invoice_id, l.gst_rate_bp`;
  const ratesOf = groupBy(invRates, (x) => x.invoice_id);

  const cns = await q<{ id: number; number: string; note_date: string; total_paise: number; invoice_number: string; customer_name: string | null; customer_gstin: string | null; supply_type: 'intra' | 'inter'; place_of_supply: string; invoice_total: number }[]>`
    select cn.id, cn.number, cn.note_date, cn.total_paise, si.number as invoice_number, si.customer_name, si.customer_gstin, si.supply_type, si.place_of_supply, si.total_paise as invoice_total
    from credit_notes cn join sales_invoices si on si.id = cn.invoice_id
    where cn.status = 'posted' and cn.note_date between ${r.from} and ${r.to} order by cn.fy_start, cn.seq`;
  const cnRates = await q<(RateRow & { credit_note_id: number })[]>`
    select l.credit_note_id, l.gst_rate_bp as "rateBp", sum(l.taxable_paise) as taxable, sum(l.cgst_paise) as cgst, sum(l.sgst_paise) as sgst, sum(l.igst_paise) as igst
    from credit_note_lines l join credit_notes cn on cn.id = l.credit_note_id
    where cn.status = 'posted' and cn.note_date between ${r.from} and ${r.to}
    group by l.credit_note_id, l.gst_rate_bp order by l.credit_note_id, l.gst_rate_bp`;
  const cnRatesOf = groupBy(cnRates, (x) => x.credit_note_id);

  const out: Gstr1 = { ...r, b2b: [], b2cl: [], b2cs: [], cdnr: [], cdnur: [], hsnB2b: [], hsnB2c: [], docs: [], summary: {} as Gstr1['summary'], warnings };
  const b2cs = new Map<string, Gstr1['b2cs'][number]>();
  const addB2cs = (p: string, x: RateRow, sign: 1 | -1) => {
    const key = `${p}|${x.rateBp}`;
    const row = b2cs.get(key) ?? { pos: pos(p), rate: rate(x.rateBp), taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    row.taxable += sign * x.taxable;
    row.igst += sign * x.igst;
    row.cgst += sign * x.cgst;
    row.sgst += sign * x.sgst;
    b2cs.set(key, row);
  };
  const summary = { b2b: new Set<number>(), b2cl: new Set<number>(), b2cs: new Set<number>(), cdnr: new Set<number>(), cdnur: new Set<number>() };
  const sumTaxable: Record<keyof typeof summary, number> = { b2b: 0, b2cl: 0, b2cs: 0, cdnr: 0, cdnur: 0 };
  const sumTax: Record<keyof typeof summary, number> = { b2b: 0, b2cl: 0, b2cs: 0, cdnr: 0, cdnur: 0 };
  const tally = (s: keyof typeof summary, id: number, x: RateRow, sign = 1) => {
    if (sign > 0) summary[s].add(id);
    sumTaxable[s] += sign * x.taxable;
    sumTax[s] += sign * (x.cgst + x.sgst + x.igst);
  };

  for (const inv of invs) {
    const section: Gstr1Section = gstr1Section({ customerGstin: inv.customer_gstin, supplyType: inv.supply_type, totalPaise: inv.total_paise });
    for (const x of ratesOf.get(inv.id) ?? []) {
      tally(section, inv.id, x);
      if (section === 'b2b') {
        out.b2b.push({ gstin: inv.customer_gstin!, name: inv.customer_name ?? '', number: inv.number, date: inv.invoice_date, value: inv.total_paise, pos: pos(inv.place_of_supply), rate: rate(x.rateBp), taxable: x.taxable, igst: x.igst, cgst: x.cgst, sgst: x.sgst });
      } else if (section === 'b2cl') {
        out.b2cl.push({ number: inv.number, date: inv.invoice_date, value: inv.total_paise, pos: pos(inv.place_of_supply), rate: rate(x.rateBp), taxable: x.taxable, igst: x.igst });
      } else addB2cs(inv.place_of_supply, x, 1);
    }
  }
  for (const cn of cns) {
    const section = gstr1Section({ customerGstin: cn.customer_gstin, supplyType: cn.supply_type, totalPaise: cn.invoice_total });
    for (const x of cnRatesOf.get(cn.id) ?? []) {
      if (section === 'b2b') {
        tally('cdnr', cn.id, x);
        out.cdnr.push({ gstin: cn.customer_gstin!, name: cn.customer_name ?? '', number: cn.number, date: cn.note_date, value: cn.total_paise, pos: pos(cn.place_of_supply), rate: rate(x.rateBp), taxable: x.taxable, igst: x.igst, cgst: x.cgst, sgst: x.sgst, invoiceNumber: cn.invoice_number });
      } else if (section === 'b2cl') {
        tally('cdnur', cn.id, x);
        out.cdnur.push({ number: cn.number, date: cn.note_date, value: cn.total_paise, pos: pos(cn.place_of_supply), rate: rate(x.rateBp), taxable: x.taxable, igst: x.igst, invoiceNumber: cn.invoice_number });
      } else {
        tally('b2cs', cn.id, x, -1);
        addB2cs(cn.place_of_supply, x, -1);
      }
    }
  }
  out.b2cs = [...b2cs.values()].filter((x) => x.taxable !== 0 || x.igst !== 0 || x.cgst !== 0).sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate);
  for (const x of out.b2cs) if (x.taxable < 0) warnings.push(`B2CS ${x.pos} at ${x.rate}% is negative (returns more than sales this period) — ask the CA how to report it.`);
  out.summary = Object.fromEntries((Object.keys(summary) as (keyof typeof summary)[]).map((k) => [k, { count: summary[k].size, taxable: sumTaxable[k], tax: sumTax[k] }])) as Gstr1['summary'];

  // HSN summary (table 12), split B2B / B2C; returns reduce it.
  const hsnRows = await q<{ hsn: string | null; unit_code: string; rate_bp: number; b2b: boolean; qty: number; taxable: number; cgst: number; sgst: number; igst: number; name: string; sign: number }[]>`
    select l.hsn, p.unit_code, l.gst_rate_bp as rate_bp, coalesce(si.customer_gstin, '') <> '' as b2b, sum(l.base_qty_milli) as qty, sum(l.taxable_paise) as taxable,
           sum(l.cgst_paise) as cgst, sum(l.sgst_paise) as sgst, sum(l.igst_paise) as igst, min(l.product_name) as name, 1 as sign
    from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id join products p on p.id = l.product_id
    where si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}
    group by 1, 2, 3, 4
    union all
    select il.hsn, p.unit_code, l.gst_rate_bp, coalesce(si.customer_gstin, '') <> '', sum(l.base_qty_milli), sum(l.taxable_paise),
           sum(l.cgst_paise), sum(l.sgst_paise), sum(l.igst_paise), min(il.product_name), -1
    from credit_note_lines l join credit_notes cn on cn.id = l.credit_note_id join sales_invoice_lines il on il.id = l.invoice_line_id
         join sales_invoices si on si.id = cn.invoice_id join products p on p.id = l.product_id
    where cn.status = 'posted' and cn.note_date between ${r.from} and ${r.to}
    group by 1, 2, 3, 4`;
  const hsn = { b2b: new Map<string, HsnRow>(), b2c: new Map<string, HsnRow>() };
  let missingHsn = 0;
  for (const h of hsnRows) {
    const code = (h.hsn ?? '').replace(/\s/g, '');
    if (!code) missingHsn++;
    const uqc = uqcFor(h.unit_code);
    const key = `${code}|${uqc}|${h.rate_bp}`;
    const m = h.b2b ? hsn.b2b : hsn.b2c;
    const row = m.get(key) ?? { hsn: code, description: h.name, uqc, qty: 0, value: 0, rate: rate(h.rate_bp), taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    const s = h.sign;
    row.qty += s * h.qty;
    row.taxable += s * h.taxable;
    row.igst += s * h.igst;
    row.cgst += s * h.cgst;
    row.sgst += s * h.sgst;
    row.value = row.taxable + row.igst + row.cgst + row.sgst;
    m.set(key, row);
  }
  const sortHsn = (m: Map<string, HsnRow>) => [...m.values()].filter((x) => x.qty !== 0 || x.taxable !== 0).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
  out.hsnB2b = sortHsn(hsn.b2b);
  out.hsnB2c = sortHsn(hsn.b2c);
  if (missingHsn) warnings.push('Some items were sold without an HSN code. Add HSN codes in Inventory — GSTR-1 needs them (at least 4 digits).');
  for (const x of [...out.hsnB2b, ...out.hsnB2c]) if (x.hsn && x.hsn.length < 4) warnings.push(`HSN "${x.hsn}" is shorter than 4 digits.`);
  if (out.b2b.some((x) => !/^\d{2}[A-Z0-9]{13}$/.test(x.gstin))) warnings.push('A B2B bill has a GSTIN that does not look right.');

  // Documents issued (table 13): by number series.
  const docRows = await q<{ nature: string; first: string; last: string; total: number; cancelled: number }[]>`
    select 'Invoices for outward supply' as nature, (array_agg(number order by seq))[1] as first, (array_agg(number order by seq desc))[1] as last,
           (max(seq) - min(seq) + 1)::int as total, count(*) filter (where status = 'cancelled')::int as cancelled
    from sales_invoices where invoice_date between ${r.from} and ${r.to} group by fy_start
    union all
    select 'Credit Note', (array_agg(number order by seq))[1], (array_agg(number order by seq desc))[1],
           (max(seq) - min(seq) + 1)::int, count(*) filter (where status = 'cancelled')::int
    from credit_notes where note_date between ${r.from} and ${r.to} group by fy_start`;
  out.docs = docRows.map((d) => ({ nature: d.nature, from: d.first, to: d.last, total: d.total, cancelled: d.cancelled }));
  return out;
}

function groupBy<T, K>(rows: T[], key: (r: T) => K) {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

// ------------------------------------------------------------------ GSTR-3B

export async function gstr3b(q: Q, ctx: Ctx, r: Range) {
  requirePerm(ctx, 'reports.view');
  checkRange(r);
  const [sales] = await q<{ taxable: number; igst: number; cgst: number; sgst: number }[]>`
    select coalesce(sum(taxable_paise), 0) as taxable, coalesce(sum(igst_paise), 0) as igst, coalesce(sum(cgst_paise), 0) as cgst, coalesce(sum(sgst_paise), 0) as sgst
    from sales_invoices where status = 'posted' and invoice_date between ${r.from} and ${r.to}`;
  const [returns] = await q<{ taxable: number; igst: number; cgst: number; sgst: number }[]>`
    select coalesce(sum(taxable_paise), 0) as taxable, coalesce(sum(igst_paise), 0) as igst, coalesce(sum(cgst_paise), 0) as cgst, coalesce(sum(sgst_paise), 0) as sgst
    from credit_notes where status = 'posted' and note_date between ${r.from} and ${r.to}`;
  // 3.2: inter-state supplies to unregistered persons, by place of supply (net of returns)
  const interUnreg = await q<{ pos: string; taxable: number; igst: number }[]>`
    select pos, sum(taxable) as taxable, sum(igst) as igst from (
      select place_of_supply as pos, taxable_paise as taxable, igst_paise as igst from sales_invoices
      where status = 'posted' and supply_type = 'inter' and coalesce(customer_gstin, '') = '' and invoice_date between ${r.from} and ${r.to}
      union all
      select si.place_of_supply, -cn.taxable_paise, -cn.igst_paise from credit_notes cn join sales_invoices si on si.id = cn.invoice_id
      where cn.status = 'posted' and si.supply_type = 'inter' and coalesce(si.customer_gstin, '') = '' and cn.note_date between ${r.from} and ${r.to}
    ) x group by pos order by pos`;
  const [itc] = await q<{ igst: number; cgst: number; sgst: number; bills: number }[]>`
    select coalesce(sum(igst_paise), 0) as igst, coalesce(sum(cgst_paise), 0) as cgst, coalesce(sum(sgst_paise), 0) as sgst, count(*)::int as bills
    from purchase_invoices where status = 'posted' and supplier_invoice_date between ${r.from} and ${r.to}`;
  const [itcRev] = await q<{ igst: number; cgst: number; sgst: number }[]>`
    select coalesce(sum(igst_paise), 0) as igst, coalesce(sum(cgst_paise), 0) as cgst, coalesce(sum(sgst_paise), 0) as sgst
    from debit_notes where status = 'posted' and note_date between ${r.from} and ${r.to}`;
  const net = (a: { igst: number; cgst: number; sgst: number }, b: { igst: number; cgst: number; sgst: number }) => ({ igst: a.igst - b.igst, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst });
  const outward = { taxable: sales!.taxable - returns!.taxable, ...net(sales!, returns!) };
  const itcNet = net(itc!, itcRev!);
  return {
    ...r,
    outward,
    outwardDetail: { sales: sales!, returns: returns! },
    interStateUnregistered: interUnreg.filter((x) => x.taxable !== 0).map((x) => ({ pos: pos(x.pos), taxable: x.taxable, igst: x.igst })),
    itc: { purchases: itc!, purchaseReturns: itcRev!, net: itcNet },
    /** Tax still to pay in cash if all ITC is usable — a rough guide only; the portal applies the set-off order. */
    roughPayable: Math.max(0, outward.igst + outward.cgst + outward.sgst - (itcNet.igst + itcNet.cgst + itcNet.sgst)),
    notes: [
      'Input tax credit is from purchase bills entered here (by supplier bill date). Claim only what appears in your GSTR-2B — the CA should match them.',
      'Purchases from unregistered dealers, exempt / nil-rated supplies and reverse-charge items are not tracked yet.',
    ],
  };
}

// ------------------------------------------------------------------ discounts

export async function discountReport(q: Q, ctx: Ctx, r: Range) {
  requirePerm(ctx, 'reports.view');
  checkRange(r);
  const byStaff = await q<{ user_id: number; name: string; bills: number; gross: number; discount: number; over_limit_lines: number; over_limit_discount: number }[]>`
    select u.id as user_id, u.name, count(distinct si.id)::int as bills, sum(l.gross_paise) as gross, sum(l.discount_paise) as discount,
           count(*) filter (where l.override_id is not null)::int as over_limit_lines,
           coalesce(sum(l.discount_paise) filter (where l.override_id is not null), 0) as over_limit_discount
    from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id join users u on u.id = si.user_id
    where si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}
    group by u.id, u.name order by discount desc`;
  const byProduct = await q<{ product_id: number; name: string; unit_code: string; qty: number; gross: number; discount: number; lines: number; discounted_lines: number; max_bp: number; over_limit_lines: number }[]>`
    select l.product_id, min(l.product_name) as name, p.unit_code, sum(l.base_qty_milli) as qty, sum(l.gross_paise) as gross, sum(l.discount_paise) as discount,
           count(*)::int as lines, count(*) filter (where l.discount_paise > 0)::int as discounted_lines, max(l.discount_bp) as max_bp,
           count(*) filter (where l.override_id is not null)::int as over_limit_lines
    from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id join products p on p.id = l.product_id
    where si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}
    group by l.product_id, p.unit_code having sum(l.discount_paise) > 0 order by discount desc limit 500`;
  const overLimit = await q<{ invoice_id: number; number: string; invoice_date: string; product_name: string; discount_bp: number; max_discount_bp: number; discount_paise: number; staff: string; approved_by: string; reason: string | null }[]>`
    select si.id as invoice_id, si.number, si.invoice_date, l.product_name, l.discount_bp, l.max_discount_bp, l.discount_paise, u.name as staff, a.name as approved_by, o.reason
    from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id join users u on u.id = si.user_id
         join overrides o on o.id = l.override_id join users a on a.id = o.approved_by
    where si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}
    order by si.id desc limit 500`;
  const gross = byStaff.reduce((s, x) => s + x.gross, 0);
  const discount = byStaff.reduce((s, x) => s + x.discount, 0);
  return { ...r, byStaff, byProduct, overLimit, totals: { gross, discount, overLimitLines: overLimit.length } };
}

export { gstDate };

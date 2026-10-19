import ExcelJS from 'exceljs';
import { gstDate } from '@kph/core';
import type { Gstr1, Range } from './reports.js';
import type { discountReport, gstr3b, purchaseRegister, salesRegister } from './reports.js';

/**
 * Excel files for the CA. Money is written as rupees (numbers, 2 decimals) so Excel can add them up.
 * The GSTR-1 workbook follows the sheet names and column headings of the GST offline tool's Excel
 * template, with the headings on row 4 and a summary on rows 1–3, so it can be imported or copied in.
 */

type Kind = 'text' | 'money' | 'qty' | 'int' | 'rate' | 'date' | 'gstdate';
interface Col {
  header: string;
  kind?: Kind;
  width?: number;
}
interface Sheet {
  name: string;
  columns: Col[];
  rows: unknown[][];
  /** Title line(s) above the headings (registers). */
  title?: string[];
  /** GST offline-tool style: [title, labels, values] on rows 1–3, headings on row 4. */
  gstSummary?: { title: string; labels: string[]; values: unknown[] };
  /** Add a bold total row for these column indexes. */
  totals?: number[];
}

const NUMFMT: Partial<Record<Kind, string>> = { money: '#,##0.00', qty: '#,##0.###', int: '0', rate: '0.##', date: 'dd-mmm-yyyy' };

function cellValue(kind: Kind, v: unknown): ExcelJS.CellValue {
  if (v == null || v === '') return null;
  switch (kind) {
    case 'money':
      return Math.round(Number(v)) / 100;
    case 'qty':
      return Math.round(Number(v)) / 1000;
    case 'int':
    case 'rate':
      return Number(v);
    case 'date':
      return new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
    case 'gstdate':
      return gstDate(String(v));
    default:
      return String(v);
  }
}

export async function workbook(sheets: Sheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kanakapatnam Store Desk';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.columns = s.columns.map((c) => ({ width: c.width ?? Math.max(12, Math.min(40, c.header.length + 4)) }));
    if (s.gstSummary) {
      ws.addRow([s.gstSummary.title]).font = { bold: true };
      ws.addRow(s.gstSummary.labels).font = { bold: true };
      ws.addRow(s.gstSummary.values);
    }
    for (const t of s.title ?? []) ws.addRow([t]).font = { bold: true };
    if (s.title?.length) ws.addRow([]);
    const head = ws.addRow(s.columns.map((c) => c.header));
    head.font = { bold: true };
    head.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F1EC' } };
      c.alignment = { wrapText: true, vertical: 'middle' };
    });
    const first = ws.rowCount + 1;
    for (const r of s.rows) ws.addRow(s.columns.map((c, i) => cellValue(c.kind ?? 'text', r[i])));
    if (s.totals?.length && s.rows.length) {
      const last = ws.rowCount;
      const row = ws.addRow(s.columns.map((_, i) => (i === 0 ? 'Total' : null)));
      for (const i of s.totals) {
        const col = ws.getColumn(i + 1).letter;
        row.getCell(i + 1).value = { formula: `SUM(${col}${first}:${col}${last})`, result: s.rows.reduce((t: number, r) => t + Number(cellValue(s.columns[i]!.kind ?? "text", r[i]) ?? 0), 0) };
      }
      row.font = { bold: true };
    }
    s.columns.forEach((c, i) => {
      const f = NUMFMT[c.kind ?? 'text'];
      if (f) ws.getColumn(i + 1).numFmt = f;
    });
    ws.views = [{ state: 'frozen', ySplit: first - 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const period = (r: Range) => `${gstDate(r.from)} to ${gstDate(r.to)}`;
const statusText = (s: string) => (s === 'cancelled' ? 'CANCELLED' : '');

export function salesRegisterXlsx(d: Awaited<ReturnType<typeof salesRegister>>, shop: string) {
  return workbook([
    {
      name: 'Sales register',
      title: [`${shop} — Sales register`, period(d)],
      columns: [
        { header: 'Bill no', width: 18 }, { header: 'Date', kind: 'date' }, { header: 'Customer', width: 28 }, { header: 'GSTIN', width: 18 },
        { header: 'Place of supply' }, { header: 'Payment' }, { header: 'Taxable', kind: 'money' }, { header: 'CGST', kind: 'money' },
        { header: 'SGST', kind: 'money' }, { header: 'IGST', kind: 'money' }, { header: 'Round off', kind: 'money' }, { header: 'Bill total', kind: 'money' },
        { header: 'Discount given', kind: 'money' }, { header: 'E-way bill' }, { header: 'Staff' }, { header: 'Status' },
      ],
      // cancelled bills are listed (the numbers must be continuous) with zero amounts
      rows: d.invoices.map((x) => {
        const c = x.status === 'cancelled';
        return [x.number, x.invoice_date, x.customer_name ?? 'Walk-in', x.customer_gstin, x.place_of_supply, x.payment_mode, c ? 0 : x.taxable_paise, c ? 0 : x.cgst_paise, c ? 0 : x.sgst_paise, c ? 0 : x.igst_paise, c ? 0 : x.round_off_paise, c ? 0 : x.total_paise, c ? 0 : x.discount_paise, x.ewb_no, x.user_name, statusText(x.status)];
      }),
      totals: [6, 7, 8, 9, 10, 11, 12],
    },
    {
      name: 'Credit notes',
      title: [`${shop} — Sales returns (credit notes)`, period(d)],
      columns: [
        { header: 'Note no', width: 18 }, { header: 'Date', kind: 'date' }, { header: 'Against bill', width: 18 }, { header: 'Customer', width: 28 }, { header: 'GSTIN', width: 18 },
        { header: 'Reason', width: 28 }, { header: 'Refund' }, { header: 'Taxable', kind: 'money' }, { header: 'CGST', kind: 'money' }, { header: 'SGST', kind: 'money' },
        { header: 'IGST', kind: 'money' }, { header: 'Round off', kind: 'money' }, { header: 'Total', kind: 'money' }, { header: 'Status' },
      ],
      rows: d.creditNotes.map((x) => [x.number, x.note_date, x.invoice_number, x.customer_name ?? 'Walk-in', x.customer_gstin, x.reason, x.refund_mode, x.taxable_paise, x.cgst_paise, x.sgst_paise, x.igst_paise, x.round_off_paise, x.total_paise, statusText(x.status)]),
      totals: [7, 8, 9, 10, 11, 12],
    },
  ]);
}

export function purchaseRegisterXlsx(d: Awaited<ReturnType<typeof purchaseRegister>>, shop: string) {
  const live = <T extends { status: string }>(x: T, v: number) => (x.status === 'cancelled' ? 0 : v);
  return workbook([
    {
      name: 'Purchase register',
      title: [`${shop} — Purchase register (by supplier bill date)`, period(d)],
      columns: [
        { header: 'Supplier bill no', width: 18 }, { header: 'Bill date', kind: 'date' }, { header: 'Supplier', width: 28 }, { header: 'Supplier GSTIN', width: 18 },
        { header: 'Our no', width: 18 }, { header: 'Entered on', kind: 'date' }, { header: 'Taxable', kind: 'money' }, { header: 'CGST', kind: 'money' },
        { header: 'SGST', kind: 'money' }, { header: 'IGST', kind: 'money' }, { header: 'Freight', kind: 'money' }, { header: 'Round off', kind: 'money' },
        { header: 'Bill total', kind: 'money' }, { header: 'Status' },
      ],
      rows: d.purchases.map((x) => [x.supplier_invoice_no, x.supplier_invoice_date, x.supplier_name, x.supplier_gstin, x.number, x.entered_on, live(x, x.taxable_paise), live(x, x.cgst_paise), live(x, x.sgst_paise), live(x, x.igst_paise), live(x, x.freight_paise), live(x, x.round_off_paise), live(x, x.total_paise), statusText(x.status)]),
      totals: [6, 7, 8, 9, 10, 11, 12],
    },
    {
      name: 'Debit notes',
      title: [`${shop} — Purchase returns (debit notes)`, period(d)],
      columns: [
        { header: 'Note no', width: 18 }, { header: 'Date', kind: 'date' }, { header: 'Supplier', width: 28 }, { header: 'Supplier GSTIN', width: 18 }, { header: 'Supplier bill no' },
        { header: 'Reason', width: 28 }, { header: 'Taxable', kind: 'money' }, { header: 'CGST', kind: 'money' }, { header: 'SGST', kind: 'money' }, { header: 'IGST', kind: 'money' },
        { header: 'Total', kind: 'money' }, { header: 'Status' },
      ],
      rows: d.debitNotes.map((x) => [x.number, x.note_date, x.supplier_name, x.supplier_gstin, x.supplier_invoice_no, x.reason, x.taxable_paise, x.cgst_paise, x.sgst_paise, x.igst_paise, x.total_paise, statusText(x.status)]),
      totals: [6, 7, 8, 9, 10],
    },
  ]);
}

const rs = (p: number) => Math.round(p) / 100;

export function gstr1Xlsx(g: Gstr1) {
  const sum = <T>(rows: T[], f: (r: T) => number) => rs(rows.reduce((s, r) => s + f(r), 0));
  const uniq = <T>(rows: T[], f: (r: T) => string) => new Set(rows.map(f)).size;
  const hsnSheet = (name: string, rows: Gstr1['hsnB2b']): Sheet => ({
    name,
    gstSummary: {
      title: 'Summary For HSN(12)',
      labels: ['No. of HSN', '', '', '', 'Total Value', '', 'Total Taxable Value', 'Total Integrated Tax', 'Total Central Tax', 'Total State/UT Tax', 'Total Cess'],
      values: [rows.length, null, null, null, sum(rows, (r) => r.value), null, sum(rows, (r) => r.taxable), sum(rows, (r) => r.igst), sum(rows, (r) => r.cgst), sum(rows, (r) => r.sgst), 0],
    },
    columns: [
      { header: 'HSN', width: 12 }, { header: 'Description', width: 32 }, { header: 'UQC' }, { header: 'Total Quantity', kind: 'qty' }, { header: 'Total Value', kind: 'money' },
      { header: 'Rate', kind: 'rate' }, { header: 'Taxable Value', kind: 'money' }, { header: 'Integrated Tax Amount', kind: 'money' }, { header: 'Central Tax Amount', kind: 'money' },
      { header: 'State/UT Tax Amount', kind: 'money' }, { header: 'Cess Amount', kind: 'money' },
    ],
    rows: rows.map((r) => [r.hsn, r.description, r.uqc, r.qty, r.value, r.rate, r.taxable, r.igst, r.cgst, r.sgst, 0]),
  });
  return workbook([
    {
      name: 'b2b,sez,de',
      gstSummary: {
        title: 'Summary For B2B, SEZ, DE (4A, 4B, 6B, 6C)',
        labels: ['No. of Recipients', '', 'No. of Invoices', '', 'Total Invoice Value', '', '', '', '', '', '', 'Total Taxable Value', 'Total Cess'],
        values: [uniq(g.b2b, (r) => r.gstin), null, uniq(g.b2b, (r) => r.number), null, rs([...new Map(g.b2b.map((r) => [r.number, r.value])).values()].reduce((s, v) => s + v, 0)), null, null, null, null, null, null, sum(g.b2b, (r) => r.taxable), 0],
      },
      columns: [
        { header: 'GSTIN/UIN of Recipient', width: 18 }, { header: 'Receiver Name', width: 28 }, { header: 'Invoice Number', width: 18 }, { header: 'Invoice date', kind: 'gstdate' },
        { header: 'Invoice Value', kind: 'money' }, { header: 'Place Of Supply', width: 20 }, { header: 'Reverse Charge' }, { header: 'Applicable % of Tax Rate' },
        { header: 'Invoice Type' }, { header: 'E-Commerce GSTIN' }, { header: 'Rate', kind: 'rate' }, { header: 'Taxable Value', kind: 'money' }, { header: 'Cess Amount', kind: 'money' },
      ],
      rows: g.b2b.map((r) => [r.gstin, r.name, r.number, r.date, r.value, r.pos, 'N', null, 'Regular B2B', null, r.rate, r.taxable, 0]),
    },
    {
      name: 'b2cl',
      gstSummary: {
        title: 'Summary For B2CL(5)',
        labels: ['No. of Invoices', '', 'Total Inv Value', '', '', 'Total Taxable Value', 'Total Cess'],
        values: [uniq(g.b2cl, (r) => r.number), null, rs([...new Map(g.b2cl.map((r) => [r.number, r.value])).values()].reduce((s, v) => s + v, 0)), null, null, sum(g.b2cl, (r) => r.taxable), 0],
      },
      columns: [
        { header: 'Invoice Number', width: 18 }, { header: 'Invoice date', kind: 'gstdate' }, { header: 'Invoice Value', kind: 'money' }, { header: 'Place Of Supply', width: 20 },
        { header: 'Applicable % of Tax Rate' }, { header: 'Rate', kind: 'rate' }, { header: 'Taxable Value', kind: 'money' }, { header: 'Cess Amount', kind: 'money' }, { header: 'E-Commerce GSTIN' },
      ],
      rows: g.b2cl.map((r) => [r.number, r.date, r.value, r.pos, null, r.rate, r.taxable, 0, null]),
    },
    {
      name: 'b2cs',
      gstSummary: { title: 'Summary For B2CS(7)', labels: ['', '', '', '', 'Total Taxable  Value', 'Total Cess', ''], values: [null, null, null, null, sum(g.b2cs, (r) => r.taxable), 0, null] },
      columns: [
        { header: 'Type' }, { header: 'Place Of Supply', width: 20 }, { header: 'Applicable % of Tax Rate' }, { header: 'Rate', kind: 'rate' }, { header: 'Taxable Value', kind: 'money' },
        { header: 'Cess Amount', kind: 'money' }, { header: 'E-Commerce GSTIN' },
      ],
      rows: g.b2cs.map((r) => ['OE', r.pos, null, r.rate, r.taxable, 0, null]),
    },
    {
      name: 'cdnr',
      gstSummary: {
        title: 'Summary For CDNR(9B)',
        labels: ['No. of Recipients', '', 'No. of Notes', '', '', '', '', '', 'Total Note Value', '', '', 'Total Taxable Value', 'Total Cess'],
        values: [uniq(g.cdnr, (r) => r.gstin), null, uniq(g.cdnr, (r) => r.number), null, null, null, null, null, rs([...new Map(g.cdnr.map((r) => [r.number, r.value])).values()].reduce((s, v) => s + v, 0)), null, null, sum(g.cdnr, (r) => r.taxable), 0],
      },
      columns: [
        { header: 'GSTIN/UIN of Recipient', width: 18 }, { header: 'Receiver Name', width: 28 }, { header: 'Note Number', width: 18 }, { header: 'Note Date', kind: 'gstdate' },
        { header: 'Note Type' }, { header: 'Place Of Supply', width: 20 }, { header: 'Reverse Charge' }, { header: 'Note Supply Type' }, { header: 'Note Value', kind: 'money' },
        { header: 'Applicable % of Tax Rate' }, { header: 'Rate', kind: 'rate' }, { header: 'Taxable Value', kind: 'money' }, { header: 'Cess Amount', kind: 'money' },
      ],
      rows: g.cdnr.map((r) => [r.gstin, r.name, r.number, r.date, 'C', r.pos, 'N', 'Regular B2B', r.value, null, r.rate, r.taxable, 0]),
    },
    {
      name: 'cdnur',
      gstSummary: {
        title: 'Summary For CDNUR(9B)',
        labels: ['', 'No. of Notes/Vouchers', '', '', '', 'Total Note Value', '', '', 'Total Taxable Value', 'Total Cess'],
        values: [null, uniq(g.cdnur, (r) => r.number), null, null, null, rs([...new Map(g.cdnur.map((r) => [r.number, r.value])).values()].reduce((s, v) => s + v, 0)), null, null, sum(g.cdnur, (r) => r.taxable), 0],
      },
      columns: [
        { header: 'UR Type' }, { header: 'Note Number', width: 18 }, { header: 'Note Date', kind: 'gstdate' }, { header: 'Note Type' }, { header: 'Place Of Supply', width: 20 },
        { header: 'Note Value', kind: 'money' }, { header: 'Applicable % of Tax Rate' }, { header: 'Rate', kind: 'rate' }, { header: 'Taxable Value', kind: 'money' }, { header: 'Cess Amount', kind: 'money' },
      ],
      rows: g.cdnur.map((r) => ['B2CL', r.number, r.date, 'C', r.pos, r.value, null, r.rate, r.taxable, 0]),
    },
    hsnSheet('hsn(b2b)', g.hsnB2b),
    hsnSheet('hsn(b2c)', g.hsnB2c),
    {
      name: 'docs',
      gstSummary: { title: 'Summary of documents issued during the tax period (13)', labels: ['', '', '', 'Total Number', 'Total Cancelled'], values: [null, null, null, g.docs.reduce((s, d) => s + d.total, 0), g.docs.reduce((s, d) => s + d.cancelled, 0)] },
      columns: [{ header: 'Nature of Document', width: 30 }, { header: 'Sr. No. From', width: 18 }, { header: 'Sr. No. To', width: 18 }, { header: 'Total Number', kind: 'int' }, { header: 'Cancelled', kind: 'int' }],
      rows: g.docs.map((d) => [d.nature, d.from, d.to, d.total, d.cancelled]),
    },
  ]);
}

export function gstr3bXlsx(d: Awaited<ReturnType<typeof gstr3b>>, shop: string) {
  const row = (label: string, x: { taxable?: number; igst: number; cgst: number; sgst: number }) => [label, x.taxable ?? null, x.igst, x.cgst, x.sgst, 0];
  return workbook([
    {
      name: 'GSTR-3B',
      title: [`${shop} — GSTR-3B working`, period(d), 'Check with GSTR-1 and GSTR-2B before filing.'],
      columns: [{ header: 'Table', width: 60 }, { header: 'Taxable value', kind: 'money' }, { header: 'Integrated tax', kind: 'money' }, { header: 'Central tax', kind: 'money' }, { header: 'State/UT tax', kind: 'money' }, { header: 'Cess', kind: 'money' }],
      rows: [
        row('3.1(a) Outward taxable supplies (sales less returns)', d.outward),
        row('    sales bills', d.outwardDetail.sales),
        row('    less credit notes', { ...d.outwardDetail.returns, taxable: -d.outwardDetail.returns.taxable, igst: -d.outwardDetail.returns.igst, cgst: -d.outwardDetail.returns.cgst, sgst: -d.outwardDetail.returns.sgst }),
        ['3.2 Inter-state supplies to unregistered persons'],
        ...d.interStateUnregistered.map((x) => [`    ${x.pos}`, x.taxable, x.igst, null, null, null]),
        row('4(A)(5) All other ITC (purchase bills)', d.itc.purchases),
        row('    less purchase returns (debit notes)', { igst: -d.itc.purchaseReturns.igst, cgst: -d.itc.purchaseReturns.cgst, sgst: -d.itc.purchaseReturns.sgst }),
        row('Net ITC available', d.itc.net),
        ...d.notes.map((n) => [n]),
      ],
    },
  ]);
}

export function discountXlsx(d: Awaited<ReturnType<typeof discountReport>>, shop: string) {
  const pct = (disc: number, gross: number) => (gross ? Math.round((disc / gross) * 10000) / 100 : 0);
  return workbook([
    {
      name: 'By staff',
      title: [`${shop} — Discounts by staff`, period(d)],
      columns: [{ header: 'Staff', width: 24 }, { header: 'Bills', kind: 'int' }, { header: 'Gross sales', kind: 'money' }, { header: 'Discount', kind: 'money' }, { header: 'Discount %', kind: 'rate' }, { header: 'Over-limit lines (admin PIN)', kind: 'int' }, { header: 'Over-limit discount', kind: 'money' }],
      rows: d.byStaff.map((x) => [x.name, x.bills, x.gross, x.discount, pct(x.discount, x.gross), x.over_limit_lines, x.over_limit_discount]),
      totals: [2, 3, 6],
    },
    {
      name: 'By product',
      title: [`${shop} — Discounts by product`, period(d)],
      columns: [{ header: 'Product', width: 36 }, { header: 'Unit' }, { header: 'Qty sold', kind: 'qty' }, { header: 'Gross sales', kind: 'money' }, { header: 'Discount', kind: 'money' }, { header: 'Discount %', kind: 'rate' }, { header: 'Lines with discount', kind: 'int' }, { header: 'Highest %', kind: 'rate' }, { header: 'Over-limit lines', kind: 'int' }],
      rows: d.byProduct.map((x) => [x.name, x.unit_code, x.qty, x.gross, x.discount, pct(x.discount, x.gross), x.discounted_lines, x.max_bp / 100, x.over_limit_lines]),
      totals: [3, 4],
    },
    {
      name: 'Admin-approved',
      title: [`${shop} — Discounts above the limit, approved with the admin PIN`, period(d)],
      columns: [{ header: 'Bill no', width: 18 }, { header: 'Date', kind: 'date' }, { header: 'Product', width: 32 }, { header: 'Discount %', kind: 'rate' }, { header: 'Limit %', kind: 'rate' }, { header: 'Discount', kind: 'money' }, { header: 'Staff' }, { header: 'Approved by' }, { header: 'Reason', width: 28 }],
      rows: d.overLimit.map((x) => [x.number, x.invoice_date, x.product_name, x.discount_bp / 100, x.max_discount_bp / 100, x.discount_paise, x.staff, x.approved_by, x.reason]),
      totals: [5],
    },
  ]);
}

import { stateName, uqcFor } from '@kph/core';
import type { Q, Sql } from '../db/connect.js';
import { AppError, audit, requirePerm, type Ctx } from './common.js';
import { getSettings } from './settings.js';

/**
 * Tally export (TallyPrime "Import Data" XML). Store Desk keeps the books; the CA's Tally
 * company receives:
 *   - masters: ledgers (with their Tally groups, GSTIN and state, opening balances)
 *   - stock items (optional): name, unit, HSN, GST rate
 *   - vouchers: every entry in a period, in accounting-voucher form, with bill-wise references
 * Tally's sign convention: a debit is a negative AMOUNT with ISDEEMEDPOSITIVE = Yes.
 * Import first into a copy of the company (Gateway → Import → Masters / Transactions).
 */

const esc = (s: string | number | null | undefined) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // strip characters XML 1.0 does not allow
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** paise → "1234.50" (Tally amount, positive = credit). */
const amt = (paise: number) => {
  const neg = paise < 0;
  const a = Math.abs(paise);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};
const tdate = (iso: string) => iso.slice(0, 10).replace(/-/g, '');

function envelope(company: string, report: 'All Masters' | 'Vouchers', body: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>${report}</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
${body}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
}

// ------------------------------------------------------------------ names

interface LedgerRow {
  id: number;
  name: string;
  group_name: string;
  system_code: string | null;
  party_type: 'customer' | 'supplier' | null;
  party_id: number | null;
  opening_dr_paise: number;
  active: boolean;
  tally_name: string | null;
  gstin: string | null;
  state_code: string | null;
  address: string | null;
  phone: string | null;
}

async function ledgerRows(q: Q) {
  return q<LedgerRow[]>`
    select l.id, l.name, g.name as group_name, l.system_code, l.party_type, l.party_id, l.opening_dr_paise, l.active, t.tally_name,
           coalesce(c.gstin, s.gstin) as gstin, coalesce(c.state_code, left(s.gstin, 2)) as state_code,
           coalesce(c.address, s.address) as address, coalesce(c.phone, s.phone) as phone
    from ledgers l join ledger_groups g on g.id = l.group_id
         left join tally_names t on t.ledger_id = l.id
         left join customers c on l.party_type = 'customer' and c.id = l.party_id
         left join suppliers s on l.party_type = 'supplier' and s.id = l.party_id
    order by g.name, lower(l.name), l.id`;
}

/** Tally needs unique ledger names. A chosen Tally name wins; otherwise our name, made unique with the phone or an id. */
function resolveNames(rows: LedgerRow[]) {
  const names = new Map<number, string>();
  const taken = new Set<string>();
  for (const r of rows) if (r.tally_name) {
    names.set(r.id, r.tally_name);
    taken.add(r.tally_name.toLowerCase());
  }
  const counts = new Map<string, number>();
  for (const r of rows) if (!r.tally_name) counts.set(r.name.toLowerCase(), (counts.get(r.name.toLowerCase()) ?? 0) + 1);
  for (const r of rows) {
    if (r.tally_name) continue;
    let n = r.name.trim();
    if ((counts.get(n.toLowerCase()) ?? 0) > 1 || taken.has(n.toLowerCase())) {
      const suffix = r.phone?.replace(/\D/g, '').slice(-4);
      n = suffix ? `${n} (${suffix})` : `${n} #${r.id}`;
      if (taken.has(n.toLowerCase())) n = `${r.name.trim()} #${r.id}`;
    }
    taken.add(n.toLowerCase());
    names.set(r.id, n);
  }
  return names;
}

export async function tallyNames(q: Q, ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  const rows = await ledgerRows(q);
  const names = resolveNames(rows);
  return rows.map((r) => ({ ledgerId: r.id, name: r.name, group: r.group_name, partyType: r.party_type, tallyName: names.get(r.id)!, custom: !!r.tally_name, changed: names.get(r.id) !== r.name }));
}

export async function setTallyName(sql: Sql, ctx: Ctx, ledgerId: number, tallyName: string | null) {
  requirePerm(ctx, 'accounts.manage');
  const name = tallyName?.trim() || null;
  if (!name) {
    await sql`delete from tally_names where ledger_id = ${ledgerId}`;
    return { ok: true };
  }
  const [l] = await sql`select id from ledgers where id = ${ledgerId}`;
  if (!l) throw new AppError(404, 'NOT_FOUND', 'Account not found');
  const [clash] = await sql`select 1 from tally_names where lower(tally_name) = ${name.toLowerCase()} and ledger_id <> ${ledgerId}`;
  if (clash) throw new AppError(409, 'DUPLICATE', `"${name}" is already used for another account`);
  await sql`insert into tally_names (ledger_id, tally_name, updated_by) values (${ledgerId}, ${name}, ${ctx.userId})
            on conflict (ledger_id) do update set tally_name = excluded.tally_name, updated_by = excluded.updated_by, updated_at = now()`;
  await audit(sql, ctx, 'tally.name', { entity: 'ledger', entityId: ledgerId, details: { tallyName: name } });
  return { ok: true };
}

// ------------------------------------------------------------------ masters

const DUTY_HEAD: Record<string, string> = {
  output_cgst: 'Central Tax', input_cgst: 'Central Tax',
  output_sgst: 'State Tax', input_sgst: 'State Tax',
  output_igst: 'Integrated Tax', input_igst: 'Integrated Tax',
};

export async function mastersXml(sql: Sql, ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  const s = await getSettings(sql);
  const rows = (await ledgerRows(sql)).filter((r) => r.active || r.opening_dr_paise !== 0);
  const names = resolveNames(rows);
  const out: string[] = [];
  for (const r of rows) {
    const name = names.get(r.id)!;
    const parts = [
      `<LEDGER NAME="${esc(name)}" ACTION="Create">`,
      `<NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>`,
      `<PARENT>${esc(r.group_name)}</PARENT>`,
      // Tally: debit opening balance is negative
      `<OPENINGBALANCE>${amt(-r.opening_dr_paise)}</OPENINGBALANCE>`,
    ];
    if (r.party_type) {
      parts.push('<ISBILLWISEON>Yes</ISBILLWISEON>', '<COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>');
      const st = r.state_code ?? s.stateCode;
      parts.push(`<LEDSTATENAME>${esc(stateName(st))}</LEDSTATENAME>`);
      if (r.gstin) parts.push('<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>', `<PARTYGSTIN>${esc(r.gstin)}</PARTYGSTIN>`);
      else parts.push('<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>');
      if (r.address) parts.push(`<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(r.address.slice(0, 200))}</ADDRESS></ADDRESS.LIST>`);
      if (r.phone) parts.push(`<LEDGERMOBILE>${esc(r.phone)}</LEDGERMOBILE>`);
    }
    if (r.system_code && DUTY_HEAD[r.system_code]) parts.push('<TAXTYPE>GST</TAXTYPE>', `<GSTDUTYHEAD>${DUTY_HEAD[r.system_code]}</GSTDUTYHEAD>`);
    if (r.group_name === 'Sales Accounts' || r.group_name === 'Purchase Accounts') parts.push('<AFFECTSSTOCK>No</AFFECTSSTOCK>');
    parts.push('</LEDGER>');
    out.push(`    <TALLYMESSAGE xmlns:UDF="TallyUDF">${parts.join('')}</TALLYMESSAGE>`);
  }
  await sql`insert into tally_exports (what, voucher_count, user_id) values ('masters', ${rows.length}, ${ctx.userId})`;
  return { xml: envelope(s.tallyCompanyName || s.storeName, 'All Masters', out.join('\n')), count: rows.length };
}

export async function stockItemsXml(sql: Sql, ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  const s = await getSettings(sql);
  const items = await sql<{ id: number; name: string; sku: string; unit_code: string; hsn: string | null; gst_rate_bp: number; category: string | null }[]>`
    select p.id, p.name, p.sku, p.unit_code, p.hsn, p.gst_rate_bp, c.name as category
    from products p left join categories c on c.id = p.category_id where p.active order by lower(p.name)`;
  const units = [...new Set(items.map((i) => i.unit_code))];
  const groups = [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))];
  const msgs: string[] = [];
  for (const u of units)
    msgs.push(`    <TALLYMESSAGE xmlns:UDF="TallyUDF"><UNIT NAME="${esc(u)}" ACTION="Create"><NAME>${esc(u)}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><ORIGINALNAME>${esc(u)}</ORIGINALNAME><GSTREPUOM>${esc(uqcFor(u))}</GSTREPUOM></UNIT></TALLYMESSAGE>`);
  for (const g of groups)
    msgs.push(`    <TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKGROUP NAME="${esc(g)}" ACTION="Create"><NAME.LIST><NAME>${esc(g)}</NAME></NAME.LIST><PARENT></PARENT></STOCKGROUP></TALLYMESSAGE>`);
  // Same name twice → add the SKU so Tally keeps them apart.
  const seen = new Map<string, number>();
  for (const i of items) seen.set(i.name.toLowerCase(), (seen.get(i.name.toLowerCase()) ?? 0) + 1);
  for (const i of items) {
    const name = (seen.get(i.name.toLowerCase()) ?? 0) > 1 ? `${i.name} (${i.sku})` : i.name;
    const rate = i.gst_rate_bp / 100;
    msgs.push(
      `    <TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>` +
        `<PARENT>${esc(i.category ?? '')}</PARENT><BASEUNITS>${esc(i.unit_code)}</BASEUNITS><GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>` +
        `<GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>${esc(i.hsn ?? '')}</HSNCODE><TAXABILITY>Taxable</TAXABILITY>` +
        `<STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>` +
        `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${rate / 2}</GSTRATE></RATEDETAILS.LIST>` +
        `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${rate / 2}</GSTRATE></RATEDETAILS.LIST>` +
        `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${rate}</GSTRATE></RATEDETAILS.LIST>` +
        `</STATEWISEDETAILS.LIST></GSTDETAILS.LIST></STOCKITEM></TALLYMESSAGE>`,
    );
  }
  await sql`insert into tally_exports (what, voucher_count, user_id) values ('stock_items', ${items.length}, ${ctx.userId})`;
  return { xml: envelope(s.tallyCompanyName || s.storeName, 'All Masters', msgs.join('\n')), count: items.length };
}

// ------------------------------------------------------------------ vouchers

const VTYPE: Record<string, string> = {
  sales: 'Sales',
  receipt: 'Receipt',
  payment: 'Payment',
  purchase: 'Purchase',
  journal: 'Journal',
  contra: 'Contra',
  expense: 'Payment',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
  reversal: 'Journal',
};

interface VoucherRow {
  id: number;
  vtype: string;
  vdate: string;
  narration: string | null;
  ref_type: string | null;
  ref_id: number | null;
  reverses_id: number | null;
  doc_number: string | null;
  orig_number: string | null;
  supplier_bill_no: string | null;
  supplier_bill_date: string | null;
  invoice_number: string | null;
  lines: { ledger_id: number; dr: number; cr: number; party: string | null }[];
}

/** Our document number for a voucher (bill, receipt, purchase, note, money entry). */
const DOC_NUMBER = (alias: string) => `
  case ${alias}.ref_type
    when 'sales_invoice' then (select number from sales_invoices where id = ${alias}.ref_id)
    when 'receipt' then (select number from receipts where id = ${alias}.ref_id)
    when 'purchase_invoice' then (select number from purchase_invoices where id = ${alias}.ref_id)
    when 'credit_note' then (select number from credit_notes where id = ${alias}.ref_id)
    when 'debit_note' then (select number from debit_notes where id = ${alias}.ref_id)
    when 'money_entry' then (select number from money_entries where id = ${alias}.ref_id)
  end`;

export async function vouchersXml(sql: Sql, ctx: Ctx, r: { from: string; to: string }) {
  requirePerm(ctx, 'reports.view');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to) || r.from > r.to) throw new AppError(400, 'BAD_RANGE', 'Choose a valid date range');
  const s = await getSettings(sql);
  const names = resolveNames(await ledgerRows(sql));
  const vouchers = await sql.unsafe<VoucherRow[]>(
    `
    select v.id, v.vtype, v.vdate::text as vdate, v.narration, v.ref_type, v.ref_id, v.reverses_id,
           ${DOC_NUMBER('v')} as doc_number,
           (select ${DOC_NUMBER('o')} from vouchers o where o.id = v.reverses_id) as orig_number,
           case when v.ref_type = 'purchase_invoice' then (select supplier_invoice_no from purchase_invoices where id = v.ref_id)
                when v.ref_type = 'debit_note' then (select p.supplier_invoice_no from debit_notes d join purchase_invoices p on p.id = d.purchase_id where d.id = v.ref_id) end as supplier_bill_no,
           case when v.ref_type = 'purchase_invoice' then (select supplier_invoice_date::text from purchase_invoices where id = v.ref_id) end as supplier_bill_date,
           case when v.ref_type = 'credit_note' then (select si.number from credit_notes cn join sales_invoices si on si.id = cn.invoice_id where cn.id = v.ref_id) end as invoice_number,
           (select json_agg(json_build_object('ledger_id', vl.ledger_id, 'dr', vl.dr_paise, 'cr', vl.cr_paise, 'party', l.party_type) order by vl.dr_paise desc, vl.id)
              from voucher_lines vl join ledgers l on l.id = vl.ledger_id where vl.voucher_id = v.id) as lines
    from vouchers v
    where v.vdate between $1 and $2
    order by v.vdate, v.id`,
    [r.from, r.to],
  );
  // Payments settled against supplier bills (bill-wise "Agst Ref" in Tally).
  const allocs = await sql<{ entry_id: number; supplier_invoice_no: string; amount_paise: number }[]>`
    select a.entry_id, p.supplier_invoice_no, a.amount_paise from payment_allocations a join purchase_invoices p on p.id = a.purchase_id
    join money_entries m on m.id = a.entry_id where m.entry_date between ${r.from} and ${r.to}`;
  const allocByEntry = new Map<number, { ref: string; paise: number }[]>();
  for (const a of allocs) {
    const list = allocByEntry.get(a.entry_id) ?? [];
    list.push({ ref: a.supplier_invoice_no, paise: a.amount_paise });
    allocByEntry.set(a.entry_id, list);
  }

  const msgs: string[] = [];
  for (const v of vouchers) {
    const type = VTYPE[v.vtype] ?? 'Journal';
    const number = v.vtype === 'reversal' ? `REV ${v.orig_number ?? v.reverses_id}` : (v.doc_number ?? `SD-${v.id}`);
    const partyLine = v.lines.find((l) => l.party);
    const partyName = partyLine ? names.get(partyLine.ledger_id) : undefined;

    /** bill-wise allocation for the party line */
    const billAlloc = (l: VoucherRow['lines'][number]) => {
      if (!l.party) return '';
      const tallyAmt = amt(l.cr - l.dr); // debit → negative
      const bill = (name: string, kind: 'New Ref' | 'Agst Ref' | 'On Account', paise: string) =>
        `<BILLALLOCATIONS.LIST>${kind === 'On Account' ? '' : `<NAME>${esc(name)}</NAME>`}<BILLTYPE>${kind}</BILLTYPE><AMOUNT>${paise}</AMOUNT></BILLALLOCATIONS.LIST>`;
      switch (v.vtype) {
        case 'sales':
          return bill(number, 'New Ref', tallyAmt);
        case 'purchase':
          return bill(v.supplier_bill_no ?? number, 'New Ref', tallyAmt);
        case 'credit_note':
          return bill(v.invoice_number ?? number, 'Agst Ref', tallyAmt);
        case 'debit_note':
          return bill(v.supplier_bill_no ?? number, 'Agst Ref', tallyAmt);
        case 'payment': {
          const list = (v.ref_id && allocByEntry.get(v.ref_id)) || [];
          const total = l.dr - l.cr;
          const used = list.reduce((t, a) => t + a.paise, 0);
          return list.map((a) => bill(a.ref, 'Agst Ref', amt(-a.paise))).join('') + (total - used > 0 ? bill('', 'On Account', amt(-(total - used))) : '');
        }
        default:
          return bill('', 'On Account', tallyAmt);
      }
    };

    const entries = v.lines
      .map((l) => {
        const debit = l.dr > 0;
        return (
          `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(names.get(l.ledger_id))}</LEDGERNAME>` +
          `<ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>${l.party ? '<ISPARTYLEDGER>Yes</ISPARTYLEDGER>' : ''}` +
          `<AMOUNT>${amt(l.cr - l.dr)}</AMOUNT>${billAlloc(l)}</ALLLEDGERENTRIES.LIST>`
        );
      })
      .join('');
    const ref = v.vtype === 'purchase' && v.supplier_bill_no ? `<REFERENCE>${esc(v.supplier_bill_no)}</REFERENCE>${v.supplier_bill_date ? `<REFERENCEDATE>${tdate(v.supplier_bill_date)}</REFERENCEDATE>` : ''}` : '';
    msgs.push(
      `    <TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
        `<DATE>${tdate(v.vdate)}</DATE><EFFECTIVEDATE>${tdate(v.vdate)}</EFFECTIVEDATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>` +
        `<VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER>${ref}${partyName ? `<PARTYLEDGERNAME>${esc(partyName)}</PARTYLEDGERNAME>` : ''}` +
        `<NARRATION>${esc(v.narration)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>` +
        `<GUID>kph-storedesk-${v.id}</GUID>${entries}</VOUCHER></TALLYMESSAGE>`,
    );
  }

  const [overlap] = await sql<{ n: number }[]>`
    select count(*)::int as n from tally_exports where what = 'vouchers' and from_date <= ${r.to} and to_date >= ${r.from}`;
  await sql`insert into tally_exports (what, from_date, to_date, voucher_count, user_id) values ('vouchers', ${r.from}, ${r.to}, ${vouchers.length}, ${ctx.userId})`;
  await audit(sql, ctx, 'tally.exported', { details: { from: r.from, to: r.to, vouchers: vouchers.length } });
  return { xml: envelope(s.tallyCompanyName || s.storeName, 'Vouchers', msgs.join('\n')), count: vouchers.length, overlapsEarlierExport: overlap!.n > 0 };
}

export async function tallyExports(q: Q, ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  return q`select e.id, e.what, e.from_date, e.to_date, e.voucher_count, e.at, u.name as user_name from tally_exports e join users u on u.id = e.user_id order by e.id desc limit 50`;
}

export const _test = { amt, esc, resolveNames };

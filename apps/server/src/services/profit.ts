import { mulDivRound } from '@kph/core';
import type { Q } from '../db/connect.js';
import { AppError, requirePerm, type Ctx } from './common.js';

/**
 * Profit reports (Phase 3B). Cost of goods sold comes from the cost recorded on each bill
 * line at the moment of sale (weighted-average cost from Phase 3A), so profit is exact per line.
 * Returns take back both the sale and its cost. All money in paise.
 */

export interface Range {
  from: string;
  to: string;
}

function checkRange(r: Range) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.from) || !/^\d{4}-\d{2}-\d{2}$/.test(r.to) || r.from > r.to) throw new AppError(400, 'BAD_RANGE', 'Choose a valid date range');
}

/** cost of a line: cost per base unit × base quantity */
const LINE_COST = `round(coalesce(l.cost_price_cp, 0)::numeric * l.base_qty_milli / 100000)`;

// ------------------------------------------------------------------ profit by product / category / brand

export type GroupBy = 'product' | 'category' | 'brand';

export async function profitBy(q: Q, ctx: Ctx, r: Range, by: GroupBy) {
  requirePerm(ctx, 'products.view_cost', 'Only admin can see costs and profit');
  checkRange(r);
  const key = by === 'product' ? 'p.id::text' : by === 'category' ? `coalesce(c.name, 'No category')` : `coalesce(b.name, 'No brand')`;
  const label = by === 'product' ? 'min(p.name)' : key;
  const rows = await q.unsafe<{ key: string; name: string; unit_code: string | null; qty: number; sales: number; cost: number; unknown_cost_lines: number; bills: number }[]>(
    `
    with s as (
      select p.id as product_id, l.base_qty_milli as qty, l.taxable_paise as sales, ${LINE_COST} as cost, (l.cost_price_cp is null) as no_cost, si.id as invoice_id
      from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id join products p on p.id = l.product_id
      where si.status = 'posted' and si.invoice_date between $1 and $2
      union all
      select p.id, -cl.base_qty_milli, -cl.taxable_paise, -round(coalesce(l.cost_price_cp, 0)::numeric * cl.base_qty_milli / 100000), false, null
      from credit_note_lines cl join credit_notes cn on cn.id = cl.credit_note_id join sales_invoice_lines l on l.id = cl.invoice_line_id join products p on p.id = cl.product_id
      where cn.status = 'posted' and cn.note_date between $1 and $2
    )
    select ${key} as key, ${label} as name, ${by === 'product' ? 'min(p.unit_code)' : 'null'} as unit_code,
           sum(s.qty)::bigint as qty, sum(s.sales)::bigint as sales, sum(s.cost)::bigint as cost,
           count(*) filter (where s.no_cost)::int as unknown_cost_lines, count(distinct s.invoice_id)::int as bills
    from s join products p on p.id = s.product_id left join categories c on c.id = p.category_id left join brands b on b.id = p.brand_id
    group by ${key}
    order by sum(s.sales) - sum(s.cost) desc`,
    [r.from, r.to],
  );
  const out = rows.map((x) => ({ ...x, profit: x.sales - x.cost, marginBp: x.sales ? mulDivRound(x.sales - x.cost, 10000, x.sales) : 0 }));
  const sales = out.reduce((t, x) => t + x.sales, 0);
  const cost = out.reduce((t, x) => t + x.cost, 0);
  return { ...r, by, rows: out, totals: { sales, cost, profit: sales - cost, marginBp: sales ? mulDivRound(sales - cost, 10000, sales) : 0, unknownCostLines: out.reduce((t, x) => t + x.unknown_cost_lines, 0) } };
}

// ------------------------------------------------------------------ stock valuation

/**
 * Stock on hand on a date, valued at the current weighted-average cost.
 * (For a past date the quantity is exact; the cost is today's average.)
 */
export async function stockValuation(q: Q, ctx: Ctx, asOf: string) {
  requirePerm(ctx, 'products.view_cost', 'Only admin can see stock value');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new AppError(400, 'BAD_DATE', 'Choose a valid date');
  const rows = await q<{ id: number; sku: string; name: string; unit_code: string; category: string | null; brand: string | null; qty: number; cost: number | null; value: number }[]>`
    select p.id, p.sku, p.name, p.unit_code, c.name as category, b.name as brand, m.qty, p.cost_price_cp as cost,
           round(greatest(m.qty, 0)::numeric * coalesce(p.cost_price_cp, 0) / 100000)::bigint as value
    from (select product_id, sum(qty_milli)::bigint as qty from stock_movements
          where (at at time zone 'Asia/Kolkata')::date <= ${asOf} group by product_id) m
    join products p on p.id = m.product_id left join categories c on c.id = p.category_id left join brands b on b.id = p.brand_id
    where m.qty <> 0
    order by value desc, lower(p.name)`;
  const byCategory = new Map<string, number>();
  for (const x of rows) byCategory.set(x.category ?? 'No category', (byCategory.get(x.category ?? 'No category') ?? 0) + x.value);
  return {
    asOf,
    rows,
    byCategory: [...byCategory].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    totals: { value: rows.reduce((t, x) => t + x.value, 0), items: rows.length, negative: rows.filter((x) => x.qty < 0).length, noCost: rows.filter((x) => x.qty > 0 && x.cost == null).length },
  };
}

// ------------------------------------------------------------------ profit & loss

async function ledgerMovements(q: Q, r: Range, groups: string[]) {
  return q<{ id: number; name: string; group_name: string; system_code: string | null; amount: number }[]>`
    select l.id, l.name, g.name as group_name, l.system_code, sum(vl.dr_paise - vl.cr_paise)::bigint as amount
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id join ledgers l on l.id = vl.ledger_id join ledger_groups g on g.id = l.group_id
    where g.name = any(${groups}) and v.vdate between ${r.from} and ${r.to}
    group by l.id, l.name, g.name, l.system_code
    having sum(vl.dr_paise - vl.cr_paise) <> 0
    order by abs(sum(vl.dr_paise - vl.cr_paise)) desc`;
}

/**
 * Profit & Loss for a period:
 *   net sales (bills less returns, before GST)
 * − cost of goods sold (cost recorded on each line, less the cost of returned goods)
 * − stock written off / found (adjustments at cost)
 * = gross profit
 * − direct and indirect expenses (from the expense heads, freight inward, round-off)
 * + other income
 * = net profit
 */
export async function profitAndLoss(q: Q, ctx: Ctx, r: Range) {
  requirePerm(ctx, 'products.view_cost', 'Only admin can see profit');
  requirePerm(ctx, 'reports.view');
  checkRange(r);
  const [s] = await q<{ sales: number; cost: number; no_cost: number }[]>`
    select coalesce(sum(l.taxable_paise), 0)::bigint as sales,
           coalesce(sum(round(coalesce(l.cost_price_cp, 0)::numeric * l.base_qty_milli / 100000)), 0)::bigint as cost,
           count(*) filter (where l.cost_price_cp is null)::int as no_cost
    from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id
    where si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}`;
  const [ret] = await q<{ sales: number; cost: number }[]>`
    select coalesce(sum(cl.taxable_paise), 0)::bigint as sales,
           coalesce(sum(round(coalesce(l.cost_price_cp, 0)::numeric * cl.base_qty_milli / 100000)), 0)::bigint as cost
    from credit_note_lines cl join credit_notes cn on cn.id = cl.credit_note_id join sales_invoice_lines l on l.id = cl.invoice_line_id
    where cn.status = 'posted' and cn.note_date between ${r.from} and ${r.to}`;
  // Stock written off (damaged, lost) or found on counting, valued at the cost recorded on the movement.
  const [adj] = await q<{ value: number }[]>`
    select coalesce(sum(round(m.qty_milli::numeric * coalesce(m.unit_cost_cp, p.cost_price_cp, 0) / 100000)), 0)::bigint as value
    from stock_movements m join products p on p.id = m.product_id
    where m.kind in ('adjustment', 'audit') and (m.at at time zone 'Asia/Kolkata')::date between ${r.from} and ${r.to}`;
  const direct = await ledgerMovements(q, r, ['Direct Expenses']);
  const indirect = await ledgerMovements(q, r, ['Indirect Expenses']);
  const income = await ledgerMovements(q, r, ['Indirect Incomes']);

  const netSales = s!.sales - ret!.sales;
  const cogs = s!.cost - ret!.cost;
  const stockLoss = -adj!.value; // negative adjustment = loss
  const gross = netSales - cogs - stockLoss;
  const directTotal = direct.reduce((t, x) => t + x.amount, 0);
  const indirectTotal = indirect.reduce((t, x) => t + x.amount, 0);
  const incomeTotal = -income.reduce((t, x) => t + x.amount, 0);
  const net = gross - directTotal - indirectTotal + incomeTotal;
  return {
    ...r,
    sales: s!.sales,
    salesReturns: ret!.sales,
    netSales,
    costOfSales: s!.cost,
    costOfReturns: ret!.cost,
    cogs,
    stockLossPaise: stockLoss,
    grossProfit: gross,
    grossMarginBp: netSales ? mulDivRound(gross, 10000, netSales) : 0,
    directExpenses: direct.map((x) => ({ name: x.name, amount: x.amount })),
    indirectExpenses: indirect.map((x) => ({ name: x.name, amount: x.amount })),
    otherIncome: income.map((x) => ({ name: x.name, amount: -x.amount })),
    directTotal,
    indirectTotal,
    incomeTotal,
    netProfit: net,
    netMarginBp: netSales ? mulDivRound(net, 10000, netSales) : 0,
    linesWithoutCost: s!.no_cost,
    notes: [
      'Cost of goods is the weighted-average cost recorded on each bill line at the time of sale.',
      'Freight on purchases is shown as a direct expense; it is not added into the product cost.',
      'Figures are before income tax and exclude GST (GST is not income or expense for a registered dealer).',
    ],
  };
}

// ------------------------------------------------------------------ balance summary

/** A simple picture of the business on a date: what it has, what it owes, and what is left for the owner. */
export async function balanceSummary(q: Q, ctx: Ctx, asOf: string) {
  requirePerm(ctx, 'products.view_cost', 'Only admin can see the balance summary');
  requirePerm(ctx, 'reports.view');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new AppError(400, 'BAD_DATE', 'Choose a valid date');
  const ledgers = await q<{ id: number; name: string; group_name: string; nature: string; kind: string | null; system_code: string | null; party_type: string | null; balance: number }[]>`
    select l.id, l.name, g.name as group_name, g.nature, l.kind, l.system_code, l.party_type,
           l.opening_dr_paise + coalesce((select sum(vl.dr_paise - vl.cr_paise) from voucher_lines vl join vouchers v on v.id = vl.voucher_id
                                          where vl.ledger_id = l.id and v.vdate <= ${asOf}), 0) as balance
    from ledgers l join ledger_groups g on g.id = l.group_id`;
  const sum = (f: (l: (typeof ledgers)[number]) => boolean) => ledgers.filter(f).reduce((t, l) => t + l.balance, 0);
  const stock = (await stockValuation(q, ctx, asOf)).totals.value;

  const cash = sum((l) => l.kind === 'cash');
  const bank = sum((l) => l.kind === 'bank');
  const inTransit = sum((l) => l.kind === 'clearing');
  const receivable = sum((l) => l.party_type === 'customer' && l.balance > 0);
  const customerAdvances = -sum((l) => l.party_type === 'customer' && l.balance < 0);
  const payable = -sum((l) => l.party_type === 'supplier' && l.balance < 0);
  const supplierAdvances = sum((l) => l.party_type === 'supplier' && l.balance > 0);
  const gstNet = sum((l) => l.group_name === 'Duties & Taxes'); // + = credit available, − = payable
  const otherAssets = sum((l) => (l.group_name === 'Fixed Assets' || l.group_name === 'Loans & Advances (Asset)') && !l.party_type);
  const loans = -sum((l) => l.group_name === 'Loans (Liability)');

  const assets = [
    { name: 'Cash in hand', amount: cash },
    { name: 'Bank balances', amount: bank },
    { name: 'UPI / card money not yet in the bank', amount: inTransit },
    { name: 'Customers owe us', amount: receivable },
    { name: 'Stock at cost', amount: stock },
    { name: 'Advances paid to suppliers', amount: supplierAdvances },
    ...(gstNet > 0 ? [{ name: 'GST input credit available', amount: gstNet }] : []),
    ...(otherAssets ? [{ name: 'Fixed assets and advances', amount: otherAssets }] : []),
  ];
  const liabilities = [
    { name: 'We owe suppliers', amount: payable },
    { name: 'Advances from customers', amount: customerAdvances },
    ...(gstNet < 0 ? [{ name: 'GST to pay', amount: -gstNet }] : []),
    ...(loans ? [{ name: 'Loans', amount: loans }] : []),
  ];
  const totalAssets = assets.reduce((t, x) => t + x.amount, 0);
  const totalLiabilities = liabilities.reduce((t, x) => t + x.amount, 0);
  const capital = -sum((l) => l.system_code === 'capital');
  return { asOf, assets, liabilities, totalAssets, totalLiabilities, ownersFunds: totalAssets - totalLiabilities, capitalAccount: capital };
}

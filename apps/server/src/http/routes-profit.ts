import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { istDate, periodRange } from '@kph/core';
import { AppError } from '../services/common.js';
import { workbook } from '../services/exports.js';
import { balanceSummary, profitAndLoss, profitBy, stockValuation } from '../services/profit.js';
import { getSettings } from '../services/settings.js';
import { mastersXml, setTallyName, stockItemsXml, tallyExports, tallyNames, vouchersXml } from '../services/tally.js';
import { ctxOf, type Shared } from './app.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function rangeOf(query: unknown) {
  const q = z.object({ period: z.string().optional(), from: date.optional(), to: date.optional(), format: z.enum(['json', 'xlsx']).optional(), by: z.enum(['product', 'category', 'brand']).optional() }).parse(query);
  let from = q.from;
  let to = q.to;
  if (q.period) {
    try {
      ({ from, to } = periodRange(q.period));
    } catch (e) {
      throw new AppError(400, 'BAD_RANGE', (e as Error).message);
    }
  }
  if (!from || !to) throw new AppError(400, 'BAD_RANGE', 'Choose a month, a quarter or a date range');
  return { from, to, format: q.format ?? 'json', by: q.by ?? 'product', tag: q.period ?? `${from}_to_${to}` };
}

const send = (reply: FastifyReply, name: string, type: string, body: Buffer | string) =>
  reply.header('content-type', type).header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store').send(body);

export async function registerProfitRoutes(app: FastifyInstance, { db }: Shared) {
  const shop = async () => (await getSettings(db.app)).storeName;

  app.get('/api/reports/profit-loss', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await profitAndLoss(db.app, ctxOf(req), r);
    if (r.format !== 'xlsx') return d;
    const rows: unknown[][] = [
      ['Sales (before GST)', d.sales],
      ['Less: sales returns', -d.salesReturns],
      ['Net sales', d.netSales],
      ['Cost of goods sold', -d.costOfSales],
      ['Add back: cost of goods returned', d.costOfReturns],
      ['Stock written off (−) / found (+)', -d.stockLossPaise],
      ['Gross profit', d.grossProfit],
      ...d.directExpenses.map((x) => [`  ${x.name}`, -x.amount]),
      ...d.indirectExpenses.map((x) => [`  ${x.name}`, -x.amount]),
      ...d.otherIncome.map((x) => [`  ${x.name} (income)`, x.amount]),
      ['Net profit', d.netProfit],
    ];
    const buf = await workbook([{ name: 'Profit & Loss', title: [`${await shop()} — Profit & Loss`, `${r.from} to ${r.to}`], columns: [{ header: 'Particulars', width: 48 }, { header: 'Amount', kind: 'money' }], rows }]);
    return send(reply, `profit-loss_${r.tag}.xlsx`, XLSX, buf);
  });

  app.get('/api/reports/profit-by', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await profitBy(db.app, ctxOf(req), r, r.by);
    if (r.format !== 'xlsx') return d;
    const buf = await workbook([
      {
        name: `Profit by ${r.by}`,
        title: [`${await shop()} — Profit by ${r.by}`, `${r.from} to ${r.to}`],
        columns: [{ header: r.by === 'product' ? 'Product' : r.by === 'category' ? 'Category' : 'Brand', width: 40 }, ...(r.by === 'product' ? [{ header: 'Qty sold', kind: 'qty' as const }, { header: 'Unit' }] : []), { header: 'Sales (before GST)', kind: 'money' }, { header: 'Cost', kind: 'money' }, { header: 'Profit', kind: 'money' }, { header: 'Margin %', kind: 'rate' }],
        rows: d.rows.map((x) => [x.name, ...(r.by === 'product' ? [x.qty, x.unit_code] : []), x.sales, x.cost, x.profit, x.marginBp / 100]),
        totals: r.by === 'product' ? [3, 4, 5] : [1, 2, 3],
      },
    ]);
    return send(reply, `profit-by-${r.by}_${r.tag}.xlsx`, XLSX, buf);
  });

  app.get('/api/reports/stock-value', async (req, reply) => {
    const q = z.object({ asOf: date.optional(), format: z.enum(['json', 'xlsx']).optional() }).parse(req.query);
    const d = await stockValuation(db.app, ctxOf(req), q.asOf ?? istDate());
    if (q.format !== 'xlsx') return d;
    const buf = await workbook([
      {
        name: 'Stock value',
        title: [`${await shop()} — Stock at cost on ${d.asOf}`],
        columns: [{ header: 'SKU' }, { header: 'Product', width: 40 }, { header: 'Category' }, { header: 'Brand' }, { header: 'Qty', kind: 'qty' }, { header: 'Unit' }, { header: 'Cost per unit', kind: 'money' }, { header: 'Value', kind: 'money' }],
        rows: d.rows.map((x) => [x.sku, x.name, x.category, x.brand, x.qty, x.unit_code, x.cost, x.value]),
        totals: [7],
      },
    ]);
    return send(reply, `stock-value_${d.asOf}.xlsx`, XLSX, buf);
  });

  app.get('/api/reports/balance-summary', async (req) => {
    const q = z.object({ asOf: date.optional() }).parse(req.query);
    return balanceSummary(db.app, ctxOf(req), q.asOf ?? istDate());
  });

  // ---------------------------------------------------------------- Tally
  app.get('/api/tally/names', async (req) => tallyNames(db.app, ctxOf(req)));
  app.put('/api/tally/names/:ledgerId', async (req) => {
    const p = z.object({ ledgerId: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ tallyName: z.string().max(200).nullable() }).parse(req.body);
    return setTallyName(db.app, ctxOf(req), p.ledgerId, b.tallyName);
  });
  app.get('/api/tally/exports', async (req) => tallyExports(db.app, ctxOf(req)));
  app.get('/api/tally/masters.xml', async (req, reply) => {
    const r = await mastersXml(db.app, ctxOf(req));
    return send(reply, `tally-masters_${istDate()}.xml`, 'application/xml; charset=utf-8', r.xml);
  });
  app.get('/api/tally/stock-items.xml', async (req, reply) => {
    const r = await stockItemsXml(db.app, ctxOf(req));
    return send(reply, `tally-stock-items_${istDate()}.xml`, 'application/xml; charset=utf-8', r.xml);
  });
  app.get('/api/tally/vouchers.xml', async (req, reply) => {
    const r = rangeOf(req.query);
    const x = await vouchersXml(db.app, ctxOf(req), r);
    reply.header('x-voucher-count', String(x.count)).header('x-overlaps', x.overlapsEarlierExport ? '1' : '0');
    return send(reply, `tally-vouchers_${r.tag}.xml`, 'application/xml; charset=utf-8', x.xml);
  });
}

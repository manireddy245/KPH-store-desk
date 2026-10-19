import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatQty, istDate } from '@kph/core';
import { workbook } from '../services/exports.js';
import {
  closeAudit,
  closeCounter,
  counterSummary,
  createPurchaseOrders,
  decideItem,
  getAudit,
  getPurchaseOrder,
  listAudits,
  listCounterClosings,
  listPurchaseOrders,
  recordCount,
  setTargetDays,
  startAudit,
  stockInsights,
  updatePurchaseOrder,
} from '../services/stockcontrol.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MOVE: Record<string, string> = { fast: 'Fast', normal: 'Normal', slow: 'Slow', dead: 'Dead stock', new: 'New' };

export async function registerStockRoutes(app: FastifyInstance, { db, live }: Shared) {
  // ---------------------------------------------------------------- insights
  app.get('/api/insights/stock', async (req, reply) => {
    const q = z.object({ format: z.enum(['json', 'xlsx']).optional() }).parse(req.query);
    const d = await stockInsights(db.app, ctxOf(req));
    if (q.format !== 'xlsx') return d;
    const buf = await workbook([
      {
        name: 'Stock movement',
        title: [`Fast / slow / dead stock — sales of the last ${d.periodDays} days, as on ${d.asOf}`],
        columns: [
          { header: 'Product', width: 36 }, { header: 'Category' }, { header: 'Movement' }, { header: 'In stock', kind: 'qty' }, { header: 'Unit' },
          { header: `Sold (${d.periodDays} days)`, kind: 'qty' }, { header: 'Per day', kind: 'qty' }, { header: 'Days left', kind: 'int' },
          { header: 'Value at cost', kind: 'money' }, { header: 'Last sale', kind: 'date' }, { header: 'Suggest to order', kind: 'qty' }, { header: 'Why', width: 70 },
        ],
        rows: d.rows.map((r) => [r.name, r.category, MOVE[r.movement], r.stockMilli, r.unit, r.soldMilli, r.dailyMilli, r.daysLeft, r.valuePaise, r.lastSale, r.suggestMilli || null, r.why]),
        totals: [8],
      },
    ]);
    return reply.header('content-type', XLSX).header('content-disposition', `attachment; filename="stock-movement_${d.asOf}.xlsx"`).send(buf);
  });
  app.post('/api/insights/decisions', async (req) => {
    const b = z.object({ productId: z.number().int().positive(), action: z.enum(['dont_reorder', 'offer', 'tell_partners', 'return_to_supplier', 'keep']), note: z.string().max(300).optional() }).parse(req.body);
    return decideItem(db.app, ctxOf(req), b.productId, b);
  });
  app.put('/api/categories/:id/target-days', async (req) => {
    const b = z.object({ days: z.number().int().nullable() }).parse(req.body);
    return setTargetDays(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b.days);
  });

  // ---------------------------------------------------------------- purchase orders
  app.post('/api/purchase-orders', async (req) => {
    const b = z.object({ items: z.array(z.object({ productId: z.number().int().positive(), qtyMilli: z.number().int().min(0), supplierId: z.number().int().positive() })).min(1).max(500) }).parse(req.body);
    return createPurchaseOrders(db.app, ctxOf(req), b.items);
  });
  app.get('/api/purchase-orders', async (req) => listPurchaseOrders(db.app, ctxOf(req), z.object({ status: z.enum(['draft', 'sent', 'received', 'cancelled']).optional() }).parse(req.query)));
  app.get('/api/purchase-orders/:id', async (req) => getPurchaseOrder(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));
  app.patch('/api/purchase-orders/:id', async (req) => {
    const b = z
      .object({
        lines: z.array(z.object({ productId: z.number().int().positive(), qtyMilli: z.number().int().min(0) })).max(500).optional(),
        status: z.enum(['draft', 'sent', 'received', 'cancelled']).optional(),
        expectedOn: date.nullable().optional(),
        notes: z.string().max(500).nullable().optional(),
      })
      .parse(req.body);
    return updatePurchaseOrder(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
  });
  /** A purchase order as a WhatsApp message for the supplier. */
  app.get('/api/purchase-orders/:id/message', async (req) => {
    const po = (await getPurchaseOrder(db.app, ctxOf(req), z.object({ id }).parse(req.params).id)) as unknown as { number: string; supplier_name: string; store: { name: string; phone: string }; lines: { name: string; qty_milli: number; unit_code: string }[] };
    const text = [`${po.store.name} — order ${po.number}`, `To ${po.supplier_name}:`, ...po.lines.map((l) => `• ${l.name}: ${formatQty(l.qty_milli)} ${l.unit_code}`), 'Please confirm the delivery date.', po.store.phone].filter(Boolean).join('\n');
    return { text };
  });

  // ---------------------------------------------------------------- stock audit
  app.get('/api/stock-audits', async (req) => listAudits(db.app, ctxOf(req)));
  app.post('/api/stock-audits', async (req) => startAudit(db.app, ctxOf(req), z.object({ title: z.string().max(100).optional(), categoryId: z.number().int().positive().nullable().optional() }).parse(req.body)));
  app.get('/api/stock-audits/:id', async (req) => getAudit(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));
  app.post('/api/stock-audits/:id/count', async (req) => {
    const b = z
      .object({ productId: z.number().int().positive(), countedMilli: z.number().int().min(0), reason: z.enum(['damaged', 'leakage', 'shortage', 'found', 'wrong entry', 'other']).nullable().optional(), note: z.string().max(300).nullable().optional() })
      .parse(req.body);
    return recordCount(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
  });
  app.post('/api/stock-audits/:id/close', async (req) => {
    const r = await closeAudit(db.app, ctxOf(req), z.object({ id }).parse(req.params).id);
    live.broadcast({ type: 'stock.changed', productIds: [] });
    return r;
  });

  // ---------------------------------------------------------------- day-end per counter
  app.get('/api/counter-close/summary', async (req) => {
    const ctx = ctxOf(req);
    const q = z.object({ date: date.optional(), deviceId: id.optional(), floatPaise: z.coerce.number().int().min(0).optional() }).parse(req.query);
    return counterSummary(db.app, ctx, { date: q.date ?? istDate(), deviceId: q.deviceId ?? ctx.deviceId, floatPaise: q.floatPaise });
  });
  app.post('/api/counter-close', async (req) => {
    const b = z.object({ date: date.optional(), deviceId: z.number().int().positive().nullable().optional(), floatPaise: z.number().int().min(0).optional(), countedCashPaise: z.number().int().min(0), note: z.string().max(300).optional() }).parse(req.body);
    return closeCounter(db.app, ctxOf(req), b);
  });
  app.get('/api/counter-closings', async (req) => {
    const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
    const to = q.to ?? istDate();
    return listCounterClosings(db.app, ctxOf(req), { from: q.from ?? to, to });
  });
}

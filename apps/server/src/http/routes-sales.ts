import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cancelInvoice,
  cancelReceipt,
  clearDraft,
  createInvoice,
  createReceipt,
  getDraft,
  getInvoice,
  listInvoices,
  saveDraft,
} from '../services/billing.js';
import { can } from '../services/common.js';
import { dashboard } from '../services/dashboard.js';
import { getSettings } from '../services/settings.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function registerSalesRoutes(app: FastifyInstance, { db, live }: Shared) {
  app.post('/api/invoices', async (req) => {
    const b = z
      .object({
        clientRef: z.uuid().optional(),
        customerId: z.number().int().positive().nullable().optional(),
        customerName: z.string().max(100).optional(),
        customerPhone: z.string().max(20).optional(),
        customerAddress: z.string().max(300).optional(),
        placeOfSupply: z.string().regex(/^d{2}$/).optional(),
        paymentMode: z.enum(['cash', 'upi', 'card', 'credit']),
        notes: z.string().max(500).optional(),
        lines: z
          .array(
            z.object({
              productId: z.number().int().positive(),
              qtyMilli: z.number().int().positive(),
              ratePaise: z.number().int().min(0).optional(),
              rateMode: z.enum(['excl', 'incl']).optional(),
              unitCode: z.string().optional(),
              discountBp: z.number().int().min(0).max(10000),
              overrideToken: z.string().optional(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(req.body);
    const ctx = ctxOf(req);
    const r = await createInvoice(db.app, ctx, b);
    await clearDraft(db.app, ctx);
    if (!r.duplicate) {
      live.broadcast({ type: 'invoice.created', id: r.id, number: r.number });
      live.broadcast({ type: 'stock.changed', productIds: b.lines.map((l) => l.productId) });
    }
    return r;
  });

  app.get('/api/invoices', async (req) => {
    const q = z
      .object({
        from: date.optional(),
        to: date.optional(),
        search: z.string().optional(),
        status: z.enum(['posted', 'cancelled']).optional(),
        paymentMode: z.enum(['cash', 'upi', 'card', 'credit']).optional(),
        customerId: id.optional(),
      })
      .parse(req.query);
    return listInvoices(db.app, q);
  });

  app.get('/api/invoices/:id', async (req) => {
    const ctx = ctxOf(req);
    const inv = await getInvoice(db.app, z.object({ id }).parse(req.params).id, { withCost: can(ctx, 'products.view_cost') });
    const s = await getSettings(db.app);
    const store = {
      name: s.storeName,
      address: s.storeAddress,
      phone: s.storePhone,
      gstin: s.storeGstin,
      stateCode: s.stateCode,
      stateName: s.stateName,
      terms: s.invoiceTerms,
      labels: s.invoiceLabels,
    };
    return { ...inv, store };
  });

  app.post('/api/invoices/:id/cancel', async (req) => {
    const b = z.object({ reason: z.string(), overrideToken: z.string().optional() }).parse(req.body);
    const r = await cancelInvoice(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'invoice.cancelled', id: r.id, number: r.number });
    live.broadcast({ type: 'stock.changed', productIds: [] });
    return r;
  });

  // ---------------------------------------------------------------- receipts
  app.post('/api/receipts', async (req) => {
    const b = z
      .object({
        clientRef: z.uuid().optional(),
        customerId: z.number().int().positive(),
        mode: z.enum(['cash', 'upi', 'card', 'bank', 'cheque']),
        amountPaise: z.number().int().positive(),
        reference: z.string().max(100).optional(),
        notes: z.string().max(500).optional(),
      })
      .parse(req.body);
    const r = await createReceipt(db.app, ctxOf(req), b);
    live.broadcast({ type: 'receipt.created', id: r.id });
    live.broadcast({ type: 'customers.changed' });
    return r;
  });

  app.get('/api/receipts', async (req) => {
    const q = z.object({ from: date.optional(), to: date.optional(), customerId: id.optional() }).parse(req.query);
    return db.app`
      select r.*, c.name as customer_name, u.name as user_name, d.name as device_name
      from receipts r join customers c on c.id = r.customer_id join users u on u.id = r.user_id left join devices d on d.id = r.device_id
      where (${q.from ?? null}::date is null or r.receipt_date >= ${q.from ?? null}::date)
        and (${q.to ?? null}::date is null or r.receipt_date <= ${q.to ?? null}::date)
        and (${q.customerId ?? null}::int is null or r.customer_id = ${q.customerId ?? null})
      order by r.id desc limit 500`;
  });

  app.post('/api/receipts/:id/cancel', async (req) => {
    const b = z.object({ reason: z.string(), overrideToken: z.string().optional() }).parse(req.body);
    const r = await cancelReceipt(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'receipt.cancelled', id: r.id });
    live.broadcast({ type: 'customers.changed' });
    return r;
  });

  // ---------------------------------------------------------------- drafts
  app.get('/api/drafts/current', async (req) => getDraft(db.app, ctxOf(req)));
  app.put('/api/drafts/current', async (req) => {
    await saveDraft(db.app, ctxOf(req), req.body);
    return { ok: true };
  });
  app.delete('/api/drafts/current', async (req) => {
    await clearDraft(db.app, ctxOf(req));
    return { ok: true };
  });

  app.get('/api/dashboard', async (req) => dashboard(db.app, ctxOf(req)));
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, can } from '../services/common.js';
import {
  cancelQuote,
  convertQuote,
  createDelivery,
  deliverable,
  getDelivery,
  getQuote,
  listDeliveries,
  listQuotes,
  priceHistory,
  rateBoard,
  rateMessage,
  saveQuote,
  setDeliveryStatus,
  setOnRateBoard,
  setRates,
  setTrackBatches,
  stockAge,
} from '../services/operations.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const quoteBody = z.object({
  customerId: z.number().int().positive().nullable().optional(),
  customerName: z.string().max(100).nullable().optional(),
  customerPhone: z.string().max(20).nullable().optional(),
  customerAddress: z.string().max(300).nullable().optional(),
  partnerId: z.number().int().positive().nullable().optional(),
  site: z.string().max(200).nullable().optional(),
  template: z.enum(['full_house']).nullable().optional(),
  priceMode: z.enum(['excl', 'incl']).optional(),
  placeOfSupply: z.string().regex(/^\d{2}$/).optional(),
  validUntil: date.optional(),
  notes: z.string().max(1000).nullable().optional(),
  terms: z.string().max(1000).nullable().optional(),
  lines: z
    .array(
      z.object({
        stage: z.string().max(60).nullable().optional(),
        productId: z.number().int().positive(),
        unitCode: z.string().optional(),
        qtyMilli: z.number().int().positive(),
        ratePaise: z.number().int().min(0).optional(),
        rateMode: z.enum(['excl', 'incl']).optional(),
        discountBp: z.number().int().min(0).max(10000).optional(),
      }),
    )
    .min(1)
    .max(300),
});

export async function registerOperationsRoutes(app: FastifyInstance, { db, live }: Shared) {
  const seeOps = (req: Parameters<typeof ctxOf>[0]) => {
    const ctx = ctxOf(req);
    if (!can(ctx, 'billing.create') && !can(ctx, 'stock.adjust') && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see this');
    return ctx;
  };

  // ---------------------------------------------------------------- rate board
  app.get('/api/rate-board', async (req) => {
    seeOps(req);
    return rateBoard(db.app);
  });
  app.put('/api/rate-board', async (req) => {
    const b = z.object({ rates: z.array(z.object({ productId: z.number().int().positive(), salePricePaise: z.number().int().min(0) })).max(500) }).parse(req.body);
    const r = await setRates(db.app, ctxOf(req), b.rates);
    live.broadcast({ type: 'products.changed' });
    return r;
  });
  app.post('/api/rate-board/products', async (req) => {
    const b = z.object({ productId: z.number().int().positive(), on: z.boolean() }).parse(req.body);
    const r = await setOnRateBoard(db.app, ctxOf(req), b.productId, b.on);
    live.broadcast({ type: 'products.changed' });
    return r;
  });
  app.get('/api/rate-board/message', async (req) => {
    seeOps(req);
    return rateMessage(db.app, z.object({ lang: z.enum(['te', 'en']).optional() }).parse(req.query).lang ?? 'te');
  });
  app.get('/api/products/:id/price-history', async (req) => {
    seeOps(req);
    return priceHistory(db.app, z.object({ id }).parse(req.params).id);
  });

  // ---------------------------------------------------------------- quotations
  app.get('/api/quotes', async (req) => {
    seeOps(req);
    return listQuotes(db.app, z.object({ status: z.enum(['open', 'converted', 'cancelled']).optional(), search: z.string().optional() }).parse(req.query));
  });
  app.get('/api/quotes/:id', async (req) => {
    seeOps(req);
    return getQuote(db.app, z.object({ id }).parse(req.params).id);
  });
  app.post('/api/quotes', async (req) => saveQuote(db.app, ctxOf(req), null, quoteBody.parse(req.body)));
  app.put('/api/quotes/:id', async (req) => saveQuote(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, quoteBody.parse(req.body)));
  app.post('/api/quotes/:id/cancel', async (req) => cancelQuote(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));
  app.post('/api/quotes/:id/convert', async (req) => {
    const b = z.object({ paymentMode: z.enum(['cash', 'upi', 'card', 'credit']), prices: z.enum(['quoted', 'today']).optional(), clientRef: z.uuid().optional(), creditOverrideToken: z.string().optional() }).parse(req.body);
    const r = await convertQuote(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'invoice.created', id: r.id, number: r.number });
    live.broadcast({ type: 'stock.changed', productIds: [] });
    return r;
  });

  // ---------------------------------------------------------------- deliveries
  app.get('/api/deliveries', async (req) => {
    seeOps(req);
    return listDeliveries(db.app, z.object({ date: date.optional(), status: z.enum(['pending', 'out', 'delivered', 'cancelled']).optional(), invoiceId: id.optional() }).parse(req.query));
  });
  app.get('/api/deliveries/:id', async (req) => {
    seeOps(req);
    return getDelivery(db.app, z.object({ id }).parse(req.params).id);
  });
  app.get('/api/invoices/:id/deliverable', async (req) => {
    seeOps(req);
    return deliverable(db.app, z.object({ id }).parse(req.params).id);
  });
  app.post('/api/invoices/:id/deliveries', async (req) => {
    const b = z
      .object({
        date: date.optional(),
        siteAddress: z.string().max(300).optional(),
        contactPhone: z.string().max(20).optional(),
        vehicleNo: z.string().max(20).optional(),
        driverName: z.string().max(60).optional(),
        driverPhone: z.string().max(20).optional(),
        chargePaise: z.number().int().min(0).optional(),
        notes: z.string().max(300).optional(),
        lines: z.array(z.object({ invoiceLineId: z.number().int().positive(), qtyMilli: z.number().int().min(0) })).min(1),
      })
      .parse(req.body);
    const r = await createDelivery(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'deliveries.changed' });
    return r;
  });
  app.post('/api/deliveries/:id/status', async (req) => {
    const b = z.object({ status: z.enum(['pending', 'out', 'delivered', 'cancelled']), receivedBy: z.string().max(60).optional(), vehicleNo: z.string().max(20).optional(), driverName: z.string().max(60).optional() }).parse(req.body);
    const r = await setDeliveryStatus(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'deliveries.changed' });
    return r;
  });

  // ---------------------------------------------------------------- stock age
  app.post('/api/stock-age/products', async (req) => {
    const b = z.object({ productId: z.number().int().positive(), on: z.boolean() }).parse(req.body);
    return setTrackBatches(db.app, ctxOf(req), b.productId, b.on);
  });
  app.get('/api/stock-age', async (req) => {
    seeOps(req);
    const q = z.object({ productIds: z.string().optional() }).parse(req.query);
    const ids = q.productIds ? q.productIds.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined;
    return stockAge(db.app, { productIds: ids });
  });

}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../services/common.js';
import { listPeriods, setMonthFiled } from '../services/gst.js';
import { createCreditNote, createDebitNote, getCreditNote, getDebitNote, listCreditNotes, listDebitNotes } from '../services/returns.js';
import { getSettings } from '../services/settings.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function registerReturnRoutes(app: FastifyInstance, { db, live }: Shared) {
  app.post('/api/invoices/:id/returns', async (req) => {
    const b = z
      .object({
        clientRef: z.uuid().optional(),
        reason: z.string(),
        refundMode: z.enum(['account', 'cash', 'upi', 'card', 'bank']),
        overrideToken: z.string().optional(),
        lines: z.array(z.object({ invoiceLineId: z.number().int().positive(), qtyMilli: z.number().int().positive(), restock: z.boolean() })).min(1),
      })
      .parse(req.body);
    const r = await createCreditNote(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'stock.changed', productIds: [] });
    live.broadcast({ type: 'customers.changed' });
    live.broadcast({ type: 'invoice.cancelled', id: 0, number: '' });
    return r;
  });

  app.get('/api/credit-notes', async (req) => {
    ctxOf(req);
    return listCreditNotes(db.app, z.object({ from: date.optional(), to: date.optional() }).parse(req.query));
  });

  app.get('/api/credit-notes/:id', async (req) => {
    ctxOf(req);
    const cn = await getCreditNote(db.app, z.object({ id }).parse(req.params).id);
    const s = await getSettings(db.app);
    return { ...cn, store: { name: s.storeName, address: s.storeAddress, phone: s.storePhone, gstin: s.storeGstin, stateCode: s.stateCode, stateName: s.stateName, terms: s.invoiceTerms, labels: s.invoiceLabels } };
  });

  app.post('/api/purchases/:id/returns', async (req) => {
    const b = z
      .object({
        clientRef: z.uuid().optional(),
        reason: z.string(),
        lines: z.array(z.object({ purchaseLineId: z.number().int().positive(), baseQtyMilli: z.number().int().positive() })).min(1),
      })
      .parse(req.body);
    const r = await createDebitNote(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'stock.changed', productIds: [] });
    live.broadcast({ type: 'suppliers.changed' });
    return r;
  });

  app.get('/api/debit-notes', async (req) => {
    requirePerm(ctxOf(req), 'stock.adjust');
    return listDebitNotes(db.app, z.object({ from: date.optional(), to: date.optional() }).parse(req.query));
  });

  app.get('/api/debit-notes/:id', async (req) => {
    requirePerm(ctxOf(req), 'stock.adjust');
    return getDebitNote(db.app, z.object({ id }).parse(req.params).id);
  });

  // GST month lock
  app.get('/api/gst/periods', async (req) => {
    requirePerm(ctxOf(req), 'reports.view');
    return listPeriods(db.app);
  });
  app.post('/api/gst/periods/:month', async (req) => {
    const { month } = z.object({ month: z.string() }).parse(req.params);
    const b = z.object({ filed: z.boolean(), note: z.string().max(200).optional() }).parse(req.body);
    await setMonthFiled(db.app, ctxOf(req), month, b.filed, b.note);
    return { ok: true };
  });
}

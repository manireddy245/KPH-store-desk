import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, requirePerm } from '../services/common.js';
import { cancelPurchase, createPurchase, getPurchase, findDuplicatePurchase, listPurchases } from '../services/purchases.js';
import { readScanPage, scanBill, type ModelCaller } from '../services/scanner.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function registerPurchaseRoutes(app: FastifyInstance, { db, live }: Shared, opts: { scanner?: ModelCaller } = {}) {
  /** Read a supplier bill from photos / a PDF. Returns a draft; nothing is saved to stock. */
  app.post('/api/purchases/scan', async (req) => {
    const b = z
      .object({
        supplierId: z.number().int().positive().nullable().optional(),
        pages: z.array(z.object({ mimeType: z.string(), base64: z.string().min(10) })).min(1).max(6),
      })
      .parse(req.body);
    return scanBill(db.app, ctxOf(req), { pages: b.pages, scanDir: db.scanDir, supplierId: b.supplierId, caller: opts.scanner });
  });

  app.get('/api/purchases/scans/:scanId/pages/:n', async (req, reply) => {
    requirePerm(ctxOf(req), 'stock.adjust');
    const p = z.object({ scanId: id, n: z.coerce.number().int().min(1) }).parse(req.params);
    const [s] = await db.app<{ page_files: string[] }[]>`select page_files from purchase_scans where id = ${p.scanId}`;
    const rel = s?.page_files?.[p.n - 1];
    if (!rel) throw new AppError(404, 'NOT_FOUND', 'Page not found');
    const type = rel.endsWith('.pdf') ? 'application/pdf' : rel.endsWith('.png') ? 'image/png' : rel.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return reply.header('content-type', type).header('cache-control', 'private, max-age=86400').send(readScanPage(db.scanDir, rel));
  });

  app.post('/api/purchases', async (req) => {
    const line = z.object({
      productId: z.number().int().positive().optional(),
      newProduct: z
        .object({ name: z.string().min(2), sku: z.string().optional(), unitCode: z.string().min(1), hsn: z.string().nullable().optional(), categoryId: z.number().int().nullable().optional(), salePricePaise: z.number().int().min(0).optional() })
        .optional(),
      description: z.string().max(300).optional(),
      qtyMilli: z.number().int().positive(),
      unitCode: z.string().optional(),
      baseQtyMilli: z.number().int().positive().optional(),
      taxablePaise: z.number().int().min(0).optional(),
      amountPaise: z.number().int().min(0).optional(),
      amountMode: z.enum(['excl', 'incl']).optional(),
      gstRateBp: z.number().int().min(0).max(10000),
      hsn: z.string().nullable().optional(),
      batchCode: z.string().max(40).nullable().optional(),
      packedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    });
    const b = z
      .object({
        clientRef: z.uuid().optional(),
        supplierId: z.number().int().positive(),
        supplierInvoiceNo: z.string().min(1).max(40),
        supplierInvoiceDate: date,
        supplyType: z.enum(['intra', 'inter']).optional(),
        freightPaise: z.number().int().min(0).optional(),
        billTotalPaise: z.number().int().min(0).optional(),
        notes: z.string().max(500).optional(),
        scanId: z.number().int().positive().optional(),
        updateCostPrice: z.boolean().optional(),
        lines: z.array(line).min(1).max(200),
      })
      .parse(req.body);
    const r = await createPurchase(db.app, ctxOf(req), b);
    if (!r.duplicate) {
      live.broadcast({ type: 'stock.changed', productIds: [] });
      live.broadcast({ type: 'products.changed' });
      live.broadcast({ type: 'suppliers.changed' });
    }
    return r;
  });

  app.get('/api/purchases', async (req) => {
    requirePerm(ctxOf(req), 'stock.adjust');
    const q = z.object({ from: date.optional(), to: date.optional(), supplierId: id.optional(), search: z.string().optional() }).parse(req.query);
    return listPurchases(db.app, q);
  });

  app.get('/api/purchases/duplicate-check', async (req) => {
    requirePerm(ctxOf(req), 'stock.adjust');
    const q = z
      .object({ supplierId: id.optional(), billNo: z.string().max(60).optional(), billDate: date.optional(), totalPaise: z.coerce.number().int().optional(), scanId: id.optional() })
      .parse(req.query);
    return { duplicate: await findDuplicatePurchase(db.app, q) };
  });

  app.get('/api/purchases/:id', async (req) => {
    requirePerm(ctxOf(req), 'stock.adjust');
    return getPurchase(db.app, z.object({ id }).parse(req.params).id);
  });

  app.post('/api/purchases/:id/cancel', async (req) => {
    const b = z.object({ reason: z.string(), overrideToken: z.string().optional() }).parse(req.body);
    const r = await cancelPurchase(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'stock.changed', productIds: [] });
    live.broadcast({ type: 'suppliers.changed' });
    return r;
  });
}

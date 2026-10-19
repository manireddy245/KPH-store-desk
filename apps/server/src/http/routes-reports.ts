import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { periodRange } from '@kph/core';
import { AppError } from '../services/common.js';
import { ewayJson, ewayPending, ewayStatus, saveTransport } from '../services/eway.js';
import { discountXlsx, gstr1Xlsx, gstr3bXlsx, purchaseRegisterXlsx, salesRegisterXlsx } from '../services/exports.js';
import { discountReport, gstr1, gstr3b, purchaseRegister, salesRegister, type Range } from '../services/reports.js';
import { getSettings } from '../services/settings.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z.object({ period: z.string().optional(), from: date.optional(), to: date.optional(), format: z.enum(['json', 'xlsx']).optional() });

/** ?period=2026-10 or ?period=2026-Q3 or ?from=…&to=… */
function rangeOf(query: unknown): Range & { format: 'json' | 'xlsx'; tag: string } {
  const q = rangeQuery.parse(query);
  const format = q.format ?? 'json';
  if (q.period) {
    try {
      const r = periodRange(q.period);
      return { from: r.from, to: r.to, format, tag: q.period };
    } catch (e) {
      throw new AppError(400, 'BAD_RANGE', (e as Error).message);
    }
  }
  if (!q.from || !q.to) throw new AppError(400, 'BAD_RANGE', 'Choose a month, a quarter or a date range');
  return { from: q.from, to: q.to, format, tag: `${q.from}_to_${q.to}` };
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sendFile = (reply: FastifyReply, name: string, type: string, body: Buffer | string) =>
  reply.header('content-type', type).header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store').send(body);

export async function registerReportRoutes(app: FastifyInstance, { db }: Shared) {
  const shop = async () => (await getSettings(db.app)).storeName;

  app.get('/api/reports/sales-register', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await salesRegister(db.app, ctxOf(req), r);
    return r.format === 'xlsx' ? sendFile(reply, `sales-register_${r.tag}.xlsx`, XLSX, await salesRegisterXlsx(d, await shop())) : d;
  });

  app.get('/api/reports/purchase-register', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await purchaseRegister(db.app, ctxOf(req), r);
    return r.format === 'xlsx' ? sendFile(reply, `purchase-register_${r.tag}.xlsx`, XLSX, await purchaseRegisterXlsx(d, await shop())) : d;
  });

  app.get('/api/reports/gstr1', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await gstr1(db.app, ctxOf(req), r);
    return r.format === 'xlsx' ? sendFile(reply, `GSTR-1_${r.tag}.xlsx`, XLSX, await gstr1Xlsx(d)) : d;
  });

  app.get('/api/reports/gstr3b', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await gstr3b(db.app, ctxOf(req), r);
    return r.format === 'xlsx' ? sendFile(reply, `GSTR-3B_${r.tag}.xlsx`, XLSX, await gstr3bXlsx(d, await shop())) : d;
  });

  app.get('/api/reports/discounts', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await discountReport(db.app, ctxOf(req), r);
    return r.format === 'xlsx' ? sendFile(reply, `discounts_${r.tag}.xlsx`, XLSX, await discountXlsx(d, await shop())) : d;
  });

  // ---------------------------------------------------------------- e-way bills
  app.get('/api/reports/eway-pending', async (req) => ewayPending(db.app, ctxOf(req), rangeOf(req.query)));

  app.get('/api/invoices/:id/eway', async (req) => ewayStatus(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));

  app.put('/api/invoices/:id/transport', async (req) => {
    const b = z
      .object({
        toPlace: z.string().max(50).nullable().optional(),
        toPincode: z.string().max(6).nullable().optional(),
        distanceKm: z.number().nullable().optional(),
        transMode: z.enum(['road', 'rail', 'air', 'ship']).optional(),
        vehicleNo: z.string().max(20).nullable().optional(),
        transporterId: z.string().max(15).nullable().optional(),
        transporterName: z.string().max(100).nullable().optional(),
        ewbNo: z.string().max(14).nullable().optional(),
        ewbDate: date.nullable().optional(),
        notNeededReason: z.string().max(200).nullable().optional(),
      })
      .parse(req.body);
    return saveTransport(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
  });

  app.get('/api/invoices/:id/eway.json', async (req, reply) => {
    const invId = z.object({ id }).parse(req.params).id;
    const j = await ewayJson(db.app, ctxOf(req), invId);
    const no = j.billLists[0]!.docNo.replace(/[^A-Za-z0-9-]/g, '-');
    return sendFile(reply, `eway-bill_${no}.json`, 'application/json', JSON.stringify(j, null, 2));
  });
}

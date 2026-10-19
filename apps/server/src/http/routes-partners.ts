import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { istDate, periodRange } from '@kph/core';
import { AppError, can } from '../services/common.js';
import { workbook } from '../services/exports.js';
import {
  addNote,
  addShade,
  addSite,
  createPartner,
  listPartners,
  listShades,
  listTypes,
  partnerProfile,
  partnerReport,
  payReward,
  saveType,
  setRules,
  tagInvoice,
  updatePartner,
  updateSite,
} from '../services/partners.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function rangeOf(query: unknown) {
  const q = z.object({ period: z.string().optional(), from: date.optional(), to: date.optional() }).passthrough().parse(query);
  if (q.period) {
    try {
      const r = periodRange(q.period);
      return { from: r.from, to: r.to };
    } catch (e) {
      throw new AppError(400, 'BAD_RANGE', (e as Error).message);
    }
  }
  const to = q.to ?? istDate();
  return { from: q.from ?? `${to.slice(0, 8)}01`, to };
}

const partnerBody = z.object({
  name: z.string().max(100).optional(),
  phone: z.string().max(20).nullable().optional(),
  area: z.string().max(100).nullable().optional(),
  typeId: z.number().int().positive().optional(),
  notes: z.string().max(1000).nullable().optional(),
  joinedOn: date.optional(),
  active: z.boolean().optional(),
  customerId: z.number().int().positive().nullable().optional(),
  language: z.enum(['te', 'en']).nullable().optional(),
});

const shadeBody = z.object({
  partnerId: z.number().int().positive().nullable().optional(),
  customerId: z.number().int().positive().nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
  productId: z.number().int().positive().nullable().optional(),
  base: z.string().max(100).optional(),
  tint: z.string().max(200).optional(),
  shadeCode: z.string().max(60).optional(),
  shadeName: z.string().max(100).optional(),
  quantity: z.string().max(60).optional(),
  shadeDate: date.optional(),
  note: z.string().max(500).optional(),
});

export async function registerPartnerRoutes(app: FastifyInstance, { db, live }: Shared) {
  const changed = () => live.broadcast({ type: 'partners.changed' });
  const canSee = (req: Parameters<typeof ctxOf>[0]) => {
    const ctx = ctxOf(req);
    if (!can(ctx, 'partners.manage') && !can(ctx, 'reports.view') && !can(ctx, 'billing.create')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see partners');
    return ctx;
  };

  app.get('/api/partner-types', async (req) => {
    canSee(req);
    return listTypes(db.app);
  });
  app.post('/api/partner-types', async (req) => {
    const b = z.object({ name: z.string().max(50) }).parse(req.body);
    const r = await saveType(db.app, ctxOf(req), null, b);
    changed();
    return r;
  });
  app.patch('/api/partner-types/:id', async (req) => {
    const b = z.object({ name: z.string().max(50).optional(), active: z.boolean().optional() }).parse(req.body);
    const r = await saveType(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    changed();
    return r;
  });
  app.put('/api/partner-types/:id/rules', async (req) => {
    const b = z.object({ rules: z.array(z.object({ categoryId: z.number().int().positive().nullable(), mode: z.enum(['percent', 'per_unit']), value: z.number().int().min(0) })).max(100) }).parse(req.body);
    const r = await setRules(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b.rules);
    changed();
    return r;
  });

  app.get('/api/partners', async (req) => {
    canSee(req);
    const q = z.object({ search: z.string().optional(), typeId: id.optional(), includeInactive: z.coerce.boolean().optional() }).parse(req.query);
    const r = rangeOf(req.query);
    return listPartners(db.app, { ...q, ...r });
  });
  app.post('/api/partners', async (req) => {
    const b = partnerBody.extend({ name: z.string().min(2).max(100), typeId: z.number().int().positive() }).parse(req.body);
    const r = await createPartner(db.app, ctxOf(req), b);
    changed();
    return r;
  });
  app.patch('/api/partners/:id', async (req) => {
    const r = await updatePartner(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, partnerBody.parse(req.body));
    changed();
    return r;
  });
  app.get('/api/partners/:id', async (req) => partnerProfile(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, rangeOf(req.query)));

  app.post('/api/partners/:id/sites', async (req) => {
    const b = z.object({ name: z.string().max(100), address: z.string().max(300).optional(), ownerName: z.string().max(100).optional() }).parse(req.body);
    const r = await addSite(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    changed();
    return r;
  });
  app.patch('/api/partner-sites/:id', async (req) => {
    const b = z.object({ name: z.string().max(100).optional(), address: z.string().max(300).nullable().optional(), ownerName: z.string().max(100).nullable().optional(), active: z.boolean().optional() }).parse(req.body);
    return updateSite(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
  });
  app.post('/api/partners/:id/notes', async (req) => {
    const b = z.object({ note: z.string().max(2000), invoiceId: z.number().int().positive().nullable().optional(), siteId: z.number().int().positive().nullable().optional() }).parse(req.body);
    return addNote(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
  });
  app.post('/api/partners/:id/rewards', async (req) => {
    const b = z.object({ amountPaise: z.number().int().positive(), how: z.enum(['payout', 'redeemed']), fromLedgerId: z.number().int().positive().optional(), note: z.string().max(300).optional(), clientRef: z.uuid().optional() }).parse(req.body);
    const r = await payReward(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b, { fileDir: join(db.scanDir, 'expenses') });
    changed();
    return r;
  });

  /** Tag a partner on a bill after it was made. */
  app.post('/api/invoices/:id/partner', async (req) => {
    const b = z.object({ partnerId: z.number().int().positive(), siteId: z.number().int().positive().nullable().optional() }).parse(req.body);
    const r = await tagInvoice(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b.partnerId, b.siteId ?? null);
    changed();
    return r;
  });

  app.get('/api/shades', async (req) => {
    canSee(req);
    const q = z.object({ partnerId: id.optional(), customerId: id.optional(), search: z.string().optional() }).parse(req.query);
    return listShades(db.app, q);
  });
  app.post('/api/shades', async (req) => addShade(db.app, ctxOf(req), shadeBody.parse(req.body)));

  app.get('/api/reports/partners', async (req, reply) => {
    const q = z.object({ format: z.enum(['json', 'xlsx']).optional() }).passthrough().parse(req.query);
    const r = rangeOf(req.query);
    const d = await partnerReport(db.app, ctxOf(req), r);
    if (q.format !== 'xlsx') return d;
    const buf = await workbook([
      {
        name: 'Top partners',
        title: [`Partners ${r.from} to ${r.to}`],
        columns: [{ header: 'Partner', width: 28 }, { header: 'Type' }, { header: 'Phone' }, { header: 'Area' }, { header: 'Bills', kind: 'int' }, { header: 'Sales', kind: 'money' }, { header: 'Reward balance', kind: 'money' }],
        rows: d.top.map((p) => [p.name, p.type_name, p.phone, p.area, p.bills, p.sales_paise, p.reward_balance_paise]),
        totals: [5],
      },
      {
        name: 'Inactive',
        title: ['Partners with no bill for 30 days or more'],
        columns: [{ header: 'Partner', width: 28 }, { header: 'Type' }, { header: 'Phone' }, { header: 'Last bill', kind: 'date' }, { header: 'Days', kind: 'int' }],
        rows: d.inactive.map((p) => [p.name, p.type_name, p.phone, p.last_bill, p.days_since]),
      },
      {
        name: 'By category',
        title: [`Partner-wise sales by category, ${r.from} to ${r.to}`],
        columns: [{ header: 'Partner', width: 28 }, { header: 'Category', width: 24 }, { header: 'Sales (before GST)', kind: 'money' }],
        rows: d.byCategory.map((x) => [x.partner, x.category, x.amount]),
      },
    ]);
    return reply.header('content-type', XLSX).header('content-disposition', `attachment; filename="partners_${r.from}_${r.to}.xlsx"`).send(buf);
  });
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { istDate, periodRange } from '@kph/core';
import {
  cancelEntry,
  cashPosition,
  closeCash,
  createContra,
  createExpense,
  createJournal,
  createLedger,
  dayBook,
  getEntry,
  ledgerStatement,
  listEntries,
  listGroups,
  listLedgers,
  lockOpening,
  openingBalances,
  outstandingPurchases,
  paySupplier,
  setOpening,
  supplierAgeing,
  trialBalance,
  updateLedger,
} from '../services/accounts.js';
import { AppError, can, requirePerm } from '../services/common.js';
import { workbook } from '../services/exports.js';
import { getSettings } from '../services/settings.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paise = z.number().int();
const kind = z.enum(['cash', 'bank', 'clearing', 'expense', 'income', 'capital', 'other']);
const common = { clientRef: z.uuid().optional(), date: date.optional(), reference: z.string().max(100).optional(), narration: z.string().max(500).optional() };

function rangeOf(query: unknown) {
  const q = z.object({ period: z.string().optional(), from: date.optional(), to: date.optional(), format: z.enum(['json', 'xlsx']).optional() }).parse(query);
  if (q.period) {
    try {
      return { ...periodRange(q.period), format: q.format ?? 'json' };
    } catch (e) {
      throw new AppError(400, 'BAD_RANGE', (e as Error).message);
    }
  }
  const to = q.to ?? istDate();
  const from = q.from ?? `${to.slice(0, 8)}01`;
  if (from > to) throw new AppError(400, 'BAD_RANGE', 'Choose a valid date range');
  return { from, to, format: q.format ?? 'json' };
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sendXlsx = (reply: FastifyReply, name: string, body: Buffer) =>
  reply.header('content-type', XLSX).header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store').send(body);

export async function registerAccountRoutes(app: FastifyInstance, { db, live }: Shared) {
  const fileDir = () => join(db.scanDir, 'expenses');
  const changed = () => live.broadcast({ type: 'accounts.changed' });

  // ---------------------------------------------------------------- ledgers
  app.get('/api/ledgers', async (req) => {
    const ctx = ctxOf(req);
    const q = z.object({ kind: kind.optional(), includeParties: z.coerce.boolean().optional() }).parse(req.query);
    // money and expense accounts are needed by anyone entering payments / expenses; the full list is for reports
    if (!can(ctx, 'reports.view') && !(q.kind && ['cash', 'bank', 'clearing', 'expense'].includes(q.kind) && (can(ctx, 'payments.make') || can(ctx, 'expenses.create') || can(ctx, 'payments.receive'))))
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see the accounts');
    const rows = await listLedgers(db.app, q);
    if (!can(ctx, 'reports.view')) for (const r of rows) r.balance_paise = 0;
    return rows;
  });
  app.get('/api/ledger-groups', async (req) => {
    requirePerm(ctxOf(req), 'reports.view');
    return listGroups(db.app);
  });
  app.post('/api/ledgers', async (req) => {
    const b = z.object({ name: z.string().max(80), groupId: z.number().int().positive().optional(), kind, details: z.record(z.string(), z.string().max(100)).optional() }).parse(req.body);
    const r = await createLedger(db.app, ctxOf(req), b);
    changed();
    return r;
  });
  app.patch('/api/ledgers/:id', async (req) => {
    const b = z.object({ name: z.string().max(80).optional(), active: z.boolean().optional(), details: z.record(z.string(), z.string().max(100)).optional() }).parse(req.body);
    const r = await updateLedger(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    changed();
    return r;
  });

  app.get('/api/ledgers/:id/statement', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await ledgerStatement(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, r);
    if (r.format !== 'xlsx') return d;
    const shop = (await getSettings(db.app)).storeName;
    const rs = (p: number) => p;
    const buf = await workbook([
      {
        name: 'Statement',
        title: [`${shop} — ${d.ledger.name}`, `${r.from} to ${r.to}`],
        columns: [{ header: 'Date', kind: 'date' }, { header: 'Type' }, { header: 'Particulars', width: 50 }, { header: 'Debit', kind: 'money' }, { header: 'Credit', kind: 'money' }, { header: 'Balance (Dr +)', kind: 'money' }],
        rows: [
          [r.from, 'Opening', null, null, null, rs(d.openingPaise)],
          ...d.entries.map((e) => [e.vdate, e.vtype, [e.narration, e.other].filter(Boolean).join(' · '), e.dr_paise || null, e.cr_paise || null, e.balance_paise]),
          [r.to, 'Closing', null, d.totalDrPaise, d.totalCrPaise, d.closingPaise],
        ],
      },
    ]);
    return sendXlsx(reply, `${d.ledger.name.replace(/[^\w-]+/g, '_')}_${r.from}_${r.to}.xlsx`, buf);
  });

  // ---------------------------------------------------------------- books
  app.get('/api/books/day', async (req, reply) => {
    const r = rangeOf(req.query);
    const d = await dayBook(db.app, ctxOf(req), r);
    if (r.format !== 'xlsx') return d;
    const rows: unknown[][] = [];
    for (const v of d.vouchers) for (const [i, l] of (v.lines ?? []).entries()) rows.push([i === 0 ? v.vdate : null, i === 0 ? v.vtype : null, i === 0 ? v.narration : null, l.ledger, l.dr || null, l.cr || null]);
    const buf = await workbook([{ name: 'Day Book', title: [`Day Book`, `${r.from} to ${r.to}`], columns: [{ header: 'Date', kind: 'date' }, { header: 'Type' }, { header: 'Narration', width: 50 }, { header: 'Account', width: 30 }, { header: 'Debit', kind: 'money' }, { header: 'Credit', kind: 'money' }], rows, totals: [4, 5] }]);
    return sendXlsx(reply, `day-book_${r.from}_${r.to}.xlsx`, buf);
  });

  app.get('/api/books/trial-balance', async (req, reply) => {
    const q = z.object({ asOf: date.optional(), format: z.enum(['json', 'xlsx']).optional() }).parse(req.query);
    const d = await trialBalance(db.app, ctxOf(req), q.asOf ?? istDate());
    if (q.format !== 'xlsx') return d;
    const rows: unknown[][] = [];
    for (const g of d.groups) {
      rows.push([g.group, null, null]);
      for (const a of g.accounts) rows.push([`    ${a.name}`, a.dr || null, a.cr || null]);
    }
    rows.push(['Total', d.totalDrPaise, d.totalCrPaise]);
    const buf = await workbook([{ name: 'Trial Balance', title: [`Trial balance as on ${d.asOf}`], columns: [{ header: 'Account', width: 50 }, { header: 'Debit', kind: 'money' }, { header: 'Credit', kind: 'money' }], rows }]);
    return sendXlsx(reply, `trial-balance_${d.asOf}.xlsx`, buf);
  });

  app.get('/api/reports/supplier-ageing', async (req, reply) => {
    const q = z.object({ asOf: date.optional(), format: z.enum(['json', 'xlsx']).optional() }).parse(req.query);
    const d = await supplierAgeing(db.app, ctxOf(req), q.asOf);
    if (q.format !== 'xlsx') return d;
    const buf = await workbook([
      {
        name: 'Supplier ageing',
        title: [`What we owe suppliers, as on ${d.asOf}`],
        columns: [{ header: 'Supplier', width: 32 }, { header: 'Phone' }, { header: 'We owe', kind: 'money' }, { header: '0–30 days', kind: 'money' }, { header: '31–60 days', kind: 'money' }, { header: '61–90 days', kind: 'money' }, { header: 'Over 90 days', kind: 'money' }, { header: 'Oldest unpaid bill', kind: 'date' }],
        rows: d.suppliers.map((s) => [s.name, s.phone, s.owePaise, ...s.buckets, s.oldestDue]),
        totals: [2, 3, 4, 5, 6],
      },
    ]);
    return sendXlsx(reply, `supplier-ageing_${d.asOf}.xlsx`, buf);
  });

  // ---------------------------------------------------------------- money entries
  app.get('/api/money', async (req) => {
    const q = z.object({ kind: z.enum(['payment', 'expense', 'contra', 'journal']).optional(), from: date.optional(), to: date.optional(), supplierId: id.optional() }).parse(req.query);
    return listEntries(db.app, ctxOf(req), q);
  });
  app.get('/api/money/:id', async (req) => getEntry(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));
  app.get('/api/money/:id/file', async (req, reply) => {
    const e = await getEntry(db.app, ctxOf(req), z.object({ id }).parse(req.params).id);
    const file = e.file as string | null;
    if (!file || !/^\d{4}-\d{2}\/exp-\d+-\d+\.(jpg|png|pdf)$/.test(file)) throw new AppError(404, 'NOT_FOUND', 'No photo for this entry');
    const type = file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return reply.header('content-type', type).header('cache-control', 'private, max-age=86400').send(readFileSync(join(fileDir(), file)));
  });
  app.post('/api/money/:id/cancel', async (req) => {
    const b = z.object({ reason: z.string(), overrideToken: z.string().optional() }).parse(req.body);
    const r = await cancelEntry(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    changed();
    live.broadcast({ type: 'suppliers.changed' });
    return r;
  });

  app.get('/api/suppliers/:id/outstanding', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx, 'payments.make') && !can(ctx, 'reports.view') && !can(ctx, 'stock.adjust')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see this');
    return outstandingPurchases(db.app, z.object({ id }).parse(req.params).id);
  });

  app.post('/api/money/payments', async (req) => {
    const b = z
      .object({ ...common, supplierId: z.number().int().positive(), fromLedgerId: z.number().int().positive(), amountPaise: paise.positive(), allocations: z.array(z.object({ purchaseId: z.number().int().positive(), amountPaise: paise.positive() })).max(200).optional() })
      .parse(req.body);
    const r = await paySupplier(db.app, ctxOf(req), b);
    changed();
    live.broadcast({ type: 'suppliers.changed' });
    return r;
  });

  app.post('/api/money/expenses', async (req) => {
    const b = z
      .object({
        ...common,
        ledgerId: z.number().int().positive(),
        fromLedgerId: z.number().int().positive(),
        amountPaise: paise.positive(),
        gstRateBp: z.number().int().min(0).max(2800).nullable().optional(),
        interState: z.boolean().optional(),
        vendorName: z.string().max(100).optional(),
        vendorGstin: z.string().max(15).optional(),
        vendorBillNo: z.string().max(40).optional(),
        photo: z.object({ mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf']), base64: z.string().min(10).max(16_000_000) }).optional(),
      })
      .parse(req.body);
    const r = await createExpense(db.app, ctxOf(req), b, { fileDir: fileDir() });
    changed();
    return r;
  });

  app.post('/api/money/contra', async (req) => {
    const b = z.object({ ...common, fromLedgerId: z.number().int().positive(), toLedgerId: z.number().int().positive(), amountPaise: paise.positive(), chargesPaise: paise.min(0).optional() }).parse(req.body);
    const r = await createContra(db.app, ctxOf(req), b);
    changed();
    return r;
  });

  app.post('/api/money/journals', async (req) => {
    const b = z.object({ ...common, lines: z.array(z.object({ ledgerId: z.number().int().positive(), drPaise: paise.min(0).optional(), crPaise: paise.min(0).optional() })).min(2).max(50) }).parse(req.body);
    const r = await createJournal(db.app, ctxOf(req), b);
    changed();
    live.broadcast({ type: 'customers.changed' });
    live.broadcast({ type: 'suppliers.changed' });
    return r;
  });

  // ---------------------------------------------------------------- cash closing
  app.get('/api/cash/position', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx, 'payments.receive') && !can(ctx, 'payments.make')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to see the cash position');
    return cashPosition(db.app, z.object({ date: date.optional() }).parse(req.query).date ?? istDate());
  });
  app.post('/api/cash/close', async (req) => {
    const b = z.object({ date: date.optional(), countedPaise: paise.min(0).optional(), denominations: z.record(z.string(), z.number().int().min(0)).optional(), note: z.string().max(300).optional(), bookDifference: z.boolean().optional() }).parse(req.body);
    const r = await closeCash(db.app, ctxOf(req), b);
    changed();
    return r;
  });

  // ---------------------------------------------------------------- opening balances
  app.get('/api/opening', async (req) => openingBalances(db.app, ctxOf(req)));
  app.put('/api/opening', async (req) => {
    const b = z.object({ openingDate: date.optional(), ledgers: z.array(z.object({ ledgerId: z.number().int().positive(), drPaise: paise })).max(500).optional() }).parse(req.body);
    return setOpening(db.app, ctxOf(req), b);
  });
  app.post('/api/opening/lock', async (req) => {
    const r = await lockOpening(db.app, ctxOf(req));
    changed();
    return r;
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { istDate } from '@kph/core';
import { openCreditBills } from '../services/billing.js';
import { AppError, can } from '../services/common.js';
import { workbook } from '../services/exports.js';
import { customerAgeing, customerDues, customerStatementRange, dueList, listReminders, makeReminder } from '../services/khata.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function registerKhataRoutes(app: FastifyInstance, { db }: Shared) {
  app.get('/api/khata/ageing', async (req, reply) => {
    const q = z.object({ asOf: date.optional(), format: z.enum(['json', 'xlsx']).optional() }).parse(req.query);
    const d = await customerAgeing(db.app, ctxOf(req), q.asOf ?? istDate());
    if (q.format !== 'xlsx') return d;
    const buf = await workbook([
      {
        name: 'Customer dues',
        title: [`What customers owe, as on ${d.asOf}`],
        columns: [
          { header: 'Customer', width: 32 }, { header: 'Phone' }, { header: 'Balance', kind: 'money' }, { header: 'Overdue', kind: 'money' },
          { header: '0–30 days', kind: 'money' }, { header: '31–60 days', kind: 'money' }, { header: '61–90 days', kind: 'money' }, { header: 'Over 90 days', kind: 'money' },
          { header: 'Credit limit', kind: 'money' }, { header: 'Oldest bill', kind: 'date' }, { header: 'Last payment', kind: 'date' },
        ],
        rows: d.customers.filter((c) => c.balancePaise > 0).map((c) => [c.name, c.phone, c.balancePaise, c.overduePaise, ...c.buckets, c.creditLimitPaise, c.oldest?.date ?? null, c.lastReceipt]),
        totals: [2, 3, 4, 5, 6, 7],
      },
    ]);
    return reply.header('content-type', XLSX).header('content-disposition', `attachment; filename="customer-dues_${d.asOf}.xlsx"`).send(buf);
  });

  app.get('/api/khata/due', async (req) => dueList(db.app, ctxOf(req)));

  app.get('/api/customers/:id/dues', async (req) => customerDues(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));

  /** Unpaid credit bills, for marking a payment against them. */
  app.get('/api/customers/:id/open-bills', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx, 'payments.receive') && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see this');
    return (await openCreditBills(db.app, z.object({ id }).parse(req.params).id)).filter((b) => b.due_paise > 0);
  });

  app.get('/api/customers/:id/statement', async (req, reply) => {
    const q = z.object({ from: date.optional(), to: date.optional(), format: z.enum(['json', 'xlsx']).optional() }).parse(req.query);
    const to = q.to ?? istDate();
    const d = await customerStatementRange(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, { from: q.from ?? fyStart(to), to });
    if (q.format !== 'xlsx') return d;
    const buf = await workbook([
      {
        name: 'Statement',
        title: [`${d.store.name} — statement of account`, `${d.customer.name}${d.customer.phone ? ` · ${d.customer.phone}` : ''}`, `${d.from} to ${d.to}`],
        columns: [{ header: 'Date', kind: 'date' }, { header: 'Details', width: 22 }, { header: 'No', width: 18 }, { header: 'Debit (bill)', kind: 'money' }, { header: 'Credit (paid / returned)', kind: 'money' }, { header: 'Balance', kind: 'money' }],
        rows: [[d.from, 'Opening balance', null, null, null, d.openingPaise], ...d.entries.map((e) => [e.date, e.type, e.doc, e.debitPaise || null, e.creditPaise || null, e.balancePaise]), [d.to, 'Closing balance', null, d.totalDebitPaise, d.totalCreditPaise, d.closingPaise]],
      },
    ]);
    return reply.header('content-type', XLSX).header('content-disposition', `attachment; filename="statement_${d.customer.name.replace(/[^\w-]+/g, '_')}_${d.from}_${d.to}.xlsx"`).send(buf);
  });

  app.post('/api/customers/:id/reminders', async (req) => {
    const b = z.object({ language: z.enum(['te', 'en']).optional(), channel: z.enum(['whatsapp', 'call', 'visit', 'sms']).optional(), note: z.string().max(300).optional() }).parse(req.body ?? {});
    return makeReminder(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
  });
  app.get('/api/customers/:id/reminders', async (req) => listReminders(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));
}

/** 1 April of the financial year a date falls in. */
function fyStart(d: string) {
  const y = Number(d.slice(0, 4));
  return Number(d.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
}

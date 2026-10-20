import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { istDate } from '@kph/core';
import { requirePerm } from '../services/common.js';
import { getDailySummary, listDailySummaries, makeDailySummary, ownerDay } from '../services/owner.js';
import { ctxOf, type Shared } from './app.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function registerOwnerRoutes(app: FastifyInstance, { db }: Shared) {
  app.get('/api/owner/today', async (req) => ownerDay(db.app, ctxOf(req), z.object({ date: date.optional() }).parse(req.query).date ?? istDate()));
  app.get('/api/owner/summary', async (req) => getDailySummary(db.app, ctxOf(req), z.object({ date: date.optional() }).parse(req.query).date ?? istDate()));
  app.post('/api/owner/summary', async (req) => {
    requirePerm(ctxOf(req), 'reports.view');
    return makeDailySummary(db.app, z.object({ date: date.optional() }).parse(req.body ?? {}).date ?? istDate());
  });
  app.get('/api/owner/summaries', async (req) => listDailySummaries(db.app, ctxOf(req)));
}

import { existsSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { WorkspaceName } from '../config.js';
import type { Sql } from '../db/connect.js';
import { getDevice, getSession, type SessionInfo } from '../services/auth.js';
import { AppError, type Ctx } from '../services/common.js';
import { Realtime } from './realtime.js';
import { registerAdminRoutes } from './routes-admin.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerCatalogRoutes } from './routes-catalog.js';
import { registerPurchaseRoutes } from './routes-purchases.js';
import { registerAssistantRoutes } from './routes-assistant.js';
import { registerReportRoutes } from './routes-reports.js';
import { registerAccountRoutes } from './routes-accounts.js';
import type { AssistantModel } from '../services/assistant.js';
import { registerReturnRoutes } from './routes-returns.js';
import { registerSalesRoutes } from './routes-sales.js';
import type { ModelCaller } from '../services/scanner.js';

/** What the HTTP layer needs from the database side. Workspaces implements it; tests pass a fixed one. */
export interface DbProvider {
  name: WorkspaceName;
  app: Sql;
  owner: Sql;
  backupDir: string;
  /** Where scanned supplier bills (photos, PDFs) are kept. */
  scanDir: string;
  open?(name: WorkspaceName): Promise<void>;
  resetSample?(): Promise<void>;
}

export type AuthLevel = 'public' | 'device' | 'user';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthLevel;
  }
  interface FastifyRequest {
    device: { id: number; name: string; status: string } | null;
    session: SessionInfo | null;
    sessionToken: string | null;
  }
}

export function ctxOf(req: FastifyRequest): Ctx {
  if (!req.session) throw new AppError(401, 'NOT_LOGGED_IN', 'Please log in');
  return { userId: req.session.userId, deviceId: req.device?.id ?? null, permissions: req.session.permissions };
}

export interface AppDeps {
  db: DbProvider;
  webDist?: string;
  logger?: boolean;
  /** Replace the Gemini call (tests). */
  scanner?: ModelCaller;
  /** Replace the assistant's Gemini call (tests). */
  assistant?: AssistantModel;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ? { level: 'warn' } : false, bodyLimit: 30 * 1024 * 1024, trustProxy: true });
  const live = new Realtime();
  app.decorateRequest('device', null);
  app.decorateRequest('session', null);
  app.decorateRequest('sessionToken', null);

  await app.register(fastifyWebsocket);

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const level: AuthLevel = req.routeOptions.config?.auth ?? 'user';
    const sql = deps.db.app;
    const deviceToken = req.headers['x-device-token'];
    if (typeof deviceToken === 'string' && deviceToken) req.device = await getDevice(sql, deviceToken);
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && req.device?.status === 'approved') {
      req.sessionToken = auth.slice(7);
      req.session = await getSession(sql, req.sessionToken, req.device.id);
    }
    if (level === 'public') return;
    if (!req.device) throw new AppError(401, 'DEVICE_UNKNOWN', 'This computer is not registered');
    if (req.device.status !== 'approved')
      throw new AppError(403, 'DEVICE_NOT_APPROVED', req.device.status === 'revoked' ? 'This computer has been blocked by admin' : 'This computer is waiting for admin approval');
    if (level === 'user' && !req.session) throw new AppError(401, 'NOT_LOGGED_IN', 'Your session has ended. Please log in again.');
  });

  app.setErrorHandler((err: unknown, req, reply: FastifyReply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ code: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.status(400).send({ code: 'BAD_INPUT', message: `${issue?.path.join('.') || 'input'}: ${issue?.message}`, details: err.issues });
    }
    const e = err as { code?: string; message?: string; statusCode?: number };
    if (e.code === 'P0001') return reply.status(409).send({ code: 'NOT_ALLOWED', message: e.message });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ code: 'BAD_REQUEST', message: e.message });
    req.log.error(err);
    console.error('[error]', req.method, req.url, err);
    return reply.status(500).send({ code: 'SERVER_ERROR', message: 'Something went wrong on the server. Nothing was saved. Please try again.' });
  });

  app.get('/ws', { websocket: true, config: { auth: 'public' } }, async (socket, req) => {
    const q = req.query as { token?: string; device?: string };
    const device = q.device ? await getDevice(deps.db.app, q.device) : null;
    const session = device?.status === 'approved' && q.token ? await getSession(deps.db.app, q.token, device.id) : null;
    if (!session) return socket.close(4001, 'not logged in');
    live.add(socket);
  });

  const shared = { db: deps.db, live };
  await registerAuthRoutes(app, shared);
  await registerCatalogRoutes(app, shared);
  await registerSalesRoutes(app, shared);
  await registerAdminRoutes(app, shared);
  await registerPurchaseRoutes(app, shared, { scanner: deps.scanner });
  await registerAssistantRoutes(app, shared, { assistant: deps.assistant, scanner: deps.scanner });
  await registerReportRoutes(app, shared);
  await registerAccountRoutes(app, shared);
  await registerReturnRoutes(app, shared);

  app.get('/api/health', { config: { auth: 'public' } }, async () => ({ ok: true, workspace: deps.db.name, time: new Date().toISOString() }));

  if (deps.webDist && existsSync(deps.webDist)) {
    // wildcard routing (the default) looks files up on each request, so a rebuilt web app is served without a restart.
    await app.register(fastifyStatic, { root: deps.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => live.closeAll());
  return Object.assign(app, { live });
}

export type Shared = { db: DbProvider; live: Realtime };

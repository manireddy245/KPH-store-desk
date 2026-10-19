import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { inject } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_ROLES } from '@kph/core';
import { connect } from '../src/db/connect.js';
import { buildApp, type DbProvider } from '../src/http/app.js';
import { hashToken, newToken } from '../src/services/auth.js';
import type { Ctx } from '../src/services/common.js';
import { createUser } from '../src/services/users.js';
import type { ModelCaller } from '../src/services/scanner.js';
import type { AssistantModel } from '../src/services/assistant.js';

/** A running app on the shared test database, with an admin, a counter and a stock user logged in. */
export async function makeHarness(opts: { scanner?: ModelCaller; assistant?: AssistantModel } = {}) {
  const app = connect(inject('appUrl'), { max: 20 });
  const owner = connect(inject('ownerUrl'), { max: 2 });
  const db: DbProvider = { name: 'sample', app, owner, backupDir: join(inject('dataDir'), 'backups'), scanDir: join(inject('dataDir'), 'scans') };
  const server = await buildApp({ db, scanner: opts.scanner, assistant: opts.assistant });
  const tag = randomUUID().slice(0, 6);

  const deviceToken = newToken();
  const [d] = await app<{ id: number }[]>`
    insert into devices (name, token_hash, status) values (${'Counter ' + tag}, ${hashToken(deviceToken)}, 'approved') returning id`;
  const deviceId = d!.id;

  const users = {
    admin: { ...(await createUser(app, null, { name: `Admin ${tag}`, roleId: 'admin', pin: '1111' })), pin: '1111' },
    counter: { ...(await createUser(app, null, { name: `Counter ${tag}`, roleId: 'counter', pin: '2222' })), pin: '2222' },
    stock: { ...(await createUser(app, null, { name: `Stock ${tag}`, roleId: 'stock', pin: '3333' })), pin: '3333' },
  };

  async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, auth?: { token?: string; device?: string }) {
    const headers: Record<string, string> = { 'x-device-token': auth?.device ?? deviceToken };
    if (auth?.token) headers.authorization = `Bearer ${auth.token}`;
    const res = await server.inject({ method, url, payload: body as never, headers });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function loginAs(who: keyof typeof users) {
    const r = await call('POST', '/api/auth/login', { userId: users[who].id, pin: users[who].pin });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
    const token: string = r.body.token;
    return {
      token,
      get: (url: string) => call('GET', url, undefined, { token }),
      post: (url: string, body?: unknown) => call('POST', url, body ?? {}, { token }),
      patch: (url: string, body: unknown) => call('PATCH', url, body, { token }),
      put: (url: string, body: unknown) => call('PUT', url, body, { token }),
      del: (url: string) => call('DELETE', url, undefined, { token }),
    };
  }

  const ctx = (who: keyof typeof users): Ctx => ({
    userId: users[who].id,
    deviceId,
    permissions: who === 'admin' ? ALL_PERMISSIONS : DEFAULT_ROLES[who].permissions,
  });

  /** A product with stock, priced excl. GST. */
  async function product(opts: { price?: number; qty?: number; maxDisc?: { type: 'pct' | 'amt'; value: number } | null; cost?: number } = {}) {
    const sku = `T-${tag}-${randomUUID().slice(0, 8)}`;
    const [p] = await app<{ id: number }[]>`
      insert into products (sku, name, unit_code, gst_rate_bp, sale_price_paise, cost_price_paise, max_disc_type, max_disc_value)
      values (${sku}, ${'Test ' + sku}, 'bag', 1800, ${opts.price ?? 100000}, ${opts.cost ?? 80000},
              ${opts.maxDisc?.type ?? null}, ${opts.maxDisc?.value ?? null})
      returning id`;
    if ((opts.qty ?? 100) > 0) await app`insert into stock_movements (product_id, qty_milli, kind) values (${p!.id}, ${(opts.qty ?? 100) * 1000}, 'opening')`;
    return p!.id;
  }

  async function stockOf(productId: number) {
    const [r] = await app<{ q: number }[]>`select coalesce((select qty_milli from stock_balances where product_id = ${productId}), 0) as q`;
    return r!.q;
  }

  async function close() {
    await server.close();
    await app.end();
    await owner.end();
  }

  return { server, db, app, owner, users, deviceToken, deviceId, call, loginAs, ctx, product, stockOf, close, tag };
}

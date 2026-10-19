import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALL_PERMISSIONS, type Permission } from '@kph/core';
import {
  approveDevice,
  approveOverride,
  hashToken,
  login,
  logout,
  newToken,
  registerDevice,
  userCount,
  verifyUserPin,
} from '../services/auth.js';
import { AppError, audit } from '../services/common.js';
import { getSettings, setSettings } from '../services/settings.js';
import { createUser, loginTiles } from '../services/users.js';
import { ctxOf, type Shared } from './app.js';

const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits');

export async function registerAuthRoutes(app: FastifyInstance, { db }: Shared) {
  /** Everything a screen needs before login. */
  app.get('/api/bootstrap', { config: { auth: 'public' } }, async (req) => {
    const sql = db.app;
    const s = await getSettings(sql);
    const setupNeeded = (await userCount(sql)) === 0;
    const approved = req.device?.status === 'approved';
    return {
      workspace: db.name,
      setupNeeded,
      store: { name: s.storeName },
      device: req.device ? { id: req.device.id, name: req.device.name, status: req.device.status } : null,
      users: approved ? await loginTiles(sql) : [],
      approvers: req.device && !approved && !setupNeeded ? await loginTiles(sql).then((u) => u.filter((x) => x.role_id === 'admin')) : [],
      settings: { idleLockMinutes: s.idleLockMinutes, discountHintEnabled: s.discountHintEnabled },
      session: req.session ? sessionView(req.session) : null,
      serverTime: new Date().toISOString(),
    };
  });

  /** First run on an empty database: create the admin and register this computer. */
  app.post('/api/setup', { config: { auth: 'public' } }, async (req) => {
    const b = z
      .object({ storeName: z.string().min(2), adminName: z.string().min(2), pin, deviceName: z.string().min(2) })
      .parse(req.body);
    const sql = db.app;
    if ((await userCount(sql)) > 0) throw new AppError(409, 'ALREADY_SET_UP', 'This shop is already set up');
    const { id: userId } = await createUser(sql, null, { name: b.adminName, roleId: 'admin', pin: b.pin });
    await setSettings(sql, { storeName: b.storeName.trim() });
    const deviceToken = newToken();
    const [d] = await sql<{ id: number }[]>`
      insert into devices (name, token_hash, status, approved_at, approved_by, user_agent)
      values (${b.deviceName.trim()}, ${hashToken(deviceToken)}, 'approved', now(), ${userId}, ${req.headers['user-agent'] ?? null}) returning id`;
    await audit(sql, { userId, deviceId: d!.id }, 'setup.completed', { details: { storeName: b.storeName, deviceName: b.deviceName } });
    const session = await login(sql, userId, b.pin, d!.id);
    return { deviceToken, ...session };
  });

  app.post('/api/devices/register', { config: { auth: 'public' } }, async (req) => {
    const b = z.object({ name: z.string() }).parse(req.body);
    return registerDevice(db.app, b.name, req.headers['user-agent']);
  });

  /** An admin standing at a new computer approves it on the spot with their PIN. */
  app.post('/api/devices/approve-here', { config: { auth: 'public' } }, async (req) => {
    const b = z.object({ approverId: z.number().int(), pin }).parse(req.body);
    if (!req.device) throw new AppError(401, 'DEVICE_UNKNOWN', 'This computer is not registered');
    if (req.device.status === 'approved') return { ok: true };
    const approver = await verifyUserPin(db.app, b.approverId, b.pin);
    if (!approver.permissions.includes('users.manage')) throw new AppError(403, 'FORBIDDEN', `${approver.name} cannot approve computers`);
    await approveDevice(db.app, req.device.id, approver.id, null);
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { auth: 'device' } }, async (req) => {
    const b = z.object({ userId: z.number().int(), pin }).parse(req.body);
    const r = await login(db.app, b.userId, b.pin, req.device!.id);
    const [u] = await db.app<{ language: string; discount_cap_bp: number | null }[]>`select language, discount_cap_bp from users where id = ${b.userId}`;
    return { token: r.token, session: { userId: r.user.id, userName: r.user.name, roleId: r.user.roleId, permissions: r.user.permissions, language: u?.language ?? 'en', discountCapBp: u?.discount_cap_bp ?? null, deviceId: req.device!.id, deviceName: req.device!.name } };
  });

  app.post('/api/auth/logout', async (req) => {
    const b = z.object({ lock: z.boolean().optional() }).parse(req.body ?? {});
    await logout(db.app, req.sessionToken!, ctxOf(req), b.lock ? 'lock' : 'logout');
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ ...sessionView(req.session!), deviceName: req.device!.name }));

  /** Admin PIN approval for one specific action (discount above limit, cancel bill…). */
  app.post('/api/auth/override', async (req) => {
    const b = z
      .object({
        permission: z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]),
        approverId: z.number().int(),
        pin,
        context: z.record(z.string(), z.unknown()),
        reason: z.string().max(300).optional(),
      })
      .parse(req.body);
    return approveOverride(db.app, ctxOf(req), b);
  });
}

function sessionView(s: NonNullable<import('fastify').FastifyRequest['session']>) {
  return { userId: s.userId, userName: s.userName, roleId: s.roleId, permissions: s.permissions, language: s.language, discountCapBp: s.discountCapBp, deviceId: s.deviceId };
}

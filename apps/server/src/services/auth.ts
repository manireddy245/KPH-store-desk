import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Permission } from '@kph/core';
import type { Q, Sql, Tx } from '../db/connect.js';
import { AppError, audit, type Ctx } from './common.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const MAX_PIN_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 5;
export const OVERRIDE_TTL_MINUTES = 5;
export const SESSION_IDLE_HOURS = 14;

export function validatePin(pin: string) {
  if (!/^\d{4,8}$/.test(pin)) throw new AppError(400, 'BAD_PIN', 'PIN must be 4 to 8 digits');
}

export async function hashPin(pin: string): Promise<string> {
  validatePin(pin);
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function pinMatches(pin: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pin, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

interface UserRow {
  id: number;
  name: string;
  role_id: string;
  pin_hash: string;
  active: boolean;
  failed_pin_count: number;
  locked_until: Date | null;
  permissions: string[];
}

/** Checks a PIN with lockout after repeated failures. Returns the user with their permissions. */
export async function verifyUserPin(sql: Sql, userId: number, pin: string): Promise<UserRow> {
  const [u] = await sql<UserRow[]>`
    select u.*, r.permissions from users u join roles r on r.id = u.role_id where u.id = ${userId}`;
  if (!u || !u.active) throw new AppError(401, 'BAD_LOGIN', 'User not found or inactive');
  if (u.locked_until && u.locked_until > new Date()) {
    const mins = Math.ceil((u.locked_until.getTime() - Date.now()) / 60000);
    throw new AppError(423, 'LOCKED', `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  if (!(await pinMatches(pin, u.pin_hash))) {
    const failed = u.failed_pin_count + 1;
    if (failed >= MAX_PIN_ATTEMPTS) {
      await sql`update users set failed_pin_count = 0, locked_until = now() + ${LOCKOUT_MINUTES + ' minutes'}::interval where id = ${u.id}`;
      await audit(sql, { userId: u.id, deviceId: null }, 'auth.locked_out');
      throw new AppError(423, 'LOCKED', `Too many wrong PINs. Locked for ${LOCKOUT_MINUTES} minutes.`);
    }
    await sql`update users set failed_pin_count = ${failed} where id = ${u.id}`;
    throw new AppError(401, 'BAD_PIN', `Wrong PIN. ${MAX_PIN_ATTEMPTS - failed} tries left.`);
  }
  if (u.failed_pin_count || u.locked_until) await sql`update users set failed_pin_count = 0, locked_until = null where id = ${u.id}`;
  return u;
}

export async function login(sql: Sql, userId: number, pin: string, deviceId: number) {
  const u = await verifyUserPin(sql, userId, pin);
  const token = newToken();
  await sql`insert into sessions (token_hash, user_id, device_id) values (${hashToken(token)}, ${u.id}, ${deviceId})`;
  await audit(sql, { userId: u.id, deviceId }, 'auth.login');
  return { token, user: { id: u.id, name: u.name, roleId: u.role_id, permissions: u.permissions } };
}

export async function logout(sql: Sql, token: string, ctx: Ctx, reason: 'logout' | 'lock' = 'logout') {
  await sql`update sessions set ended_at = now() where token_hash = ${hashToken(token)} and ended_at is null`;
  await audit(sql, ctx, reason === 'lock' ? 'auth.lock' : 'auth.logout');
}

export interface SessionInfo {
  userId: number;
  userName: string;
  roleId: string;
  language: string;
  discountCapBp: number | null;
  permissions: string[];
  deviceId: number;
}

export async function getSession(sql: Sql, token: string, deviceId: number): Promise<SessionInfo | null> {
  const [s] = await sql<(SessionInfo & { lastSeenAt: Date })[]>`
    select s.user_id as "userId", u.name as "userName", u.role_id as "roleId", u.language,
           u.discount_cap_bp as "discountCapBp", r.permissions, s.device_id as "deviceId", s.last_seen_at as "lastSeenAt"
    from sessions s join users u on u.id = s.user_id join roles r on r.id = u.role_id
    where s.token_hash = ${hashToken(token)} and s.ended_at is null and u.active
      and s.last_seen_at > now() - ${SESSION_IDLE_HOURS + ' hours'}::interval`;
  if (!s || s.deviceId !== deviceId) return null;
  if (Date.now() - s.lastSeenAt.getTime() > 60_000) {
    await sql`update sessions set last_seen_at = now() where token_hash = ${hashToken(token)}`;
  }
  const { lastSeenAt: _, ...info } = s;
  return info;
}

// ------------------------------------------------------------------ devices

export async function registerDevice(sql: Sql, name: string, userAgent: string | undefined) {
  const clean = name.trim();
  if (clean.length < 2) throw new AppError(400, 'BAD_NAME', 'Give this computer a name, e.g. "Counter 1"');
  const token = newToken();
  const [d] = await sql<{ id: number }[]>`
    insert into devices (name, token_hash, status, user_agent) values (${clean}, ${hashToken(token)}, 'pending', ${userAgent ?? null})
    returning id`;
  await audit(sql, null, 'device.registered', { entity: 'device', entityId: d!.id, details: { name: clean } });
  return { token, deviceId: d!.id };
}

export async function getDevice(sql: Sql, token: string) {
  const [d] = await sql<{ id: number; name: string; status: string }[]>`
    select id, name, status from devices where token_hash = ${hashToken(token)}`;
  if (d && d.status === 'approved') await sql`update devices set last_seen_at = now() where id = ${d.id} and (last_seen_at is null or last_seen_at < now() - interval '1 minute')`;
  return d ?? null;
}

export async function approveDevice(sql: Sql, deviceId: number, approverId: number, approverDeviceId: number | null) {
  const [d] = await sql`update devices set status = 'approved', approved_at = now(), approved_by = ${approverId}
                        where id = ${deviceId} returning id, name`;
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Computer not found');
  await audit(sql, { userId: approverId, deviceId: approverDeviceId }, 'device.approved', { entity: 'device', entityId: deviceId, details: { name: d.name } });
}

// ------------------------------------------------------------------ admin PIN overrides

/**
 * Staff asked to do something they can't (e.g. discount above limit). An approver who
 * holds the permission enters their PIN on the same screen; we hand back a single-use token
 * valid for a few minutes and only for that exact action (context).
 */
export async function approveOverride(
  sql: Sql,
  ctx: Ctx,
  input: { permission: Permission; approverId: number; pin: string; context: Record<string, unknown>; reason?: string },
) {
  const approver = await verifyUserPin(sql, input.approverId, input.pin);
  if (!approver.permissions.includes(input.permission)) {
    throw new AppError(403, 'APPROVER_NOT_ALLOWED', `${approver.name} cannot approve this`);
  }
  const token = newToken();
  const [o] = await sql<{ id: number }[]>`
    insert into overrides (token_hash, permission, approved_by, requested_by, device_id, context, reason, expires_at)
    values (${hashToken(token)}, ${input.permission}, ${approver.id}, ${ctx.userId}, ${ctx.deviceId},
            ${sql.json(input.context as never)}, ${input.reason ?? null}, now() + ${OVERRIDE_TTL_MINUTES + ' minutes'}::interval)
    returning id`;
  await audit(sql, ctx, 'override.approved', {
    entity: 'override',
    entityId: o!.id,
    details: { permission: input.permission, context: input.context },
    reason: input.reason,
    approvedBy: approver.id,
  });
  return { token, approvedBy: { id: approver.id, name: approver.name } };
}

/** Use an override inside the transaction that performs the action. Throws if not valid. */
export async function consumeOverride(
  tx: Tx,
  ctx: Ctx,
  token: string,
  permission: Permission,
  matches: (context: Record<string, unknown>) => boolean,
): Promise<{ id: number; approvedBy: number }> {
  const [o] = await tx<{ id: number; approved_by: number; context: Record<string, unknown> }[]>`
    select id, approved_by, context from overrides
    where token_hash = ${hashToken(token)} and permission = ${permission} and requested_by = ${ctx.userId}
      and used_at is null and expires_at > now()
    for update`;
  if (!o || !matches(o.context)) {
    throw new AppError(403, 'OVERRIDE_INVALID', 'Admin approval has expired or does not match. Ask for the admin PIN again.');
  }
  await tx`update overrides set used_at = now() where id = ${o.id}`;
  return { id: o.id, approvedBy: o.approved_by };
}

export async function userCount(q: Q) {
  const [r] = await q<{ n: number }[]>`select count(*)::int as n from users`;
  return r!.n;
}

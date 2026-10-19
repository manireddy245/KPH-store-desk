import { ALL_PERMISSIONS } from '@kph/core';
import type { Q, Sql } from '../db/connect.js';
import { hashPin } from './auth.js';
import { AppError, audit, requirePerm, type Ctx } from './common.js';

export async function listUsers(q: Q) {
  return q`select u.id, u.name, u.role_id, r.name as role_name, u.active, u.discount_cap_bp, u.language, u.created_at,
                  (u.locked_until is not null and u.locked_until > now()) as locked
           from users u join roles r on r.id = u.role_id order by u.active desc, lower(u.name)`;
}

/** Users shown on the login screen of an approved computer. */
export async function loginTiles(q: Q) {
  return q`select u.id, u.name, u.role_id, r.name as role_name from users u join roles r on r.id = u.role_id
           where u.active order by (u.role_id = 'admin') desc, lower(u.name)`;
}

export async function createUser(
  sql: Sql,
  ctx: Ctx | null,
  input: { name: string; roleId: string; pin: string; discountCapBp?: number | null; language?: string },
) {
  if (ctx) requirePerm(ctx, 'users.manage');
  const name = input.name.trim();
  if (name.length < 2) throw new AppError(400, 'BAD_NAME', 'Name is too short');
  const pinHash = await hashPin(input.pin);
  try {
    const [u] = await sql<{ id: number }[]>`
      insert into users (name, role_id, pin_hash, discount_cap_bp, language)
      values (${name}, ${input.roleId}, ${pinHash}, ${input.discountCapBp ?? null}, ${input.language ?? 'en'}) returning id`;
    await audit(sql, ctx, 'user.created', { entity: 'user', entityId: u!.id, details: { name, roleId: input.roleId } });
    return { id: u!.id };
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === '23505') throw new AppError(409, 'DUPLICATE', 'A user with this name already exists');
    if (err.code === '23503') throw new AppError(400, 'BAD_ROLE', 'Role not found');
    throw e;
  }
}

export async function updateUser(
  sql: Sql,
  ctx: Ctx,
  id: number,
  input: { name?: string; roleId?: string; active?: boolean; discountCapBp?: number | null; language?: string },
) {
  const self = id === ctx.userId;
  const onlyLanguage = Object.keys(input).every((k) => k === 'language');
  if (!(self && onlyLanguage)) requirePerm(ctx, 'users.manage');
  if (self && (input.active === false || (input.roleId && input.roleId !== 'admin'))) {
    throw new AppError(400, 'SELF_LOCKOUT', 'You cannot deactivate yourself or remove your own admin role');
  }
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.roleId !== undefined) set.role_id = input.roleId;
  if (input.active !== undefined) set.active = input.active;
  if (input.discountCapBp !== undefined) set.discount_cap_bp = input.discountCapBp;
  if (input.language !== undefined) set.language = input.language;
  if (!Object.keys(set).length) return { id };
  await sql.begin(async (tx) => {
    await tx`update users set ${tx(set)} where id = ${id}`;
    if (input.active === false) await tx`update sessions set ended_at = now() where user_id = ${id} and ended_at is null`;
    await assertAnAdminRemains(tx);
    await audit(tx, ctx, 'user.updated', { entity: 'user', entityId: id, details: input });
  });
  return { id };
}

async function assertAnAdminRemains(q: Q) {
  const [r] = await q<{ n: number }[]>`
    select count(*)::int as n from users u join roles r on r.id = u.role_id
    where u.active and 'users.manage' = any(r.permissions)`;
  if (!r!.n) throw new AppError(400, 'NO_ADMIN_LEFT', 'At least one active admin must remain');
}

export async function resetPin(sql: Sql, ctx: Ctx, id: number, pin: string) {
  requirePerm(ctx, 'users.manage');
  const pinHash = await hashPin(pin);
  await sql`update users set pin_hash = ${pinHash}, failed_pin_count = 0, locked_until = null where id = ${id}`;
  await sql`update sessions set ended_at = now() where user_id = ${id} and ended_at is null`;
  await audit(sql, ctx, 'user.pin_reset', { entity: 'user', entityId: id });
}

export async function listRoles(q: Q) {
  return q`select * from roles order by system desc, name`;
}

export async function updateRolePermissions(sql: Sql, ctx: Ctx, roleId: string, permissions: string[]) {
  requirePerm(ctx, 'users.manage');
  const bad = permissions.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p));
  if (bad.length) throw new AppError(400, 'BAD_PERMISSION', `Unknown permission: ${bad.join(', ')}`);
  await sql.begin(async (tx) => {
    const [before] = await tx<{ permissions: string[] }[]>`select permissions from roles where id = ${roleId}`;
    if (!before) throw new AppError(404, 'NOT_FOUND', 'Role not found');
    await tx`update roles set permissions = ${permissions} where id = ${roleId}`;
    await assertAnAdminRemains(tx);
    await audit(tx, ctx, 'role.permissions_changed', { entity: 'role', entityId: roleId, details: { before: before.permissions, after: permissions } });
  });
}

export async function listDevices(q: Q) {
  return q`select d.id, d.name, d.status, d.created_at, d.approved_at, d.last_seen_at, u.name as approved_by_name
           from devices d left join users u on u.id = d.approved_by order by d.status = 'pending' desc, d.id`;
}

export async function setDeviceStatus(sql: Sql, ctx: Ctx, id: number, status: 'approved' | 'revoked', name?: string) {
  requirePerm(ctx, 'users.manage');
  if (id === ctx.deviceId && status === 'revoked') throw new AppError(400, 'SELF_REVOKE', 'You cannot block the computer you are using');
  await sql`update devices set status = ${status}, name = coalesce(${name?.trim() || null}, name),
            approved_at = case when ${status} = 'approved' then now() else approved_at end,
            approved_by = case when ${status} = 'approved' then ${ctx.userId}::int else approved_by end
            where id = ${id}`;
  if (status === 'revoked') await sql`update sessions set ended_at = now() where device_id = ${id} and ended_at is null`;
  await audit(sql, ctx, status === 'approved' ? 'device.approved' : 'device.revoked', { entity: 'device', entityId: id });
}

export async function renameDevice(sql: Sql, ctx: Ctx, id: number, name: string) {
  requirePerm(ctx, 'users.manage');
  if (name.trim().length < 2) throw new AppError(400, 'BAD_NAME', 'Name is too short');
  await sql`update devices set name = ${name.trim()} where id = ${id}`;
  await audit(sql, ctx, 'device.renamed', { entity: 'device', entityId: id, details: { name } });
}

export async function listActivity(
  q: Q,
  ctx: Ctx,
  f: { from?: string; to?: string; userId?: number; deviceId?: number; action?: string; limit?: number },
) {
  // Staff without activity.view see only their own entries.
  const onlyUser = ctx.permissions.includes('activity.view') ? (f.userId ?? null) : ctx.userId;
  const action = f.action ? `${f.action}%` : null;
  return q`
    select a.id, a.at, a.action, a.entity, a.entity_id, a.details, a.reason, u.name as user_name, d.name as device_name,
           ap.name as approved_by_name
    from audit_log a left join users u on u.id = a.user_id left join devices d on d.id = a.device_id left join users ap on ap.id = a.approved_by
    where (${f.from ?? null}::date is null or a.at >= (${f.from ?? null}::date)::timestamp at time zone 'Asia/Kolkata')
      and (${f.to ?? null}::date is null or a.at < ((${f.to ?? null}::date + 1)::timestamp at time zone 'Asia/Kolkata'))
      and (${onlyUser}::int is null or a.user_id = ${onlyUser})
      and (${f.deviceId ?? null}::int is null or a.device_id = ${f.deviceId ?? null})
      and (${action}::text is null or a.action like ${action})
    order by a.id desc
    limit ${Math.min(f.limit ?? 300, 2000)}`;
}

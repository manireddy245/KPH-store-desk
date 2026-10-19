import type { Permission } from '@kph/core';
import type { Q } from '../db/connect.js';

/** Who is doing something, from where. Every record and log entry carries this. */
export interface Ctx {
  userId: number;
  deviceId: number | null;
  permissions: readonly string[];
}

export function can(ctx: Ctx, p: Permission) {
  return ctx.permissions.includes(p);
}

/** An error with a plain-language message that is safe to show staff. */
export class AppError extends Error {
  /** A passing problem (service busy): worth trying again. */
  retryable = false;
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function requirePerm(ctx: Ctx, p: Permission, message = 'You do not have permission to do this') {
  if (!can(ctx, p)) throw new AppError(403, 'FORBIDDEN', message, { permission: p });
}

export async function audit(
  q: Q,
  ctx: Pick<Ctx, 'userId' | 'deviceId'> | null,
  action: string,
  opts: { entity?: string; entityId?: string | number; details?: Record<string, unknown>; reason?: string | null; approvedBy?: number | null } = {},
) {
  await q`
    insert into audit_log (user_id, device_id, action, entity, entity_id, details, reason, approved_by)
    values (${ctx?.userId ?? null}, ${ctx?.deviceId ?? null}, ${action}, ${opts.entity ?? null},
            ${opts.entityId == null ? null : String(opts.entityId)}, ${q.json((opts.details ?? {}) as never)},
            ${opts.reason ?? null}, ${opts.approvedBy ?? null})`;
}

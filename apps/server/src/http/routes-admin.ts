import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listBackupFiles, readBackup, restoreBackupData, writeBackup } from '../services/backup.js';
import { AppError, audit, requirePerm } from '../services/common.js';
import { FIELDS, analyse, applyImport, guessMapping, parseUpload, type ImportKind } from '../services/import.js';
import { getSettings, publicSettings, setSettings } from '../services/settings.js';
import {
  createUser,
  listActivity,
  listDevices,
  listRoles,
  listUsers,
  renameDevice,
  resetPin,
  setDeviceStatus,
  updateRolePermissions,
  updateUser,
} from '../services/users.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();
const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits');
const kind = z.enum(['products', 'customers', 'suppliers']);

export async function registerAdminRoutes(app: FastifyInstance, { db, live }: Shared) {
  // ---------------------------------------------------------------- settings
  app.get('/api/settings', async (req) => {
    ctxOf(req);
    return publicSettings(await getSettings(db.app));
  });

  app.put('/api/settings', async (req) => {
    const ctx = ctxOf(req);
    requirePerm(ctx, 'settings.manage');
    const b = z
      .object({
        storeName: z.string().min(2),
        storeAddress: z.string(),
        storePlace: z.string().max(50),
        storePincode: z.string().regex(/^$|^[1-9][0-9]{5}$/, 'PIN code is 6 digits'),
        storePhone: z.string(),
        storeGstin: z.string().regex(/^$|^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN should be 15 characters, e.g. 37ABCDE1234F1Z5'),
        stateCode: z.string().regex(/^\d{2}$/),
        stateName: z.string(),
        invoicePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/, 'Use 1–4 capital letters/digits (GST limits invoice numbers to 16 characters)'),
        receiptPrefix: z.string().regex(/^[A-Z0-9]{1,4}$/),
        invoiceTerms: z.string().max(1000),
        lowStockThresholdMilli: z.number().int().min(0),
        idleLockMinutes: z.number().int().min(1).max(240),
        discountHintEnabled: z.boolean(),
        allowNegativeStock: z.boolean(),
        autoBackupHour: z.number().int().min(0).max(23),
        geminiApiKey: z.string(),
        geminiModel: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,60}$/, 'Model name looks wrong'),
        purchasePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/),
        creditNotePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/),
        debitNotePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/),
        salesPriceMode: z.enum(['excl', 'incl']),
        purchasePriceMode: z.enum(['excl', 'incl']),
        invoiceLabels: z.enum(['en', 'te-en']),
      })
      .partial()
      .parse(req.body);
    await setSettings(db.app, b);
    const logged = { ...b, geminiApiKey: b.geminiApiKey === undefined ? undefined : '(changed)' };
    await audit(db.app, ctx, 'settings.changed', { details: logged });
    live.broadcast({ type: 'settings.changed' });
    return publicSettings(await getSettings(db.app));
  });

  // ---------------------------------------------------------------- users & roles
  app.get('/api/users', async (req) => {
    requirePerm(ctxOf(req), 'users.manage');
    return listUsers(db.app);
  });
  app.post('/api/users', async (req) => {
    const b = z
      .object({ name: z.string().min(2), roleId: z.string(), pin, discountCapBp: z.number().int().min(0).max(10000).nullable().optional(), language: z.enum(['en', 'te']).optional() })
      .parse(req.body);
    const r = await createUser(db.app, ctxOf(req), b);
    live.broadcast({ type: 'users.changed' });
    return r;
  });
  app.patch('/api/users/:id', async (req) => {
    const b = z
      .object({ name: z.string().min(2).optional(), roleId: z.string().optional(), active: z.boolean().optional(), discountCapBp: z.number().int().min(0).max(10000).nullable().optional(), language: z.enum(['en', 'te']).optional() })
      .parse(req.body);
    const r = await updateUser(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'users.changed' });
    return r;
  });
  app.post('/api/users/:id/reset-pin', async (req) => {
    const b = z.object({ pin }).parse(req.body);
    await resetPin(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b.pin);
    return { ok: true };
  });
  app.get('/api/roles', async (req) => {
    ctxOf(req);
    return listRoles(db.app);
  });
  app.put('/api/roles/:roleId', async (req) => {
    const { roleId } = z.object({ roleId: z.string() }).parse(req.params);
    const b = z.object({ permissions: z.array(z.string()) }).parse(req.body);
    await updateRolePermissions(db.app, ctxOf(req), roleId, b.permissions);
    live.broadcast({ type: 'users.changed' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- devices (counters)
  app.get('/api/devices', async (req) => {
    requirePerm(ctxOf(req), 'users.manage');
    return listDevices(db.app);
  });
  app.post('/api/devices/:id/approve', async (req) => {
    await setDeviceStatus(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, 'approved');
    live.broadcast({ type: 'devices.changed' });
    return { ok: true };
  });
  app.post('/api/devices/:id/revoke', async (req) => {
    await setDeviceStatus(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, 'revoked');
    live.broadcast({ type: 'devices.changed' });
    return { ok: true };
  });
  app.patch('/api/devices/:id', async (req) => {
    const b = z.object({ name: z.string() }).parse(req.body);
    await renameDevice(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b.name);
    return { ok: true };
  });

  // ---------------------------------------------------------------- activity log
  app.get('/api/activity', async (req) => {
    const q = z
      .object({ from: z.string().optional(), to: z.string().optional(), userId: id.optional(), deviceId: id.optional(), action: z.string().optional() })
      .parse(req.query);
    return listActivity(db.app, ctxOf(req), q);
  });

  // ---------------------------------------------------------------- import
  app.get('/api/import/fields', async () => FIELDS);

  app.post('/api/import/parse', async (req) => {
    requirePerm(ctxOf(req), 'settings.manage');
    const b = z.object({ kind, filename: z.string(), base64: z.string() }).parse(req.body);
    const table = await parseUpload(b.filename, Buffer.from(b.base64, 'base64'));
    return { table, mapping: guessMapping(b.kind as ImportKind, table.headers) };
  });

  const tableSchema = z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())).max(20000) });
  const mappingSchema = z.record(z.string(), z.number().int().nullable());

  app.post('/api/import/preview', async (req) => {
    requirePerm(ctxOf(req), 'settings.manage');
    const b = z.object({ kind, table: tableSchema, mapping: mappingSchema, updateExisting: z.boolean().optional() }).parse(req.body);
    return analyse(db.app, b.kind, b.table, b.mapping, { updateExisting: b.updateExisting });
  });

  app.post('/api/import/apply', async (req) => {
    const b = z.object({ kind, table: tableSchema, mapping: mappingSchema, updateExisting: z.boolean().optional() }).parse(req.body);
    const r = await applyImport(db.app, ctxOf(req), b.kind, b.table, b.mapping, { updateExisting: b.updateExisting, isSample: db.name === 'sample' });
    live.broadcast({ type: b.kind === 'products' ? 'products.changed' : b.kind === 'customers' ? 'customers.changed' : 'suppliers.changed' });
    return r;
  });

  // ---------------------------------------------------------------- backups
  app.get('/api/backups', async (req) => {
    requirePerm(ctxOf(req), 'settings.manage');
    const log = await db.app`select * from backups_log order by id desc limit 50`;
    return { dir: db.backupDir, files: listBackupFiles(db.backupDir), log };
  });

  app.post('/api/backups/run', async (req) => {
    const ctx = ctxOf(req);
    requirePerm(ctx, 'settings.manage');
    const r = await writeBackup(db.owner, db.name, db.backupDir, 'manual');
    await audit(db.app, ctx, 'backup.created', { details: { file: r.file, sizeBytes: r.sizeBytes } });
    return r;
  });

  app.get('/api/backups/download/:file', async (req, reply) => {
    requirePerm(ctxOf(req), 'settings.manage');
    const file = basename(z.object({ file: z.string() }).parse(req.params).file);
    const path = join(db.backupDir, file);
    if (!file.endsWith('.json.gz') || !existsSync(path)) throw new AppError(404, 'NOT_FOUND', 'Backup file not found');
    return reply.header('content-type', 'application/gzip').header('content-disposition', `attachment; filename="${file}"`).send(readFileSync(path));
  });

  /** Replace ALL data with a backup. A safety backup of the current data is taken first. */
  app.post('/api/backups/restore', async (req) => {
    const ctx = ctxOf(req);
    requirePerm(ctx, 'settings.manage');
    const b = z.object({ base64: z.string().optional(), file: z.string().optional(), confirm: z.literal('RESTORE') }).parse(req.body);
    const buf = b.base64 ? Buffer.from(b.base64, 'base64') : b.file ? readFileSync(join(db.backupDir, basename(b.file))) : null;
    if (!buf) throw new AppError(400, 'NO_FILE', 'Choose a backup file');
    let data;
    try {
      data = readBackup(buf);
    } catch (e) {
      throw new AppError(400, 'BAD_BACKUP', (e as Error).message);
    }
    const safety = await writeBackup(db.owner, db.name, db.backupDir, 'pre-restore');
    const counts = await restoreBackupData(db.owner, data);
    await audit(db.app, null, 'backup.restored', { details: { from: data.createdAt, workspace: data.workspace, safetyBackup: safety.file, counts, byUserId: ctx.userId } });
    live.broadcast({ type: 'workspace.changed' });
    return { ok: true, counts, safetyBackup: safety.file };
  });

  // ---------------------------------------------------------------- workspace (sample ↔ real data)
  app.post('/api/workspace/switch', async (req) => {
    const ctx = ctxOf(req);
    requirePerm(ctx, 'settings.manage');
    const b = z.object({ to: z.enum(['sample', 'live']), confirm: z.string() }).parse(req.body);
    if (b.to === db.name) return { ok: true, workspace: db.name };
    const expected = b.to === 'live' ? 'REAL DATA' : 'SAMPLE';
    if (b.confirm !== expected) throw new AppError(400, 'CONFIRM', `Type ${expected} to confirm`);
    if (!db.open) throw new AppError(400, 'NOT_SUPPORTED', 'Switching is not available here');
    await audit(db.app, ctx, 'workspace.switched', { details: { from: db.name, to: b.to } });
    await db.open(b.to);
    live.broadcast({ type: 'workspace.changed' });
    return { ok: true, workspace: db.name };
  });

  app.post('/api/workspace/reset-sample', async (req) => {
    const ctx = ctxOf(req);
    requirePerm(ctx, 'settings.manage');
    z.object({ confirm: z.literal('RESET SAMPLE') }).parse(req.body);
    if (db.name !== 'sample') throw new AppError(400, 'NOT_SAMPLE', 'Reset is only possible in the sample workspace. Your real data is never reset.');
    if (!db.resetSample) throw new AppError(400, 'NOT_SUPPORTED', 'Reset is not available here');
    await db.resetSample();
    live.broadcast({ type: 'workspace.changed' });
    return { ok: true };
  });
}

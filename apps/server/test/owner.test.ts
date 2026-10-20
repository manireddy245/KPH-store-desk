import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@kph/core';
import { readBackup } from '../src/services/backup.js';
import { decryptBackup, encryptBackup, isEncrypted } from '../src/services/backupcopy.js';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
const today = istDate();

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
});
afterAll(async () => {
  await admin.put('/api/settings', { backupCopyDir: '', backupPassphrase: '' });
  await h.close();
});

describe('encrypted backup copies', () => {
  it('encrypts and decrypts; a wrong passphrase is refused', () => {
    const plain = Buffer.from('hello backup');
    const enc = encryptBackup(plain, 'kavali-2026');
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.includes(plain)).toBe(false);
    expect(decryptBackup(enc, 'kavali-2026').toString()).toBe('hello backup');
    expect(() => decryptBackup(enc, 'wrong-pass')).toThrow(/Wrong passphrase/);
    expect(() => encryptBackup(plain, 'short')).toThrow();
  });

  it('a backup is copied (encrypted) to the second folder, checked, and can be restored from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kph-copy-'));
    expect((await admin.put('/api/settings', { backupPassphrase: 'short' })).status).toBe(400);
    expect((await admin.put('/api/settings', { backupCopyDir: dir, backupPassphrase: 'kavali-2026' })).status).toBe(200);
    // the passphrase is never sent back
    const s = (await admin.get('/api/settings')).body;
    expect(s.backupPassphrase).toBeUndefined();
    expect(s.backupPassphraseSet).toBe(true);

    await h.product({ qty: 5 });
    const r = await admin.post('/api/backups/run');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.copy.file).toMatch(/\.json\.gz\.enc$/);
    const files = readdirSync(dir).filter((f) => f.endsWith('.enc'));
    expect(files).toHaveLength(1);
    const enc = readFileSync(join(dir, files[0]!));
    expect(isEncrypted(enc)).toBe(true);
    const data = readBackup(decryptBackup(enc, 'kavali-2026'));
    expect(data.counts.products).toBeGreaterThan(0);
    // the passphrase is not inside the backup either
    expect(JSON.stringify(data.tables.settings)).not.toContain('kavali-2026');

    const st = (await admin.get('/api/backups/status')).body;
    expect(st).toMatchObject({ configured: true, copiesKept: 1, copy: { ok: true } });
    const dash = (await admin.get('/api/dashboard')).body;
    expect(dash.lastCopy.ok).toBe(true);

    // restore straight from the encrypted copy (passphrase typed)
    const p = await h.product({ qty: 1 });
    const back = await admin.post('/api/backups/restore', { base64: enc.toString('base64'), passphrase: 'kavali-2026', confirm: 'RESTORE' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const [gone] = await h.app`select 1 from products where id = ${p}`;
    expect(gone).toBeUndefined();
    admin = await h.loginAs('admin');
    counter = await h.loginAs('counter');
  });

  it('refuses a folder that cannot be written to', async () => {
    const bad = join(tmpdir(), 'kph-copy-file');
    writeFileSync(bad, 'x');
    expect((await admin.put('/api/settings', { backupCopyDir: join(bad, 'sub') })).status).toBe(400);
    expect(existsSync(join(bad, 'sub'))).toBe(false);
  });
});

describe('owner day and daily summary', () => {
  it('today on one screen; summary in English and Telugu; owner only', async () => {
    const P = await h.product({ price: 100_000, qty: 20 });
    await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: P, qtyMilli: 2_000, discountBp: 0 }] });
    const d = (await admin.get('/api/owner/today')).body;
    expect(d.sales.bills).toBeGreaterThanOrEqual(1);
    expect(d.sales.cash).toBeGreaterThanOrEqual(236_000);
    expect((await counter.get('/api/owner/today')).status).toBe(403);
    const made = await admin.post('/api/owner/summary', {});
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body.en).toContain('Sales ₹');
    expect(made.body.te).toContain('అమ్మకాలు');
    const got = (await admin.get(`/api/owner/summary?date=${today}`)).body;
    expect(got.en).toBe(made.body.en);
    expect((await admin.get('/api/owner/summaries')).body[0].date).toBe(today);
  });
});

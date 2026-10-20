import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createBackupData, restoreBackupData, writeBackup, readBackupFile } from '../src/services/backup.js';
import { join } from 'node:path';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
});
afterAll(() => h.close());

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

describe('import from CSV / Excel', () => {
  it('guesses columns, reports problems, and imports good rows with opening stock', async () => {
    const tag = h.tag.toUpperCase();
    const csv = [
      'Item Code,Item Name,Group,Brand,UOM,HSN Code,GST %,Selling Price,Purchase Price,Closing Stock',
      `IM-${tag}-1,UltraTech PPC 50kg,Cement,UltraTech,Bags,2523,18,315,292,120`,
      `IM-${tag}-2,Gold Medal Switch,Electricals,Gold Medal,nos,,18,38.50,28,200`,
      `IM-${tag}-3,Mystery item,,,,,,,,`,
      `IM-${tag}-1,Duplicate code,Cement,,bag,2523,18,300,,`,
      `,No code item,Hardware,,kgs,7317,12,95,74,1.5`,
      `IM-${tag}-6,Bad price,Hardware,,pcs,8302,18,abc,,`,
      `IM-${tag}-7,Odd unit,Hardware,,drum,8302,18,100,,5`,
    ].join('\n');
    const parsed = await admin.post('/api/import/parse', { kind: 'products', filename: 'stock.csv', base64: b64(csv) });
    expect(parsed.status).toBe(200);
    const { table, mapping } = parsed.body;
    expect(mapping).toMatchObject({ sku: 0, name: 1, category: 2, brand: 3, unit: 4, hsn: 5, gst: 6, price: 7, cost: 8, qty: 9 });

    const preview = await admin.post('/api/import/preview', { kind: 'products', table, mapping });
    expect(preview.status).toBe(200);
    const rows = preview.body.rows as { rowNo: number; errors: string[]; warnings: string[]; action: string; values: Record<string, unknown> }[];
    const row = (n: number) => rows.find((r) => r.rowNo === n)!;
    expect(row(2)).toMatchObject({ action: 'create', errors: [], values: { unit: 'bag', salePricePaise: 31500, costPriceCp: 2920000, openingQtyMilli: 120000 } });
    expect(row(3).warnings).toContain('HSN code missing');
    expect(row(3).values).toMatchObject({ unit: 'nos', salePricePaise: 3850 });
    expect(row(4).warnings).toEqual(expect.arrayContaining(['Unit missing — will use "pcs"', 'GST rate missing — will use 18%', 'Selling price missing — will be ₹0']));
    expect(row(5)).toMatchObject({ action: 'skip', errors: ['Same SKU as row 2'] });
    expect(row(6).warnings[0]).toMatch(/^No SKU — will use IMP-/);
    expect(row(6).values).toMatchObject({ unit: 'kg', gstRateBp: 1200, openingQtyMilli: 1500 });
    expect(row(7)).toMatchObject({ action: 'skip' });
    expect(row(7).errors[0]).toMatch(/Selling price "abc"/);
    expect(row(8).warnings).toContain('New unit "drum" will be created');
    expect(preview.body.summary).toMatchObject({ total: 7, create: 5, skip: 2 });

    const applied = await admin.post('/api/import/apply', { kind: 'products', table, mapping });
    expect(applied.status).toBe(200);
    const [p] = await h.app<{ id: number; sale_price_paise: number }[]>`select id, sale_price_paise from products where sku = ${`IM-${tag}-1`}`;
    expect(p!.sale_price_paise).toBe(31500);
    expect(await h.stockOf(p!.id)).toBe(120000);
    const [m] = await h.app`select kind from stock_movements where product_id = ${p!.id}`;
    expect(m!.kind).toBe('opening');

    // Importing again skips existing SKUs unless "update" is chosen
    const again = await admin.post('/api/import/preview', { kind: 'products', table, mapping });
    expect(again.body.rows.find((r: { rowNo: number }) => r.rowNo === 2).action).toBe('skip');
  });

  it('reads Excel files', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Customers');
    ws.addRow(['Customer Name', 'Mobile No', 'Address', 'Outstanding']);
    ws.addRow([`Reddy ${h.tag}`, '98480 11111', 'Kavali', 4550]);
    ws.addRow([`Advance ${h.tag}`, '98480 22222', 'Bogole', '1200 Cr']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await admin.post('/api/import/parse', { kind: 'customers', filename: 'cust.xlsx', base64: b64(buf) });
    expect(parsed.body.mapping).toMatchObject({ name: 0, phone: 1, address: 2, opening: 3 });
    const applied = await admin.post('/api/import/apply', { kind: 'customers', ...parsed.body });
    expect(applied.status).toBe(200);
    const list = (await admin.get(`/api/customers?search=${h.tag}`)).body as { name: string; phone: string; balance_paise: number }[];
    expect(list.find((c) => c.name.startsWith('Reddy'))).toMatchObject({ phone: '9848011111', balance_paise: 455000 });
    expect(list.find((c) => c.name.startsWith('Advance'))!.balance_paise).toBe(-120000);
  });

  it('only admin can import', async () => {
    const counter = await h.loginAs('counter');
    expect((await counter.post('/api/import/parse', { kind: 'products', filename: 'a.csv', base64: b64('a,b\n1,2') })).status).toBe(403);
  });
});

describe('backup and restore', () => {
  it('a backup restores exactly, leaving out the Gemini key', async () => {
    await h.app`insert into settings (key, value) values ('geminiApiKey', ${h.app.json('secret-key')}) on conflict (key) do update set value = excluded.value`;
    const p = await h.product({ qty: 7 });
    await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 2000, discountBp: 0 }] });

    const dir = join(h.db.backupDir, 'test');
    const r = await writeBackup(h.owner, 'sample', dir, 'manual');
    const data = readBackupFile(join(dir, r.file));
    expect(JSON.stringify(data.tables.settings)).not.toContain('secret-key');

    // change things after the backup
    const extra = await h.product({ qty: 3 });
    await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });

    await restoreBackupData(h.owner, data);
    const after = await createBackupData(h.owner, 'sample');
    // compare with the backup file itself (not a second snapshot, which could catch a late write)
    for (const t of Object.keys(data.counts)) {
      if (t === 'audit_log' || t === 'users') continue; // login during the test adds rows
      expect(after.counts[t], t).toBe(data.counts[t]);
    }
    const [gone] = await h.app`select 1 from products where id = ${extra}`;
    expect(gone).toBeUndefined();
    expect(await h.stockOf(p)).toBe(5000);
    const [key] = await h.app`select value from settings where key = 'geminiApiKey'`;
    expect(key!.value).toBe('secret-key'); // this computer's key is kept

    // a restore logs everyone out
    expect((await admin.get('/api/dashboard')).body.code).toBe('NOT_LOGGED_IN');
    admin = await h.loginAs('admin');

    // id sequences continue after the restored rows
    const again = await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(again.status).toBe(200);
    const [{ ok }] = (await h.app`select bool_and(sb.qty_milli = m.total) as ok from stock_balances sb
                                   join (select product_id, sum(qty_milli) total from stock_movements group by product_id) m using (product_id)`) as unknown as [{ ok: boolean }];
    expect(ok).toBe(true);
  });

  it('rejects a file that is not a backup', async () => {
    const r = await admin.post('/api/backups/restore', { base64: b64('hello'), confirm: 'RESTORE' });
    expect(r.body.code).toBe('BAD_BACKUP');
  });
});

describe('settings', () => {
  it('validates the invoice prefix so numbers stay within 16 characters', async () => {
    const r = await admin.put('/api/settings', { invoicePrefix: 'KPHW1' });
    expect(r.status).toBe(400);
  });
  it('never sends the Gemini key back to the screen', async () => {
    await admin.put('/api/settings', { geminiApiKey: 'abc' });
    const s = (await admin.get('/api/settings')).body;
    expect(s.geminiApiKey).toBeUndefined();
    expect(s.geminiApiKeySet).toBe(true);
  });
});

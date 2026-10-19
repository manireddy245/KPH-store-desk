import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ReadBill } from '../src/services/scanner.js';
import { makeHarness } from './harness.js';

let fakeRead: ReadBill;
let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let stock: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let supplierId: number;
const gstin = '37AABCU9603R1ZM';

beforeAll(async () => {
  h = await makeHarness({ scanner: async () => fakeRead });
  admin = await h.loginAs('admin');
  stock = await h.loginAs('stock');
  counter = await h.loginAs('counter');
  const s = await admin.post('/api/suppliers', { name: `UltraTech dealer ${h.tag}`, gstin, leadTimeDays: 2 });
  supplierId = s.body.id;
});
afterAll(() => h.close());

const bill = (over: Record<string, unknown> = {}) => ({
  supplierId,
  supplierInvoiceNo: `NLR/${randomUUID().slice(0, 6)}`,
  supplierInvoiceDate: '2026-10-17',
  ...over,
});

async function supplierPayable() {
  const list = (await admin.get(`/api/suppliers?search=${h.tag}`)).body as { id: number; payable_paise: number }[];
  return list.find((s) => s.id === supplierId)!.payable_paise;
}

describe('entering a purchase', () => {
  it('adds stock, posts the supplier bill to accounts and updates cost price', async () => {
    const p = await h.product({ qty: 10, cost: 28000 });
    const before = await supplierPayable();
    const r = await stock.post('/api/purchases', bill({
      freightPaise: 20000,
      lines: [{ productId: p, description: 'ULTRATECH PPC 50 KG', qtyMilli: 200000, taxablePaise: 5840000, gstRateBp: 1800 }],
    }));
    expect(r.status).toBe(200);
    expect(r.body.number).toMatch(/^PUR\/\d{2}-\d{2}\/\d{6}$/);
    expect(await h.stockOf(p)).toBe(210000);

    const d = (await stock.get(`/api/purchases/${r.body.id}`)).body;
    // 58,400 + 9% + 9% (5,256 each) + 200 freight = 69,112
    expect(d).toMatchObject({ taxable_paise: 5840000, cgst_paise: 525600, sgst_paise: 525600, freight_paise: 20000, total_paise: 6911200, status: 'posted' });
    expect(d.lines[0]).toMatchObject({ unit_cost_paise: 29200, qty_milli: 200000 });
    expect((await supplierPayable()) - before).toBe(6911200);

    const [m] = await h.app`select kind, qty_milli, unit_cost_paise from stock_movements where product_id = ${p} and kind = 'purchase'`;
    expect(m).toMatchObject({ qty_milli: 200000, unit_cost_paise: 29200 });
    const [pr] = await h.app`select cost_price_paise from products where id = ${p}`;
    expect(pr!.cost_price_paise).toBe(29200);
    const [v] = await h.app`select sum(dr_paise) dr, sum(cr_paise) cr from voucher_lines where voucher_id = ${d.voucher_id}`;
    expect(v!.dr).toBe(v!.cr);
    const [alias] = await h.app`select product_id from product_aliases where supplier_id = ${supplierId} and alias = 'ultratech ppc 50kg'`;
    expect(alias!.product_id).toBe(p);
  });

  it('refuses the same supplier bill twice, and stock is not added again', async () => {
    const p = await h.product({ qty: 0 });
    const b = bill({ lines: [{ productId: p, qtyMilli: 5000, taxablePaise: 100000, gstRateBp: 1800 }] });
    expect((await stock.post('/api/purchases', b)).status).toBe(200);
    const again = await stock.post('/api/purchases', { ...b, supplierInvoiceNo: b.supplierInvoiceNo.toUpperCase() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE_BILL');
    expect(await h.stockOf(p)).toBe(5000);
  });

  it('puts a small difference with the bill total into round-off, but refuses a big one', async () => {
    const p = await h.product({ qty: 0 });
    const line = { productId: p, qtyMilli: 3000, taxablePaise: 100050, gstRateBp: 1800 }; // 1000.50 + 90.05 + 90.05 = 1180.60
    const ok = await stock.post('/api/purchases', bill({ billTotalPaise: 118100, lines: [line] }));
    expect(ok.status).toBe(200);
    expect((await stock.get(`/api/purchases/${ok.body.id}`)).body).toMatchObject({ round_off_paise: 40, total_paise: 118100 });
    const bad = await stock.post('/api/purchases', bill({ billTotalPaise: 130000, lines: [line] }));
    expect(bad.body.code).toBe('TOTAL_MISMATCH');
  });

  it('only admin and stock staff enter purchases; only admin creates new products', async () => {
    const p = await h.product();
    expect((await counter.post('/api/purchases', bill({ lines: [{ productId: p, qtyMilli: 1000, taxablePaise: 100, gstRateBp: 1800 }] }))).status).toBe(403);
    const newLine = { newProduct: { name: `Weather Plus ${h.tag}`, unitCode: 'bag' }, description: 'ULTRATECH WEATHER PLUS 50KG', qtyMilli: 50000, taxablePaise: 1650000, gstRateBp: 1800, hsn: '2523' };
    expect((await stock.post('/api/purchases', bill({ lines: [newLine] }))).body.code).toBe('FORBIDDEN');
    const ok = await admin.post('/api/purchases', bill({ lines: [newLine] }));
    expect(ok.status).toBe(200);
    expect(ok.body.createdProducts).toHaveLength(1);
    const [np] = await h.app`select sku, cost_price_paise, hsn from products where id = ${ok.body.createdProducts[0]}`;
    expect(np).toMatchObject({ cost_price_paise: 33000, hsn: '2523' });
    expect(np!.sku).toMatch(/^NEW-/);
    expect(await h.stockOf(ok.body.createdProducts[0])).toBe(50000);
  });

  it('cancelling takes the stock off again (needs admin PIN for stock staff)', async () => {
    const p = await h.product({ qty: 0 });
    const r = await stock.post('/api/purchases', bill({ lines: [{ productId: p, qtyMilli: 10000, taxablePaise: 200000, gstRateBp: 1800 }] }));
    expect((await stock.post(`/api/purchases/${r.body.id}/cancel`, { reason: 'Entered twice' })).body.code).toBe('NEEDS_OVERRIDE');
    const o = await stock.post('/api/auth/override', { permission: 'billing.cancel', approverId: h.users.admin.id, pin: '1111', context: { purchaseId: r.body.id } });
    const c = await stock.post(`/api/purchases/${r.body.id}/cancel`, { reason: 'Entered twice', overrideToken: o.body.token });
    expect(c.status).toBe(200);
    expect(await h.stockOf(p)).toBe(0);
  });

  it("can't cancel a purchase whose stock has already been sold", async () => {
    const p = await h.product({ qty: 0 });
    const r = await admin.post('/api/purchases', bill({ lines: [{ productId: p, qtyMilli: 10000, taxablePaise: 200000, gstRateBp: 1800 }] }));
    await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 8000, discountBp: 0 }] });
    const c = await admin.post(`/api/purchases/${r.body.id}/cancel`, { reason: 'wrong' });
    expect(c.body.code).toBe('STOCK_ALREADY_SOLD');
  });
});

describe('scanning a supplier bill', () => {
  const jpeg = Buffer.from('fake-jpeg-bytes-' + randomUUID()).toString('base64');

  it('needs the Gemini key', async () => {
    await admin.put('/api/settings', { geminiApiKey: '' });
    fakeRead = { supplier: { name: null, gstin: null, phone: null, address: null }, invoice: { number: null, date: null, is_interstate: null }, lines: [], freight: null, round_off: null, grand_total: null, notes: null };
    const r = await stock.post('/api/purchases/scan', { pages: [{ mimeType: 'image/jpeg', base64: jpeg }] });
    expect(r.body.code).toBe('SCANNER_KEY');
  });

  it('reads a bill into a draft: supplier by GSTIN, remembered product, new product, warnings', async () => {
    await admin.put('/api/settings', { geminiApiKey: 'test-key' });
    const known = await h.product({ qty: 0, cost: 30500 });
    await h.app`update products set name = ${'UltraTech OPC 53 Grade Cement 50kg ' + h.tag} where id = ${known}`;
    await admin.post('/api/purchases', bill({ lines: [{ productId: known, description: 'OPC 53 GR 50 KG', qtyMilli: 1000, taxablePaise: 30500, gstRateBp: 1800 }] }));

    fakeRead = {
      supplier: { name: 'ULTRATECH DEALER', gstin, phone: null, address: null },
      invoice: { number: 'NLR/2627/04418', date: '2026-10-17', is_interstate: false },
      lines: [
        { description: 'OPC 53 GR 50 KG', item_code: null, hsn: '2523', quantity: 100, unit: 'BAG', rate: 305, discount_percent: null, taxable_value: 30500, gst_percent: 18, line_total: 35990 },
        { description: 'ULTRATECH WEATHER PLUS 50KG XYZ', item_code: null, hsn: '2523', quantity: 50, unit: 'BAG', rate: 330, discount_percent: null, taxable_value: null, gst_percent: 18, line_total: null },
        { description: 'OPC 53 GR 50 KG', item_code: null, hsn: '2523', quantity: 20, unit: 'BAG', rate: 3050, discount_percent: null, taxable_value: 30500, gst_percent: 18, line_total: null },
      ],
      freight: 2000,
      round_off: null,
      grand_total: 57460,
      notes: null,
    };
    const r = await stock.post('/api/purchases/scan', { pages: [{ mimeType: 'image/jpeg', base64: jpeg }] });
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.supplier).toMatchObject({ matchedId: supplierId, matchedBy: 'gstin' });
    expect(d.invoice).toMatchObject({ number: 'NLR/2627/04418', date: '2026-10-17' });
    expect(d.lines[0]).toMatchObject({ qtyMilli: 100000, taxablePaise: 3050000, gstRateBp: 1800, match: { kind: 'remembered', productId: known } });
    expect(d.lines[1].taxablePaise).toBe(1650000);
    expect(d.lines[1].warnings).toContain('Line amount worked out from rate × quantity');
    expect(d.lines[2].warnings.join(' ')).toMatch(/does not match the line amount/);
    expect(d.freightPaise).toBe(200000);
    expect(d.grandTotalPaise).toBe(5746000);
    expect(d.duplicateOf).toBeNull();

    const page = await h.server.inject({ method: 'GET', url: `/api/purchases/scans/${d.scanId}/pages/1`, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${stock.token}` } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('image/jpeg');
  });

  it('warns when the same photo was already used for a saved purchase', async () => {
    const p = await h.product({ qty: 0 });
    const s1 = await stock.post('/api/purchases/scan', { pages: [{ mimeType: 'image/jpeg', base64: jpeg }] });
    await stock.post('/api/purchases', bill({ scanId: s1.body.scanId, lines: [{ productId: p, qtyMilli: 1000, taxablePaise: 100, gstRateBp: 1800 }] }));
    const s2 = await stock.post('/api/purchases/scan', { pages: [{ mimeType: 'image/jpeg', base64: jpeg }] });
    expect(s2.body.duplicateOf).toMatch(/^PUR\//);
  });

  it('counter staff cannot scan purchases', async () => {
    expect((await counter.post('/api/purchases/scan', { pages: [{ mimeType: 'image/jpeg', base64: jpeg }] })).status).toBe(403);
  });

  it('rejects files that are not photos or PDFs', async () => {
    const r = await stock.post('/api/purchases/scan', { pages: [{ mimeType: 'text/plain', base64: jpeg }] });
    expect(r.body.code).toBe('BAD_FILE');
  });
});

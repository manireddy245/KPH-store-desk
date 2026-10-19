import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { istDate } from '@kph/core';
import { makeHarness } from './harness.js';

/**
 * A small, known set of bills, all to Tamil Nadu (33) or one Maharashtra (27) business, so the
 * figures can be picked out of today's GSTR-1 even though other test files bill today too.
 */
let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
const today = istDate();
const range = `from=${today}&to=${today}`;
let A: number; // ₹1,000 + 18%, HSN 8888, bag
let B: number; // ₹500 + 12%, HSN 7777, rod
let inv1: { id: number; number: string }; // B2B (Maharashtra)
let inv2: { id: number; number: string }; // walk-in TN ₹1,77,000 → B2CL
let inv3: { id: number; number: string }; // walk-in TN ₹11,800 → B2CS
let cn1: string;
let cn2: string;
let before3b: { outward: { taxable: number; igst: number }; interStateUnregistered: { pos: string; taxable: number }[] };

const lineIds = async (id: number) => (await admin.get(`/api/invoices/${id}`)).body.lines.map((l: { id: number }) => l.id) as number[];

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  A = await h.product({ price: 100000, qty: 500, maxDisc: { type: 'pct', value: 1000 } });
  B = await h.product({ price: 50000, qty: 500 });
  await h.app`update products set hsn = '8888', unit_code = 'bag' where id = ${A}`;
  await h.app`update products set hsn = '7777', unit_code = 'rod', gst_rate_bp = 1200 where id = ${B}`;
  before3b = (await admin.get(`/api/reports/gstr3b?${range}`)).body;

  const c = await admin.post('/api/customers', { name: `Mumbai Traders ${h.tag}`, gstin: '27AAPFU0939F1ZV', address: 'Andheri, Mumbai' });
  expect(c.status).toBe(200);
  const r1 = await admin.post('/api/invoices', { customerId: c.body.id, paymentMode: 'cash', lines: [{ productId: A, qtyMilli: 2000, discountBp: 500 }, { productId: B, qtyMilli: 3000, discountBp: 0 }] });
  const r2 = await admin.post('/api/invoices', { customerName: 'Chennai buyer', customerAddress: 'T Nagar, Chennai', placeOfSupply: '33', paymentMode: 'cash', lines: [{ productId: A, qtyMilli: 150000, discountBp: 0 }] });
  const r3 = await counter.post('/api/invoices', { placeOfSupply: '33', paymentMode: 'cash', lines: [{ productId: A, qtyMilli: 10000, discountBp: 0 }] });
  for (const r of [r1, r2, r3]) expect(r.status, JSON.stringify(r.body)).toBe(200);
  [inv1, inv2, inv3] = [r1.body, r2.body, r3.body];

  const ret = async (inv: { id: number }, qty: number) => {
    const [line] = await lineIds(inv.id);
    const r = await admin.post(`/api/invoices/${inv.id}/returns`, { reason: 'test return', refundMode: 'cash', lines: [{ invoiceLineId: line, qtyMilli: qty, restock: true }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.number as string;
  };
  cn1 = await ret(inv1, 1000);
  cn2 = await ret(inv2, 10000);
  await ret(inv3, 2000);
});
afterAll(() => h.close());

describe('GSTR-1', () => {
  it('puts each bill and note in the right table', async () => {
    const g = (await admin.get(`/api/reports/gstr1?${range}`)).body;

    const b2b = g.b2b.filter((r: { number: string }) => r.number === inv1.number);
    expect(b2b).toEqual([
      expect.objectContaining({ gstin: '27AAPFU0939F1ZV', pos: '27-Maharashtra', rate: 12, taxable: 150000, igst: 18000, cgst: 0 }),
      expect.objectContaining({ rate: 18, taxable: 190000, igst: 34200 }),
    ]);

    expect(g.b2cl.filter((r: { number: string }) => r.number === inv2.number)).toEqual([expect.objectContaining({ pos: '33-Tamil Nadu', rate: 18, taxable: 15000000, igst: 2700000, value: 17700000 })]);
    expect(g.b2cl.find((r: { number: string }) => r.number === inv3.number)).toBeUndefined();

    // B2CS TN 18%: bill 3 (₹10,000) less its return (₹2,000) — bill 2's return goes to CDNUR, not here
    expect(g.b2cs.filter((r: { pos: string }) => r.pos === '33-Tamil Nadu')).toEqual([expect.objectContaining({ rate: 18, taxable: 800000, igst: 144000 })]);

    expect(g.cdnr.filter((r: { number: string }) => r.number === cn1)).toEqual([expect.objectContaining({ gstin: '27AAPFU0939F1ZV', rate: 18, taxable: 95000, invoiceNumber: inv1.number })]);
    expect(g.cdnur.filter((r: { number: string }) => r.number === cn2)).toEqual([expect.objectContaining({ rate: 18, taxable: 1000000, igst: 180000, invoiceNumber: inv2.number })]);

    // HSN: B2B 8888 = 2 − 1 bags; B2C 8888 = 150 − 10 + 10 − 2 = 148 bags; 7777 = 3 rods (NOS)
    expect(g.hsnB2b.filter((r: { hsn: string }) => r.hsn === '8888')).toEqual([expect.objectContaining({ uqc: 'BAG', qty: 1000, taxable: 95000, igst: 17100 })]);
    expect(g.hsnB2b.filter((r: { hsn: string }) => r.hsn === '7777')).toEqual([expect.objectContaining({ uqc: 'NOS', qty: 3000, rate: 12 })]);
    expect(g.hsnB2c.filter((r: { hsn: string }) => r.hsn === '8888')).toEqual([expect.objectContaining({ qty: 148000, taxable: 14800000 })]);

    const docs = g.docs.find((d: { nature: string }) => d.nature === 'Invoices for outward supply');
    expect(docs.total).toBeGreaterThanOrEqual(3);
    expect(g.docs.some((d: { nature: string }) => d.nature === 'Credit Note')).toBe(true);
  });

  it('exports the GST offline-tool workbook', async () => {
    const res = await h.server.inject({ method: 'GET', url: `/api/reports/gstr1?${range}&format=xlsx`, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${admin.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(`GSTR-1_${today}_to_${today}.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['b2b,sez,de', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'hsn(b2b)', 'hsn(b2c)', 'docs']);
    const b2cl = wb.getWorksheet('b2cl')!;
    expect(b2cl.getRow(4).getCell(1).value).toBe('Invoice Number');
    const row = b2cl.getSheetValues().find((r) => Array.isArray(r) && r[1] === inv2.number) as unknown[];
    expect(row[3]).toBe(177000); // rupees
    expect(row[4]).toBe('33-Tamil Nadu');
  });

  it('is for reports.view only', async () => {
    expect((await counter.get(`/api/reports/gstr1?${range}`)).status).toBe(403);
    expect((await counter.get(`/api/reports/discounts?${range}`)).status).toBe(403);
  });

  it('accepts months and quarters, refuses nonsense', async () => {
    expect((await admin.get('/api/reports/gstr1?period=2026-Q3')).body).toMatchObject({ from: '2026-10-01', to: '2026-12-31' });
    expect((await admin.get('/api/reports/gstr1?period=2026-13')).status).toBe(400);
    expect((await admin.get('/api/reports/gstr1?from=2026-10-10&to=2026-10-01')).status).toBe(400);
  });
});

describe('GSTR-3B', () => {
  it('outward supplies net of returns; 3.2 inter-state to unregistered by state', async () => {
    const d = (await admin.get(`/api/reports/gstr3b?${range}`)).body;
    // bills: 1,900 + 1,500 + 1,50,000 + 10,000; returns: 950 + 10,000 + 2,000
    expect(d.outward.taxable - before3b.outward.taxable).toBe(16340000 - 1295000);
    const tn = (x: typeof before3b) => x.interStateUnregistered.find((p) => p.pos === '33-Tamil Nadu')?.taxable ?? 0;
    expect(tn(d) - tn(before3b)).toBe(14800000);
  });

  it('input tax credit from purchase bills by bill date', async () => {
    const s = await admin.post('/api/suppliers', { name: `Old supplier ${h.tag}`, gstin: '37AABCL1234F1ZX' });
    const p = await admin.post('/api/purchases', { supplierId: s.body.id, supplierInvoiceNo: `R-${h.tag}`, supplierInvoiceDate: '2019-05-20', lines: [{ productId: A, qtyMilli: 10000, taxablePaise: 5000000, gstRateBp: 1800 }] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const d = (await admin.get('/api/reports/gstr3b?period=2019-05')).body;
    expect(d.itc.purchases).toMatchObject({ cgst: 450000, sgst: 450000, igst: 0, bills: 1 });
    const reg = (await admin.get('/api/reports/purchase-register?period=2019-05')).body;
    expect(reg.purchases.map((x: { supplier_invoice_no: string }) => x.supplier_invoice_no)).toEqual([`R-${h.tag}`]);
    expect(reg.totals).toMatchObject({ taxable: 5000000, total: 5900000 });
  });
});

describe('registers and discounts', () => {
  it('sales register lists the bills and returns', async () => {
    const d = (await admin.get(`/api/reports/sales-register?${range}`)).body;
    const nums = d.invoices.map((x: { number: string }) => x.number);
    expect(nums).toEqual(expect.arrayContaining([inv1.number, inv2.number, inv3.number]));
    expect(d.creditNotes.map((x: { number: string }) => x.number)).toEqual(expect.arrayContaining([cn1, cn2]));
    const res = await h.server.inject({ method: 'GET', url: `/api/reports/sales-register?${range}&format=xlsx`, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${admin.token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('discount report per staff member and product', async () => {
    const d = (await admin.get(`/api/reports/discounts?${range}`)).body;
    const me = d.byStaff.find((x: { user_id: number }) => x.user_id === h.users.admin.id);
    expect(me).toMatchObject({ discount: 10000 }); // 5% of ₹2,000
    expect(d.byProduct.find((x: { product_id: number }) => x.product_id === A)).toMatchObject({ discount: 10000, discounted_lines: 1, max_bp: 500 });
  });
});

describe('e-way bill helper', () => {
  it('lists what is missing, then builds the portal JSON', async () => {
    await admin.put('/api/settings', { storeGstin: '37AAAAA0000A1Z1', storePincode: '524201', storePlace: 'Kavali' });
    const st = (await admin.get(`/api/invoices/${inv2.id}/eway`)).body;
    expect(st.needed).toBe(true);
    expect(st.missing.join(' ')).toContain('Delivery PIN code');
    expect((await admin.get(`/api/invoices/${inv3.id}/eway`)).body.needed).toBe(false);
    expect((await admin.get(`/api/invoices/${inv2.id}/eway.json`)).status).toBe(400);

    expect((await admin.put(`/api/invoices/${inv2.id}/transport`, { vehicleNo: '1234' })).status).toBe(400);
    const saved = await admin.put(`/api/invoices/${inv2.id}/transport`, { toPlace: 'Chennai', toPincode: '600017', distanceKm: 175, vehicleNo: 'ap 39 tb 4521' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.missing).toEqual([]);
    expect(saved.body.transport.vehicle_no).toBe('AP39TB4521');

    const res = await h.server.inject({ method: 'GET', url: `/api/invoices/${inv2.id}/eway.json`, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${admin.token}` } });
    expect(res.statusCode).toBe(200);
    const j = JSON.parse(res.body);
    expect(j.version).toBe('1.0.0621');
    const b = j.billLists[0];
    expect(b).toMatchObject({ docNo: inv2.number, fromGstin: '37AAAAA0000A1Z1', fromPincode: 524201, toGstin: 'URP', toPincode: 600017, actToStateCode: 33, toStateCode: 33, totalValue: 150000, igstValue: 27000, cgstValue: 0, totInvValue: 177000, transMode: '1', transDistance: '175', vehicleNo: 'AP39TB4521' });
    expect(b.itemList).toEqual([expect.objectContaining({ hsnCode: 8888, quantity: 150, qtyUnit: 'BAG', taxableAmount: 150000, igstRate: 18, cgstRate: 0 })]);

    // pending until the e-way bill number is saved
    const pend = async () => (await admin.get(`/api/reports/eway-pending?${range}`)).body.find((x: { id: number }) => x.id === inv2.id).state;
    expect(await pend()).toBe('pending');
    expect((await admin.put(`/api/invoices/${inv2.id}/transport`, { toPlace: 'Chennai', toPincode: '600017', distanceKm: 175, vehicleNo: 'AP39TB4521', ewbNo: '1234 5678 9012' })).status).toBe(200);
    expect(await pend()).toBe('done');
    const inv = (await admin.get(`/api/invoices/${inv2.id}`)).body;
    expect(inv.transport).toMatchObject({ ewb_no: '123456789012', ewb_date: today });
    await admin.put('/api/settings', { storeGstin: '', storePincode: '524201' });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calcBill, istDate } from '@kph/core';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let stock: Awaited<ReturnType<typeof h.loginAs>>;
let P: number; // ₹350 + 18%, 100 in stock
let Q: number; // ₹1,000 + 18%, 5 in stock
const daysAgo = (n: number) => new Date(Date.now() + 5.5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  stock = await h.loginAs('stock');
  P = await h.product({ price: 35_000, qty: 100, cost: 30_000 });
  Q = await h.product({ price: 100_000, qty: 5 });
});
afterAll(() => h.close());

describe('rate board', () => {
  it('admin updates today’s prices; history kept; WhatsApp message with GST-inclusive rates', async () => {
    expect((await counter.post('/api/rate-board/products', { productId: P, on: true })).status).toBe(403);
    expect((await admin.post('/api/rate-board/products', { productId: P, on: true })).status).toBe(200);
    const board = (await counter.get('/api/rate-board')).body;
    expect(board.find((r: { id: number }) => r.id === P)).toMatchObject({ sale_price_paise: 35_000, incl_paise: 41_300 });
    expect((await counter.put('/api/rate-board', { rates: [{ productId: P, salePricePaise: 36_000 }] })).status).toBe(403);
    const r = await admin.put('/api/rate-board', { rates: [{ productId: P, salePricePaise: 36_000 }] });
    expect(r.body.changed).toBe(1);
    const hist = (await counter.get(`/api/products/${P}/price-history`)).body;
    expect(hist[0]).toMatchObject({ old_value: 35_000, new_value: 36_000 });
    const msg = (await counter.get('/api/rate-board/message?lang=en')).body.text as string;
    expect(msg).toContain("Today's rates");
    expect(msg).toMatch(/Test T-[^:]+: ₹425\/bag/); // 360 + 18% = 424.80 → ₹425
    expect((await counter.get('/api/rate-board/message?lang=te')).body.text).toContain('ఈ రోజు ధరలు');
    await admin.post('/api/rate-board/products', { productId: P, on: false });
  });
});

describe('quotations', () => {
  it('Full House estimate by stage; edit; convert to a bill once; stock checked', async () => {
    const lines = [
      { stage: 'Foundation & structure', productId: P, qtyMilli: 40_000, discountBp: 0 },
      { stage: 'Final coat', productId: Q, qtyMilli: 2_000, discountBp: 0 },
    ];
    const c = await counter.post('/api/quotes', { customerName: 'Venkata Rao', customerPhone: '9000012345', site: 'New house, Bogole', template: 'full_house', lines });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.number).toMatch(/^QTN\//);
    const expected = calcBill([{ qtyMilli: 40_000, ratePaise: 36_000, discountBp: 0, gstRateBp: 1800 }, { qtyMilli: 2_000, ratePaise: 100_000, discountBp: 0, gstRateBp: 1800 }]);
    expect(c.body.totalPaise).toBe(expected.totalPaise);
    const q = (await counter.get(`/api/quotes/${c.body.id}`)).body;
    expect(q.lines.map((l: { stage: string }) => l.stage)).toEqual(['Foundation & structure', 'Final coat']);
    expect(q.valid_until > istDate()).toBe(true);

    // asks for more than is in stock → the conversion is refused and the quote stays open
    expect((await counter.put(`/api/quotes/${c.body.id}`, { ...q, customerName: 'Venkata Rao', lines: [...lines.slice(0, 1), { ...lines[1], qtyMilli: 9_000 }] })).status).toBe(200);
    const fail = await counter.post(`/api/quotes/${c.body.id}/convert`, { paymentMode: 'cash' });
    expect(fail.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await counter.get(`/api/quotes/${c.body.id}`)).body.status).toBe('open');

    expect((await counter.put(`/api/quotes/${c.body.id}`, { customerName: 'Venkata Rao', site: 'New house, Bogole', lines })).status).toBe(200);
    const bill = await counter.post(`/api/quotes/${c.body.id}/convert`, { paymentMode: 'cash' });
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    const inv = (await admin.get(`/api/invoices/${bill.body.id}`)).body;
    expect(inv.total_paise).toBe(expected.totalPaise);
    expect(inv.customer_name).toBe('Venkata Rao');
    expect((await counter.get(`/api/quotes/${c.body.id}`)).body).toMatchObject({ status: 'converted', invoice_number: bill.body.number });
    expect((await counter.post(`/api/quotes/${c.body.id}/convert`, { paymentMode: 'cash' })).status).toBe(409);
    expect((await counter.put(`/api/quotes/${c.body.id}`, { lines })).status).toBe(409);
  });

  it('prices changed since the quote: staff use today’s prices, admin may keep the quoted ones', async () => {
    const c = await counter.post('/api/quotes', { customerName: 'Sita', lines: [{ productId: P, qtyMilli: 1_000 }] });
    await admin.put('/api/rate-board', { rates: [{ productId: P, salePricePaise: 37_000 }] });
    const kept = await counter.post(`/api/quotes/${c.body.id}/convert`, { paymentMode: 'cash', prices: 'quoted' });
    expect(kept.status).toBe(403);
    const today = await counter.post(`/api/quotes/${c.body.id}/convert`, { paymentMode: 'cash', prices: 'today' });
    expect(today.status, JSON.stringify(today.body)).toBe(200);
    expect((await admin.get(`/api/invoices/${today.body.id}`)).body.lines[0].rate_paise).toBe(37_000);
    const c2 = await counter.post('/api/quotes', { customerName: 'Sita', lines: [{ productId: P, qtyMilli: 1_000, ratePaise: 36_000 }] });
    expect((await admin.post(`/api/quotes/${c2.body.id}/convert`, { paymentMode: 'cash' })).status).toBe(200);
  });
});

describe('deliveries', () => {
  it('partial deliveries against one bill, status, cancel frees the quantity; returns reduce what is left', async () => {
    const b = await counter.post('/api/invoices', { paymentMode: 'cash', customerName: 'Site X', customerAddress: 'Kavali', lines: [{ productId: P, qtyMilli: 10_000, discountBp: 0 }] });
    const lineId = (await admin.get(`/api/invoices/${b.body.id}`)).body.lines[0].id;
    const d1 = await counter.post(`/api/invoices/${b.body.id}/deliveries`, { vehicleNo: 'ap 39 tb 1234', driverName: 'Mallesh', chargePaise: 50_000, lines: [{ invoiceLineId: lineId, qtyMilli: 6_000 }] });
    expect(d1.status, JSON.stringify(d1.body)).toBe(200);
    expect(d1.body.number).toMatch(/^DC\//);
    expect((await stock.post(`/api/invoices/${b.body.id}/deliveries`, { lines: [{ invoiceLineId: lineId, qtyMilli: 5_000 }] })).status).toBe(400);
    const d2 = await stock.post(`/api/invoices/${b.body.id}/deliveries`, { lines: [{ invoiceLineId: lineId, qtyMilli: 4_000 }] });
    expect(d2.status).toBe(200);
    expect((await counter.get(`/api/invoices/${b.body.id}/deliverable`)).body[0].remaining_milli).toBe(0);

    expect((await counter.post(`/api/deliveries/${d1.body.id}/status`, { status: 'out' })).status).toBe(200);
    expect((await counter.post(`/api/deliveries/${d1.body.id}/status`, { status: 'delivered', receivedBy: 'Watchman' })).status).toBe(200);
    expect((await counter.post(`/api/deliveries/${d1.body.id}/status`, { status: 'cancelled' })).status).toBe(409);
    expect((await counter.post(`/api/deliveries/${d2.body.id}/status`, { status: 'cancelled' })).status).toBe(200);
    expect((await counter.get(`/api/invoices/${b.body.id}/deliverable`)).body[0].remaining_milli).toBe(4_000);

    expect((await admin.post(`/api/invoices/${b.body.id}/returns`, { reason: 'not needed', refundMode: 'cash', lines: [{ invoiceLineId: lineId, qtyMilli: 1_000, restock: true }] })).status).toBe(200);
    expect((await counter.get(`/api/invoices/${b.body.id}/deliverable`)).body[0].remaining_milli).toBe(3_000);

    const today = (await counter.get(`/api/deliveries?date=${istDate()}`)).body;
    const mine = today.find((d: { id: number }) => d.id === d1.body.id);
    expect(mine).toMatchObject({ status: 'delivered', vehicle_no: 'AP39TB1234', received_by: 'Watchman' });
    expect(mine.items).toContain('× 6 bag');
    const ch = (await counter.get(`/api/deliveries/${d1.body.id}`)).body;
    expect(ch.lines[0]).toMatchObject({ qty_milli: 6_000 });
  });
});

describe('cement stock age', () => {
  it('oldest bags first; warns when any bags are older than the limit', async () => {
    const C = await h.product({ price: 35_000, qty: 10 });
    await h.app`update products set track_batches = true where id = ${C}`;
    const s = await admin.post('/api/suppliers', { name: `Cement dealer ${h.tag}` });
    const buy = (no: string, qty: number, packedOn: string, batch: string) =>
      admin.post('/api/purchases', { supplierId: s.body.id, supplierInvoiceNo: `${no}-${h.tag}`, supplierInvoiceDate: istDate(), lines: [{ productId: C, qtyMilli: qty * 1000, taxablePaise: qty * 30_000, gstRateBp: 1800, packedOn, batchCode: batch }] });
    expect((await buy('B1', 20, daysAgo(70), 'B1')).status).toBe(200);
    expect((await buy('B2', 15, daysAgo(10), 'B2')).status).toBe(200);
    let age = (await counter.get(`/api/stock-age?productIds=${C}`)).body.products[0];
    expect(age.stockMilli).toBe(45_000);
    expect(age.oldest).toMatchObject({ batch: 'B1', ageDays: 70, qtyMilli: 20_000 });
    expect(age.warn).toBe(true);
    // sell 30 bags: the opening stock and most of B1 are gone (oldest first)… what's left is the newest 15 = B2
    expect((await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: C, qtyMilli: 30_000, discountBp: 0 }] })).status).toBe(200);
    age = (await counter.get(`/api/stock-age?productIds=${C}`)).body.products[0];
    expect(age.layers).toEqual([expect.objectContaining({ batch: 'B2', qtyMilli: 15_000, ageDays: 10 })]);
    expect(age.warn).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvoice } from '../src/services/billing.js';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let stock: Awaited<ReturnType<typeof h.loginAs>>;
let F: number; // sells 4 a day
let D: number; // no sale for months
let supplierId: number;
let otherSupplier: number;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  stock = await h.loginAs('stock');
  const [c] = await h.app<{ id: number }[]>`insert into categories (name, target_days) values (${'Cement ' + h.tag}, 15) returning id`;
  F = await h.product({ price: 35_000, qty: 200, cost: 30_000 });
  D = await h.product({ price: 50_000, qty: 10, cost: 40_000 });
  await h.app`update products set category_id = ${c!.id}, created_at = now() - interval '300 days' where id in (${F}, ${D})`;
  const s = await admin.post('/api/suppliers', { name: `Lead3 ${h.tag}`, leadTimeDays: 3 });
  supplierId = s.body.id;
  otherSupplier = (await admin.post('/api/suppliers', { name: `Other ${h.tag}` })).body.id;
  await admin.post('/api/purchases', { supplierId, supplierInvoiceNo: `S-${h.tag}`, supplierInvoiceDate: new Date().toISOString().slice(0, 10), lines: [{ productId: F, qtyMilli: 1_000, taxablePaise: 30_000, gstRateBp: 1800 }] });
  // 120 bags over the last 30 days (4 a day); stock ends at 200 + 1 − 120 = 81
  for (let d = 0; d < 30; d++) await createInvoice(h.app, h.ctx('admin'), { paymentMode: 'cash', lines: [{ productId: F, qtyMilli: 4_000, discountBp: 0 }] }, { at: daysAgo(d) });
  // D sold once, 100 days ago
  await createInvoice(h.app, h.ctx('admin'), { paymentMode: 'cash', lines: [{ productId: D, qtyMilli: 1_000, discountBp: 0 }] }, { at: daysAgo(100) });
});
afterAll(() => h.close());

const row = async (id: number) => (await stock.get('/api/insights/stock')).body.rows.find((r: { productId: number }) => r.productId === id);

describe('stock insights', () => {
  it('days left and a reorder suggestion with the numbers behind it', async () => {
    const r = await row(F);
    expect(r).toMatchObject({ soldMilli: 120_000, dailyMilli: 4_000, stockMilli: 81_000, daysLeft: 20, leadDays: 3, targetDays: 15, supplierId });
    // wants 4 × (15 + 3) = 72; has 81 → nothing to order yet
    expect(r.suggestMilli).toBe(0);
    expect(r.why).toContain('sold 120');
    expect(r.why).toContain('supplier takes 3 days');
  });

  it('low stock: order now, and what is on order counts', async () => {
    await h.app`insert into stock_movements (product_id, qty_milli, kind, reason) values (${F}, -71000, 'adjustment', 'test')`;
    let r = await row(F);
    expect(r).toMatchObject({ stockMilli: 10_000, daysLeft: 2, orderNow: true, suggestMilli: 62_000 }); // 72 − 10
    const po = await stock.post('/api/purchase-orders', { items: [{ productId: F, qtyMilli: 40_000, supplierId }] });
    expect(po.status, JSON.stringify(po.body)).toBe(200);
    r = await row(F);
    expect(r).toMatchObject({ onOrderMilli: 40_000, suggestMilli: 22_000 });
    const ins = (await stock.get('/api/insights/stock')).body;
    expect(ins.daily.runOut3.some((x: { productId: number }) => x.productId === F)).toBe(true);
  });

  it('dead stock is never suggested; the owner can decide what to do with it', async () => {
    const r = await row(D);
    expect(r).toMatchObject({ movement: 'dead', suggestMilli: 0, usualMaxMilli: 0, daysSinceSale: 100 });
    expect((await admin.post('/api/insights/decisions', { productId: D, action: 'tell_partners', note: 'offer to painters' })).status).toBe(200);
    expect((await row(D)).decision).toMatchObject({ action: 'tell_partners' });
    expect((await counter.get('/api/insights/stock')).status).toBe(403);
    const x = await h.server.inject({ method: 'GET', url: '/api/insights/stock?format=xlsx', headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${admin.token}` } });
    expect(x.statusCode).toBe(200);
  });
});

describe('purchase orders', () => {
  it('one order per supplier; edit while draft; send; WhatsApp text', async () => {
    const made = await stock.post('/api/purchase-orders', { items: [{ productId: F, qtyMilli: 10_000, supplierId }, { productId: D, qtyMilli: 2_000, supplierId: otherSupplier }] });
    expect(made.body).toHaveLength(2);
    const id = made.body[0].id;
    expect((await stock.patch(`/api/purchase-orders/${id}`, { lines: [{ productId: F, qtyMilli: 12_000 }] })).status).toBe(200);
    expect((await stock.get(`/api/purchase-orders/${id}`)).body.lines[0].qty_milli).toBe(12_000);
    expect((await stock.patch(`/api/purchase-orders/${id}`, { status: 'sent' })).status).toBe(200);
    expect((await stock.patch(`/api/purchase-orders/${id}`, { lines: [{ productId: F, qtyMilli: 1_000 }] })).status).toBe(409);
    const msg = (await stock.get(`/api/purchase-orders/${id}/message`)).body.text;
    expect(msg).toContain(': 12 bag');
    expect((await counter.post('/api/purchase-orders', { items: [{ productId: F, qtyMilli: 1_000, supplierId }] })).status).toBe(403);
  });
});

describe('stock audit', () => {
  it('count, reason for every difference, close posts the adjustments', async () => {
    const A = await h.product({ qty: 50 });
    const a = await stock.post('/api/stock-audits', { title: 'Godown count' });
    expect(a.body.number).toMatch(/^SA\//);
    expect((await counter.post(`/api/stock-audits/${a.body.id}/count`, { productId: A, countedMilli: 47_000 })).status).toBe(403);
    const c = await stock.post(`/api/stock-audits/${a.body.id}/count`, { productId: A, countedMilli: 47_000 });
    expect(c.body).toMatchObject({ systemMilli: 50_000, diffMilli: -3_000 });
    // a sale after counting doesn't change the difference
    await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: A, qtyMilli: 5_000, discountBp: 0 }] });
    expect((await stock.post(`/api/stock-audits/${a.body.id}/close`)).body.code).toBe('REASON_REQUIRED');
    await stock.post(`/api/stock-audits/${a.body.id}/count`, { productId: A, countedMilli: 42_000, reason: 'damaged', note: '3 bags wet' });
    const view = (await stock.get(`/api/stock-audits/${a.body.id}`)).body;
    expect(view.summary).toMatchObject({ counted: 1, differences: 1 });
    expect((await stock.post(`/api/stock-audits/${a.body.id}/close`)).body.adjusted).toBe(1);
    expect(await h.stockOf(A)).toBe(42_000);
    const [m] = await h.app<{ kind: string; reason: string }[]>`select kind, reason from stock_movements where product_id = ${A} order by id desc limit 1`;
    expect(m).toMatchObject({ kind: 'audit' });
    expect(m!.reason).toContain('damaged');
    expect((await stock.post(`/api/stock-audits/${a.body.id}/close`)).status).toBe(409);
  });
});

describe('day-end closing per counter', () => {
  it('expected cash = float + cash bills + cash collections − cash refunds − cash paid out', async () => {
    const P = await h.product({ price: 100_000, qty: 50 });
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const before = (await counter.get(`/api/counter-close/summary?floatPaise=200000`)).body.expectedCashPaise;
    await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: P, qtyMilli: 1_000, discountBp: 0 }] }); // ₹1,180 cash
    await counter.post('/api/invoices', { paymentMode: 'upi', lines: [{ productId: P, qtyMilli: 1_000, discountBp: 0 }] });
    const s = (await counter.get(`/api/counter-close/summary?floatPaise=200000`)).body;
    expect(s.expectedCashPaise - before).toBe(118_000);
    expect(s.staff.some((x: { user_name: string }) => x.user_name === `Counter ${h.tag}`)).toBe(true);
    const c = await counter.post('/api/counter-close', { floatPaise: 200_000, countedCashPaise: s.expectedCashPaise - 5_000, note: 'short ₹50' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.differencePaise).toBe(-5_000);
    const list = (await admin.get(`/api/counter-closings?from=${today}&to=${today}`)).body;
    expect(list.some((x: { id: number }) => x.id === c.body.id)).toBe(true);
  });
});

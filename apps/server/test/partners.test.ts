import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@kph/core';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let typeId: number;
let catPaint: number;
let A: number; // paint, 20 L bucket, ₹1,000 + 18%, category "paint"
let B: number; // other category, ₹1,000 + 18%
let partnerId: number;
const today = istDate();

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  const [c] = await h.app<{ id: number }[]>`insert into categories (name) values (${'Paint ' + h.tag}) returning id`;
  catPaint = c!.id;
  A = await h.product({ price: 100_000, qty: 100 });
  B = await h.product({ price: 100_000, qty: 100 });
  await h.app`update products set category_id = ${catPaint}, contents_milli = 20000, contents_unit = 'ltr' where id = ${A}`;
  const t = await admin.post('/api/partner-types', { name: `Painter ${h.tag}` });
  typeId = t.body.id;
});
afterAll(() => h.close());

describe('trade partners', () => {
  it('admin sets rewards: ₹10 per bucket of paint, 2% on everything else', async () => {
    const rules = [{ categoryId: catPaint, mode: 'per_unit', value: 1000 }, { categoryId: null, mode: 'percent', value: 200 }];
    expect((await counter.put(`/api/partner-types/${typeId}/rules`, { rules })).status).toBe(403);
    expect((await admin.put(`/api/partner-types/${typeId}/rules`, { rules: [...rules, { categoryId: null, mode: 'percent', value: 100 }] })).status).toBe(400);
    expect((await admin.put(`/api/partner-types/${typeId}/rules`, { rules })).status).toBe(200);
    const types = (await counter.get('/api/partner-types')).body;
    expect(types.find((x: { id: number }) => x.id === typeId).rules).toHaveLength(2);
  });

  it('counter staff add partners; phone must be unique', async () => {
    const p = await counter.post('/api/partners', { name: `Raju Painter ${h.tag}`, phone: '9440011111', area: 'Kavali', typeId });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    partnerId = p.body.id;
    expect((await counter.post('/api/partners', { name: 'Someone', phone: '9440011111', typeId })).status).toBe(409);
  });

  it('a tagged bill earns the reward; returns and cancellation take it back exactly', async () => {
    const site = await counter.post(`/api/partners/${partnerId}/sites`, { name: 'Reddy house, Musunuru', ownerName: 'S. Reddy' });
    const bill = await counter.post('/api/invoices', { paymentMode: 'cash', partnerId, siteId: site.body.id, lines: [{ productId: A, qtyMilli: 10_000, discountBp: 0 }, { productId: B, qtyMilli: 2_000, discountBp: 0 }] });
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    let prof = (await counter.get(`/api/partners/${partnerId}`)).body;
    expect(prof.rewardBalancePaise).toBe(10_000 + 4_000); // 10 × ₹10 + 2% of ₹2,000
    const inv = (await admin.get(`/api/invoices/${bill.body.id}`)).body;
    expect(inv.partner).toMatchObject({ partner_id: partnerId, site_name: 'Reddy house, Musunuru' });

    const lineA = inv.lines.find((l: { product_id: number }) => l.product_id === A).id;
    expect((await admin.post(`/api/invoices/${bill.body.id}/returns`, { reason: 'extra', refundMode: 'cash', lines: [{ invoiceLineId: lineA, qtyMilli: 4_000, restock: true }] })).status).toBe(200);
    prof = (await counter.get(`/api/partners/${partnerId}`)).body;
    expect(prof.rewardBalancePaise).toBe(10_000); // 4 buckets × ₹10 taken back
    // brought in, net of the return: 6 buckets = 120 litres of paint
    const paint = prof.byCategory.find((x: { category: string }) => x.category === `Paint ${h.tag}`);
    expect(paint).toMatchObject({ qty: 6_000, litres_milli: 120_000 });

    const second = await counter.post('/api/invoices', { paymentMode: 'cash', partnerId, lines: [{ productId: B, qtyMilli: 5_000, discountBp: 0 }] });
    expect((await counter.get(`/api/partners/${partnerId}`)).body.rewardBalancePaise).toBe(20_000);
    expect((await admin.post(`/api/invoices/${second.body.id}/cancel`, { reason: 'wrong customer' })).status).toBe(200);
    prof = (await counter.get(`/api/partners/${partnerId}`)).body;
    expect(prof.rewardBalancePaise).toBe(10_000);
    expect(prof.rewards.map((r: { kind: string }) => r.kind)).toEqual(['reversed', 'earned', 'reversed', 'earned']);
    expect(prof.sites[0]).toMatchObject({ name: 'Reddy house, Musunuru', bills: 1 });
  });

  it('a bill can be tagged afterwards, once', async () => {
    const b = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: B, qtyMilli: 1_000, discountBp: 0 }] });
    expect((await counter.post(`/api/invoices/${b.body.id}/partner`, { partnerId })).status).toBe(200);
    expect((await counter.post(`/api/invoices/${b.body.id}/partner`, { partnerId })).status).toBe(409);
    expect((await counter.get(`/api/partners/${partnerId}`)).body.rewardBalancePaise).toBe(12_000);
  });

  it('payout posts an expense to Partner Commission; gifts are recorded', async () => {
    const [cash] = await h.app<{ id: number }[]>`select id from ledgers where system_code = 'cash'`;
    const [comm] = await h.app<{ id: number }[]>`select id from ledgers where system_code = 'partner_commission'`;
    const bal = async (id: number) => (await h.app<{ b: number }[]>`select coalesce(sum(dr_paise - cr_paise), 0)::bigint as b from voucher_lines where ledger_id = ${id}`)[0]!.b;
    const before = await bal(comm!.id);
    expect((await counter.post(`/api/partners/${partnerId}/rewards`, { amountPaise: 5_000, how: 'payout', fromLedgerId: cash!.id })).status).toBe(403);
    expect((await admin.post(`/api/partners/${partnerId}/rewards`, { amountPaise: 50_000, how: 'payout', fromLedgerId: cash!.id })).status).toBe(400);
    const p = await admin.post(`/api/partners/${partnerId}/rewards`, { amountPaise: 5_000, how: 'payout', fromLedgerId: cash!.id, note: 'Diwali' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.moneyEntryId).toBeTruthy();
    expect((await bal(comm!.id)) - before).toBe(5_000);
    expect((await admin.post(`/api/partners/${partnerId}/rewards`, { amountPaise: 2_000, how: 'redeemed', note: 'brush set' })).status).toBe(200);
    expect((await counter.get(`/api/partners/${partnerId}`)).body.rewardBalancePaise).toBe(5_000);
  });

  it('notes timeline, shades, and reports', async () => {
    const other = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: B, qtyMilli: 1_000, discountBp: 0 }] });
    expect((await counter.post(`/api/partners/${partnerId}/notes`, { note: 'x', invoiceId: other.body.id })).status).toBe(400);
    expect((await counter.post(`/api/partners/${partnerId}/notes`, { note: 'Bought 20L Birla Opus exterior for Reddy house, shade 7034' })).status).toBe(200);
    expect((await counter.post('/api/shades', { partnerId, base: 'White base', shadeCode: '' })).status).toBe(400);
    expect((await counter.post('/api/shades', { partnerId, productId: A, base: 'Exterior white base', tint: 'Y2 0.5, R1 0.2', shadeCode: '7034', shadeName: 'Sand dune', quantity: '20 L' })).status).toBe(200);
    const prof = (await counter.get(`/api/partners/${partnerId}`)).body;
    expect(prof.notes[0].note).toContain('shade 7034');
    expect(prof.shades[0]).toMatchObject({ shade_code: '7034', shade_name: 'Sand dune' });
    expect((await counter.get('/api/shades?search=sand')).body.some((s: { shade_code: string }) => s.shade_code === '7034')).toBe(true);

    const quiet = await counter.post('/api/partners', { name: `Quiet Mason ${h.tag}`, typeId });
    const rep = (await counter.get(`/api/reports/partners?from=${today}&to=${today}`)).body;
    expect(rep.top.find((p: { id: number }) => p.id === partnerId).bills).toBe(2); // the cancelled bill doesn't count
    expect(rep.inactive.find((p: { id: number }) => p.id === quiet.body.id).bucket).toBe('never');
    const x = await h.server.inject({ method: 'GET', url: `/api/reports/partners?from=${today}&to=${today}&format=xlsx`, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${admin.token}` } });
    expect(x.statusCode).toBe(200);
  });
});

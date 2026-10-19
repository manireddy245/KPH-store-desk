import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@kph/core';
import { createInvoice } from '../src/services/billing.js';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let stock: Awaited<ReturnType<typeof h.loginAs>>;
let P: number; // ₹1,000 + 18% = ₹1,180 a bag
const today = istDate();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const line = (qty: number) => ({ productId: P, qtyMilli: qty * 1000, discountBp: 0 });

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  stock = await h.loginAs('stock');
  P = await h.product({ price: 100_000, qty: 1000 });
  await admin.put('/api/settings', { creditDaysDefault: 30 });
});
afterAll(async () => {
  await admin.put('/api/settings', { creditDaysDefault: 0 });
  await h.close();
});

describe('credit limit', () => {
  it('going over the limit needs the admin PIN, for that customer and amount only', async () => {
    const c = await admin.post('/api/customers', { name: `Limit ${h.tag}`, phone: '9876543210', creditLimitPaise: 500_000 });
    const cid = c.body.id;
    expect((await counter.post('/api/invoices', { customerId: cid, paymentMode: 'credit', lines: [line(3)] })).status).toBe(200); // owes 3,540

    const blocked = await counter.post('/api/invoices', { customerId: cid, paymentMode: 'credit', lines: [line(2)] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.details).toMatchObject({ permission: 'billing.over_credit_limit', customerId: cid, balancePaise: 354_000, limitPaise: 500_000, afterPaise: 590_000 });
    // a cash bill is never blocked
    expect((await counter.post('/api/invoices', { customerId: cid, paymentMode: 'cash', lines: [line(2)] })).status).toBe(200);

    const small = await counter.post('/api/auth/override', { permission: 'billing.over_credit_limit', approverId: h.users.admin.id, pin: '1111', context: { customerId: cid, upToPaise: 500_000 } });
    expect(small.status, JSON.stringify(small.body)).toBe(200);
    expect((await counter.post('/api/invoices', { customerId: cid, paymentMode: 'credit', lines: [line(2)], creditOverrideToken: small.body.token })).status).toBe(403);

    const ok = await counter.post('/api/auth/override', { permission: 'billing.over_credit_limit', approverId: h.users.admin.id, pin: '1111', context: { customerId: cid, upToPaise: 590_000 } });
    const saved = await counter.post('/api/invoices', { customerId: cid, paymentMode: 'credit', lines: [line(2)], creditOverrideToken: ok.body.token });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const [log] = await h.app<{ approved_by: number }[]>`select approved_by from audit_log where action = 'credit.over_limit' and entity_id = ${String(saved.body.id)}`;
    expect(log!.approved_by).toBe(h.users.admin.id);

    // admin can go over directly, but it is still logged
    const a = await admin.post('/api/invoices', { customerId: cid, paymentMode: 'credit', lines: [line(1)] });
    expect(a.status).toBe(200);
    const [alog] = await h.app`select 1 from audit_log where action = 'credit.over_limit' and entity_id = ${String(a.body.id)}`;
    expect(alog).toBeTruthy();
  });
});

describe('receipts against bills, ageing, overdue', () => {
  let cid: number;
  let old: { id: number; number: string };
  let mid: { id: number; number: string };
  let fresh: { id: number; number: string };

  beforeAll(async () => {
    const c = await admin.post('/api/customers', { name: `Khata ${h.tag}`, phone: '9123456780' });
    cid = c.body.id;
    const bill = (days: number, qty: number) => createInvoice(h.app, h.ctx('admin'), { customerId: cid, paymentMode: 'credit', lines: [line(qty)] }, { at: daysAgo(days) });
    old = await bill(100, 1); // ₹1,180
    mid = await bill(40, 2); // ₹2,360
    fresh = await bill(0, 1); // ₹1,180
  });

  it('marks a payment against a bill; the rest on account settles the oldest', async () => {
    const open = (await counter.get(`/api/customers/${cid}/open-bills`)).body;
    expect(open.map((b: { number: string }) => b.number)).toEqual([old.number, mid.number, fresh.number]);

    expect((await counter.post('/api/receipts', { customerId: cid, mode: 'cash', amountPaise: 100_000, allocations: [{ invoiceId: mid.id, amountPaise: 200_000 }] })).status).toBe(400);
    expect((await counter.post('/api/receipts', { customerId: cid, mode: 'cash', amountPaise: 300_000, allocations: [{ invoiceId: mid.id, amountPaise: 300_000 }] })).status).toBe(400); // more than due
    const r = await counter.post('/api/receipts', { customerId: cid, mode: 'upi', amountPaise: 150_000, allocations: [{ invoiceId: mid.id, amountPaise: 100_000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const openNow = (await counter.get(`/api/customers/${cid}/open-bills`)).body;
    expect(openNow.find((b: { id: number }) => b.id === old.id)).toMatchObject({ due_paise: 118_000, open_paise: 68_000 });
    const d = (await counter.get(`/api/customers/${cid}/dues`)).body;
    // owes 4,720 − 1,500 = 3,220: old 1,180 − 500 on account = 680 (90+), mid 2,360 − 1,000 = 1,360 (31–60), fresh 1,180 (0–30)
    expect(d.balancePaise).toBe(322_000);
    expect(d.buckets).toEqual([118_000, 136_000, 0, 68_000]);
    expect(d.overduePaise).toBe(68_000 + 136_000); // 30 days of credit
    expect(d.oldest).toMatchObject({ number: old.number, days: 100 });
    expect(d.nextDueDate).toBe(new Date(Date.parse(today) + 30 * 86_400_000).toISOString().slice(0, 10));

    // a return credited to the account settles its own bill
    const lineId = (await admin.get(`/api/invoices/${fresh.id}`)).body.lines[0].id;
    expect((await admin.post(`/api/invoices/${fresh.id}/returns`, { reason: 'wrong colour', refundMode: 'account', lines: [{ invoiceLineId: lineId, qtyMilli: 1000, restock: true }] })).status).toBe(200);
    const after = (await counter.get(`/api/customers/${cid}/dues`)).body;
    expect(after.balancePaise).toBe(204_000);
    expect(after.bills.find((b: { number: string }) => b.number === fresh.number)).toBeUndefined();

    // cancelling the receipt brings the bill back to full
    expect((await admin.post(`/api/receipts/${r.body.id}/cancel`, { reason: 'cheque bounced' })).status).toBe(200);
    const open2 = (await counter.get(`/api/customers/${cid}/open-bills`)).body;
    expect(open2.find((b: { id: number }) => b.id === mid.id).due_paise).toBe(236_000);
  });

  it('ageing and the due list', async () => {
    const a = (await counter.get('/api/khata/ageing')).body;
    const me = a.customers.find((c: { customerId: number }) => c.customerId === cid);
    expect(me.balancePaise).toBe(354_000);
    const due = (await counter.get('/api/khata/due')).body;
    expect(due.overduePaise).toBeGreaterThanOrEqual(me.overduePaise);
    expect((await stock.get('/api/khata/ageing')).status).toBe(403);
    const x = await h.server.inject({ method: 'GET', url: '/api/khata/ageing?format=xlsx', headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${admin.token}` } });
    expect(x.statusCode).toBe(200);
  });

  it('statement runs from the opening to the closing balance', async () => {
    const from = daysAgo(120).toISOString().slice(0, 10);
    const s = (await counter.get(`/api/customers/${cid}/statement?from=${from}&to=${today}`)).body;
    expect(s.openingPaise).toBe(0);
    expect(s.closingPaise).toBe(354_000);
    expect(s.entries.at(-1).balancePaise).toBe(354_000);
    expect(s.entries.map((e: { type: string }) => e.type)).toEqual(['Bill', 'Bill', 'Bill', 'Payment received', 'Goods returned', 'Cancelled']);
    expect(s.entries[0].doc).toBe(old.number);
    // a later "from" carries the earlier bills in the opening balance
    const later = (await counter.get(`/api/customers/${cid}/statement?from=${daysAgo(50).toISOString().slice(0, 10)}&to=${today}`)).body;
    expect(later.openingPaise).toBe(118_000);
  });

  it('WhatsApp reminder: link with the message, logged; refuses when nothing is due or no mobile', async () => {
    const r = await counter.post(`/api/customers/${cid}/reminders`, { language: 'en' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/wa\.me\/919123456780\?text=/);
    expect(decodeURIComponent(r.body.url.split('text=')[1])).toContain('Your balance with us is ₹3,540.00');
    expect(r.body.message).toContain(`Oldest bill: ${old.number}`);
    const te = await counter.post(`/api/customers/${cid}/reminders`, {});
    expect(te.body.language).toBe('te');
    expect((await counter.get(`/api/customers/${cid}/reminders`)).body.length).toBe(2);
    expect((await stock.post(`/api/customers/${cid}/reminders`, {})).status).toBe(403);

    const none = await admin.post('/api/customers', { name: `NoPhone ${h.tag}` });
    await createInvoice(h.app, h.ctx('admin'), { customerId: none.body.id, paymentMode: 'credit', lines: [line(1)] });
    expect((await counter.post(`/api/customers/${none.body.id}/reminders`, {})).body.code).toBe('NO_MOBILE');
    // logging a phone call works without a mobile
    expect((await counter.post(`/api/customers/${none.body.id}/reminders`, { channel: 'call', note: 'will pay Friday' })).status).toBe(200);
    const paid = await admin.post('/api/customers', { name: `Clear ${h.tag}`, phone: '9000000001' });
    expect((await counter.post(`/api/customers/${paid.body.id}/reminders`, {})).body.code).toBe('NOTHING_DUE');
  });

  it('Tally: a receipt against a bill goes as Agst Ref', async () => {
    const r = await counter.post('/api/receipts', { customerId: cid, mode: 'cash', amountPaise: 50_000, allocations: [{ invoiceId: old.id, amountPaise: 50_000 }] });
    expect(r.status).toBe(200);
    const res = await h.server.inject({ method: 'GET', url: `/api/tally/vouchers.xml?from=${today}&to=${today}`, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${admin.token}` } });
    expect(res.body).toContain(`<BILLALLOCATIONS.LIST><NAME>${old.number}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>500.00</AMOUNT></BILLALLOCATIONS.LIST>`);
  });
});

describe('shop without fixed credit days; old dues kept as a record', () => {
  it('no credit days: nothing is overdue, bills have no due date', async () => {
    await admin.put('/api/settings', { creditDaysDefault: 0 });
    const c = await admin.post('/api/customers', { name: `NoTerms ${h.tag}`, phone: '9555500000' });
    await createInvoice(h.app, h.ctx('admin'), { customerId: c.body.id, paymentMode: 'credit', lines: [line(1)] }, { at: daysAgo(200) });
    const d = (await counter.get(`/api/customers/${c.body.id}/dues`)).body;
    expect(d).toMatchObject({ creditDays: null, overduePaise: 0, balancePaise: 118_000, buckets: [0, 0, 0, 118_000] });
    expect(d.bills[0].dueDate).toBeNull();
    const due = (await counter.get('/api/khata/due')).body;
    expect(due.owing.some((x: { customerId: number }) => x.customerId === c.body.id)).toBe(true);
    // a customer with their own credit days still gets due dates
    expect((await admin.patch(`/api/customers/${c.body.id}`, { creditDays: 15 })).status).toBe(200);
    expect((await counter.get(`/api/customers/${c.body.id}/dues`)).body.overduePaise).toBe(118_000);
    await admin.put('/api/settings', { creditDaysDefault: 30 });
  });

  it('old dues on hold: kept in the balance, left out of reminders and the due list', async () => {
    const c = await admin.post('/api/customers', { name: `OldDues ${h.tag}`, phone: '9555511111' });
    await createInvoice(h.app, h.ctx('admin'), { customerId: c.body.id, paymentMode: 'credit', lines: [line(2)] }, { at: daysAgo(400) });
    expect((await counter.patch(`/api/customers/${c.body.id}`, { duesOnHold: true, holdNote: 'not paying since 2025' })).status).toBe(200);
    const d = (await counter.get(`/api/customers/${c.body.id}/dues`)).body;
    expect(d).toMatchObject({ onHold: true, holdNote: 'not paying since 2025', balancePaise: 236_000, overduePaise: 0 });
    const due = (await counter.get('/api/khata/due')).body;
    expect(due.customers.some((x: { customerId: number }) => x.customerId === c.body.id)).toBe(false);
    expect(due.owing.some((x: { customerId: number }) => x.customerId === c.body.id)).toBe(false);
    expect((await counter.post(`/api/customers/${c.body.id}/reminders`, {})).body.code).toBe('ON_HOLD');
    const a = (await counter.get('/api/khata/ageing')).body;
    expect(a.totals.onHoldPaise).toBeGreaterThanOrEqual(236_000);
  });
});

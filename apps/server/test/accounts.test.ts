import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@kph/core';
import { weightedCost } from '../src/services/purchases.js';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let L: Record<string, number>;
let bankId: number;
let supplierId: number;
let productId: number;
const today = istDate();
const daysAgo = (n: number) => new Date(Date.now() + 5.5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
const tiny = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');

const bal = async (ledgerId: number | undefined) => {
  const [r] = await h.app<{ b: number }[]>`select l.opening_dr_paise + coalesce((select sum(dr_paise - cr_paise) from voucher_lines where ledger_id = l.id), 0) as b from ledgers l where l.id = ${ledgerId!}`;
  return r!.b;
};
const tbDiff = async () => (await admin.get(`/api/books/trial-balance?asOf=${today}`)).body.differencePaise as number;

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  const rows = await h.app<{ id: number; system_code: string }[]>`select id, system_code from ledgers where system_code is not null`;
  L = Object.fromEntries(rows.map((r) => [r.system_code, r.id]));
  const b = await admin.post('/api/ledgers', { name: `SBI Current ${h.tag}`, kind: 'bank', details: { accountNo: 'XXXX4521', ifsc: 'SBIN0000809' } });
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  bankId = b.body.id;
  const s = await admin.post('/api/suppliers', { name: `Ramco dealer ${h.tag}` });
  supplierId = s.body.id;
  productId = await h.product({ qty: 100, cost: 80000 });
});
afterAll(() => h.close());

describe('accounts', () => {
  it('bank accounts: admin only, no duplicates', async () => {
    expect((await admin.post('/api/ledgers', { name: `SBI Current ${h.tag}`, kind: 'bank' })).status).toBe(409);
    expect((await counter.post('/api/ledgers', { name: `X ${h.tag}`, kind: 'bank' })).status).toBe(403);
    const list = (await admin.get('/api/ledgers?kind=bank')).body;
    expect(list.find((l: { id: number }) => l.id === bankId)).toMatchObject({ group_name: 'Bank Accounts', details: { ifsc: 'SBIN0000809' } });
  });

  it('weighted-average cost', async () => {
    expect(weightedCost(10_000, 30_000, 10_000, 32_000)).toBe(31_000);
    expect(weightedCost(0, 30_000, 5_000, 32_000)).toBe(32_000);
    expect(weightedCost(3_000, null, 1_000, 500)).toBe(500);
    expect(weightedCost(1_000, 100, 2_000, 101)).toBe(101); // 100.67 → 101
    // 100 bags at ₹800 + 100 bags bought at ₹900 → ₹850
    const p = await admin.post('/api/purchases', { supplierId, supplierInvoiceNo: `W-${h.tag}`, supplierInvoiceDate: today, lines: [{ productId, qtyMilli: 100_000, taxablePaise: 9_000_000, gstRateBp: 1800 }] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const [c] = await h.app<{ c: number }[]>`select cost_price_cp as c from products where id = ${productId}`;
    expect(c!.c).toBe(8_500_000);
  });

  it('pays a supplier against bills, on account for the rest; ageing settles oldest first', async () => {
    const before = await tbDiff();
    const old = await admin.post('/api/purchases', { supplierId, supplierInvoiceNo: `OLD-${h.tag}`, supplierInvoiceDate: daysAgo(100), lines: [{ productId, qtyMilli: 10_000, taxablePaise: 1_000_000, gstRateBp: 1800 }] });
    const recent = await admin.post('/api/purchases', { supplierId, supplierInvoiceNo: `NEW-${h.tag}`, supplierInvoiceDate: daysAgo(10), lines: [{ productId, qtyMilli: 5_000, taxablePaise: 500_000, gstRateBp: 1800 }] });
    expect(old.status).toBe(200);
    expect(recent.status).toBe(200);
    // The W- purchase above (₹1,06,200) is also unpaid: pay it in full so this test is only about the two bills.
    const w = (await admin.get(`/api/suppliers/${supplierId}/outstanding`)).body.find((b: { supplier_invoice_no: string }) => b.supplier_invoice_no === `W-${h.tag}`);
    expect((await admin.post('/api/money/payments', { supplierId, fromLedgerId: bankId, amountPaise: w.due_paise, allocations: [{ purchaseId: w.id, amountPaise: w.due_paise }] })).status).toBe(200);

    expect((await counter.post('/api/money/payments', { supplierId, fromLedgerId: L.cash, amountPaise: 100 })).status).toBe(403);
    expect((await admin.post('/api/money/payments', { supplierId, fromLedgerId: L.cash, amountPaise: 100, allocations: [{ purchaseId: recent.body.id, amountPaise: 200 }] })).status).toBe(400);
    expect((await admin.post('/api/money/payments', { supplierId, fromLedgerId: L.sales, amountPaise: 100 })).status).toBe(400);

    const cashBefore = await bal(L.cash);
    const pay = await admin.post('/api/money/payments', { supplierId, fromLedgerId: L.cash, amountPaise: 700_000, reference: 'cash', allocations: [{ purchaseId: recent.body.id, amountPaise: 500_000 }] });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    expect(pay.body.number).toMatch(/^PAY\/\d{2}-\d{2}\/\d{6}$/);
    expect(await bal(L.cash)).toBe(cashBefore - 700_000);

    const due = (await admin.get(`/api/suppliers/${supplierId}/outstanding`)).body;
    expect(due.find((b: { id: number }) => b.id === recent.body.id).due_paise).toBe(90_000);
    expect(due.find((b: { id: number }) => b.id === old.body.id).due_paise).toBe(1_180_000);

    const age = (await admin.get('/api/reports/supplier-ageing')).body.suppliers.find((s: { supplierId: number }) => s.supplierId === supplierId);
    // owe 11,800 + 5,900 − 7,000 = 10,700: new bill 900 (0–30), old bill 11,800 − 2,000 on account = 9,800 (90+)
    expect(age).toMatchObject({ owePaise: 1_070_000, buckets: [90_000, 0, 0, 980_000] });

    // cancelling puts everything back
    expect((await admin.post(`/api/money/${pay.body.id}/cancel`, { reason: 'wrong amount' })).status).toBe(200);
    expect((await admin.post(`/api/money/${pay.body.id}/cancel`, { reason: 'again' })).status).toBe(409);
    expect(await bal(L.cash)).toBe(cashBefore);
    expect((await admin.get(`/api/suppliers/${supplierId}/outstanding`)).body.find((b: { id: number }) => b.id === recent.body.id).due_paise).toBe(590_000);
    expect(await tbDiff()).toBe(before);
  });

  it('expenses: GST bill gives input credit; counter staff can’t (petty cash off)', async () => {
    const [rent] = await h.app<{ id: number }[]>`select id from ledgers where name = 'Rent' and kind = 'expense'`;
    const [loading] = await h.app<{ id: number }[]>`select id from ledgers where name = 'Loading & Unloading'`;
    expect((await counter.post('/api/money/expenses', { ledgerId: loading!.id, fromLedgerId: L.cash, amountPaise: 50_000 })).status).toBe(403);
    expect((await admin.post('/api/money/expenses', { ledgerId: L.cash, fromLedgerId: L.cash, amountPaise: 50_000 })).status).toBe(400);
    expect((await admin.post('/api/money/expenses', { ledgerId: rent!.id, fromLedgerId: bankId, amountPaise: 118_000, gstRateBp: 1800, vendorBillNo: 'R-1' })).status).toBe(400); // no GSTIN

    const before3b = (await admin.get(`/api/reports/gstr3b?from=${today}&to=${today}`)).body.itc.expenses;
    const inputBefore = await bal(L.input_cgst);
    const r = await admin.post('/api/money/expenses', { ledgerId: rent!.id, fromLedgerId: bankId, amountPaise: 1_180_000, gstRateBp: 1800, vendorName: 'Landlord', vendorGstin: '37AABCL1234F1ZX', vendorBillNo: 'R-10', narration: 'October rent', photo: { mimeType: 'image/jpeg', base64: tiny } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const e = (await admin.get(`/api/money/${r.body.id}`)).body;
    expect(e).toMatchObject({ kind: 'expense', taxable_paise: 1_000_000, cgst_paise: 90_000, sgst_paise: 90_000, amount_paise: 1_180_000 });
    expect(await bal(L.input_cgst)).toBe(inputBefore + 90_000);
    const after3b = (await admin.get(`/api/reports/gstr3b?from=${today}&to=${today}`)).body.itc.expenses;
    expect(after3b.cgst - before3b.cgst).toBe(90_000);
    const photo = await h.server.inject({ method: 'GET', url: `/api/money/${r.body.id}/file`, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${admin.token}` } });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');

    const plain = await admin.post('/api/money/expenses', { ledgerId: loading!.id, fromLedgerId: L.cash, amountPaise: 45_000, narration: 'unloading 2 lorries' });
    expect((await admin.get(`/api/money/${plain.body.id}`)).body).toMatchObject({ taxable_paise: 45_000, cgst_paise: 0 });
    expect((await admin.post('/api/money/expenses', { ledgerId: loading!.id, fromLedgerId: L.cash, amountPaise: 100, date: '2999-01-01' })).status).toBe(400);
  });

  it('contra: UPI settled into the bank with charges', async () => {
    const [u, b, c] = [await bal(L.upi), await bal(bankId), await bal(L.bank_charges)];
    const r = await admin.post('/api/money/contra', { fromLedgerId: L.upi, toLedgerId: bankId, amountPaise: 1_000_000, chargesPaise: 5_000, reference: 'settlement 18 Oct' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([await bal(L.upi), await bal(bankId), await bal(L.bank_charges)]).toEqual([u - 1_000_000, b + 995_000, c + 5_000]);
    expect((await admin.post('/api/money/contra', { fromLedgerId: L.cash, toLedgerId: L.cash, amountPaise: 100 })).status).toBe(400);
    expect((await admin.post('/api/money/contra', { fromLedgerId: L.cash, toLedgerId: L.sales, amountPaise: 100 })).status).toBe(400);
  });

  it('journal: admin only, must balance, needs a reason', async () => {
    const lines = [{ ledgerId: L.bank_charges, drPaise: 10_000 }, { ledgerId: bankId, crPaise: 10_000 }];
    expect((await counter.post('/api/money/journals', { narration: 'SMS charges', lines })).status).toBe(403);
    expect((await admin.post('/api/money/journals', { narration: 'x', lines })).status).toBe(400);
    expect((await admin.post('/api/money/journals', { narration: 'SMS charges for October', lines: [lines[0], { ledgerId: bankId, crPaise: 9_000 }] })).status).toBe(400);
    const r = await admin.post('/api/money/journals', { narration: 'SMS charges for October', lines });
    expect(r.status).toBe(200);
    expect(r.body.number).toMatch(/^JRN\//);
  });

  it('books: the bank statement runs and closes on the balance; trial balance still agrees', async () => {
    const st = (await admin.get(`/api/ledgers/${bankId}/statement?from=${today}&to=${today}`)).body;
    expect(st.entries.length).toBeGreaterThanOrEqual(3);
    expect(st.closingPaise).toBe(await bal(bankId));
    expect(st.entries.at(-1).balance_paise).toBe(st.closingPaise);
    const day = (await admin.get(`/api/books/day?from=${today}&to=${today}`)).body;
    for (const v of day.vouchers) expect(v.lines.reduce((t: number, l: { dr: number; cr: number }) => t + l.dr - l.cr, 0)).toBe(0);
    expect((await counter.get(`/api/books/day?from=${today}&to=${today}`)).status).toBe(403);
  });

  it('cash closing: count, record the difference, admin can book it', async () => {
    // put cash in the till first (cash withdrawn from the bank)
    expect((await admin.post('/api/money/contra', { fromLedgerId: bankId, toLedgerId: L.cash, amountPaise: 5_000_000 })).status).toBe(200);
    const pos = (await counter.get('/api/cash/position')).body;
    const book = pos.bookPaise;
    const counted = book - 10_000;
    const r = await counter.post('/api/cash/close', { countedPaise: counted, note: 'short ₹100' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.differencePaise).toBe(-10_000);
    expect((await counter.get('/api/cash/position')).body.bookPaise).toBe(book); // only recorded
    expect((await counter.post('/api/cash/close', { countedPaise: counted, bookDifference: true })).status).toBe(403);
    const a = await admin.post('/api/cash/close', { countedPaise: counted, bookDifference: true, note: 'could not trace' });
    expect(a.body.adjustmentEntryId).toBeTruthy();
    expect((await counter.get('/api/cash/position')).body.bookPaise).toBe(counted);
    expect((await counter.post('/api/cash/close', { denominations: { '500': 2, '3': 1 } })).status).toBe(400);
    const den = await counter.post('/api/cash/close', { denominations: { '500': 2, '10': 3 } });
    expect(den.body.countedPaise).toBe(103_000);
    expect((await counter.get('/api/cash/position')).body.closings.length).toBe(3);
  });

  it('opening balances: capital takes the difference, then locked; the trial balance agrees', async () => {
    expect((await admin.put('/api/opening', { openingDate: '2999-01-01' })).status).toBe(400); // entries exist before that date
    const set = await admin.put('/api/opening', { openingDate: '2000-01-01', ledgers: [{ ledgerId: L.cash, drPaise: 2_500_000 }, { ledgerId: bankId, drPaise: 10_000_000 }] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const o = set.body;
    const others = o.ledgers.filter((l: { system_code: string | null }) => l.system_code !== 'capital').reduce((t: number, l: { opening_dr_paise: number }) => t + l.opening_dr_paise, 0);
    expect(o.capitalPaise).toBe(others + o.customers.totalPaise - o.suppliers.totalPaise + o.stock.valuePaise);
    expect((await admin.put('/api/opening', { ledgers: [{ ledgerId: L.sales, drPaise: 5 }] })).status).toBe(400);
    expect((await counter.post('/api/opening/lock')).status).toBe(403);
    const locked = await admin.post('/api/opening/lock');
    expect(locked.status).toBe(200);
    expect(locked.body.locked).toBe(true);
    expect(await tbDiff()).toBe(0);
    expect((await admin.put('/api/opening', { ledgers: [{ ledgerId: L.cash, drPaise: 1 }] })).status).toBe(409);
    expect((await admin.post('/api/money/expenses', { ledgerId: L.bank_charges, fromLedgerId: L.cash, amountPaise: 100, date: '1999-12-31' })).status).toBe(400);
  });
});

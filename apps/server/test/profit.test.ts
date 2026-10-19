import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istDate } from '@kph/core';
import { _test } from '../src/services/tally.js';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let A: number;
let invoice: { id: number; number: string };
const today = istDate();
const range = `from=${today}&to=${today}`;
const inject = (url: string, token: string) => h.server.inject({ method: 'GET', url, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${token}` } });

type PL = { netSales: number; cogs: number; stockLossPaise: number; grossProfit: number; indirectTotal: number; netProfit: number };
let plBefore: PL;

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  A = await h.product({ price: 100000, cost: 80000, qty: 100 });
  const [c] = await h.app<{ id: number }[]>`insert into categories (name) values (${'Cat ' + h.tag}) returning id`;
  const [b] = await h.app<{ id: number }[]>`insert into brands (name) values (${'Brand ' + h.tag}) returning id`;
  await h.app`update products set category_id = ${c!.id}, brand_id = ${b!.id}, hsn = '2523' where id = ${A}`;
  plBefore = (await admin.get(`/api/reports/profit-loss?${range}`)).body;

  // sell 10 bags at ₹1,000 (cost ₹800), take 2 back, write off 1 damaged, pay ₹500 rent
  const r = await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: A, qtyMilli: 10_000, discountBp: 0 }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  invoice = r.body;
  const line = (await admin.get(`/api/invoices/${invoice.id}`)).body.lines[0].id;
  expect((await admin.post(`/api/invoices/${invoice.id}/returns`, { reason: 'extra bags', refundMode: 'cash', lines: [{ invoiceLineId: line, qtyMilli: 2_000, restock: true }] })).status).toBe(200);
  expect((await admin.post(`/api/products/${A}/adjust`, { deltaMilli: -1_000, reason: 'bag torn' })).status).toBe(200);
  const [rent] = await h.app<{ id: number }[]>`select id from ledgers where name = 'Rent'`;
  const [cash] = await h.app<{ id: number }[]>`select id from ledgers where system_code = 'cash'`;
  expect((await admin.post('/api/money/expenses', { ledgerId: rent!.id, fromLedgerId: cash!.id, amountPaise: 50_000 })).status).toBe(200);
});
afterAll(() => h.close());

describe('profit', () => {
  it('P&L moves by exactly the sale, return, write-off and expense', async () => {
    const after: PL = (await admin.get(`/api/reports/profit-loss?${range}`)).body;
    const d = (k: keyof PL) => after[k] - plBefore[k];
    expect(d('netSales')).toBe(800_000); // 10 − 2 bags × ₹1,000
    expect(d('cogs')).toBe(640_000); // 8 × ₹800
    expect(d('stockLossPaise')).toBe(80_000); // 1 bag at cost
    expect(d('grossProfit')).toBe(80_000);
    expect(d('indirectTotal')).toBe(50_000);
    expect(d('netProfit')).toBe(30_000);
  });

  it('profit by product, category and brand', async () => {
    const p = (await admin.get(`/api/reports/profit-by?${range}&by=product`)).body.rows.find((x: { key: string }) => x.key === String(A));
    expect(p).toMatchObject({ qty: 8_000, sales: 800_000, cost: 640_000, profit: 160_000, marginBp: 2000, bills: 1 });
    const c = (await admin.get(`/api/reports/profit-by?${range}&by=category`)).body.rows.find((x: { name: string }) => x.name === `Cat ${h.tag}`);
    expect(c).toMatchObject({ sales: 800_000, profit: 160_000 });
    const b = (await admin.get(`/api/reports/profit-by?${range}&by=brand`)).body.rows.find((x: { name: string }) => x.name === `Brand ${h.tag}`);
    expect(b).toMatchObject({ cost: 640_000 });
    expect((await counter.get(`/api/reports/profit-by?${range}`)).status).toBe(403);
    expect((await counter.get(`/api/reports/profit-loss?${range}`)).status).toBe(403);
    expect((await inject(`/api/reports/profit-by?${range}&by=product&format=xlsx`, admin.token)).statusCode).toBe(200);
  });

  it('stock value at cost, today and on an earlier date', async () => {
    const d = (await admin.get(`/api/reports/stock-value?asOf=${today}`)).body;
    expect(d.rows.find((x: { id: number }) => x.id === A)).toMatchObject({ qty: 91_000, cost: 80_000, value: 7_280_000 });
    const old = (await admin.get('/api/reports/stock-value?asOf=2020-01-01')).body;
    expect(old.rows.find((x: { id: number }) => x.id === A)).toBeUndefined();
  });

  it('balance summary adds up', async () => {
    const d = (await admin.get(`/api/reports/balance-summary?asOf=${today}`)).body;
    const sum = (xs: { amount: number }[]) => xs.reduce((t, x) => t + x.amount, 0);
    expect(sum(d.assets)).toBe(d.totalAssets);
    expect(sum(d.liabilities)).toBe(d.totalLiabilities);
    expect(d.ownersFunds).toBe(d.totalAssets - d.totalLiabilities);
    const stock = (await admin.get(`/api/reports/stock-value?asOf=${today}`)).body.totals.value;
    expect(d.assets.find((a: { name: string }) => a.name === 'Stock at cost').amount).toBe(stock);
  });
});

describe('Tally export', () => {
  it('amounts and escaping', () => {
    expect(_test.amt(123450)).toBe('1234.50');
    expect(_test.amt(-5)).toBe('-0.05');
    expect(_test.esc('Sri Lakshmi & Sons <"A">')).toBe('Sri Lakshmi &amp; Sons &lt;&quot;A&quot;&gt;');
  });

  it('masters: unique names, GST details, duty heads', async () => {
    await admin.post('/api/customers', { name: `Ravi & Co ${h.tag}`, phone: '9000011111' });
    await admin.post('/api/customers', { name: `Ravi & Co ${h.tag}`, phone: '9000022222' });
    await admin.post('/api/customers', { name: `Mumbai Paints ${h.tag}`, gstin: '27AAPFU0939F1ZV', address: 'Mumbai' });
    const res = await inject('/api/tally/masters.xml', admin.token);
    expect(res.statusCode).toBe(200);
    const x = res.body;
    expect(x).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(x).toContain(`<LEDGER NAME="Ravi &amp; Co ${h.tag} (1111)"`);
    expect(x).toContain(`<LEDGER NAME="Ravi &amp; Co ${h.tag} (2222)"`);
    expect(x).toMatch(new RegExp(`Mumbai Paints ${h.tag}.*?<PARENT>Sundry Debtors</PARENT>.*?<LEDSTATENAME>Maharashtra</LEDSTATENAME><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><PARTYGSTIN>27AAPFU0939F1ZV</PARTYGSTIN>`));
    expect(x).toMatch(/<LEDGER NAME="Output CGST"[^]*?<GSTDUTYHEAD>Central Tax<\/GSTDUTYHEAD>/);
    // names unique across the file
    const names = [...x.matchAll(/<LEDGER NAME="([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('vouchers balance, debits negative, bill-wise refs; a renamed account follows', async () => {
    const [cash] = await h.app<{ id: number }[]>`select id from ledgers where system_code = 'cash'`;
    expect((await admin.put(`/api/tally/names/${cash!.id}`, { tallyName: 'Cash' })).status).toBe(200);
    const [sales] = await h.app<{ id: number }[]>`select id from ledgers where system_code = 'sales'`;
    expect((await admin.put(`/api/tally/names/${sales!.id}`, { tallyName: 'Cash' })).status).toBe(409);
    expect((await admin.put(`/api/tally/names/${sales!.id}`, { tallyName: `Sales GST ${h.tag}` })).status).toBe(200);
    expect((await counter.put(`/api/tally/names/${sales!.id}`, { tallyName: 'x' })).status).toBe(403);

    const res = await inject(`/api/tally/vouchers.xml?${range}`, admin.token);
    expect(res.statusCode).toBe(200);
    const x = res.body;
    const vouchers = [...x.matchAll(/<VOUCHER [^]*?<\/VOUCHER>/g)].map((m) => m[0]);
    expect(vouchers.length).toBe(Number(res.headers['x-voucher-count']));
    for (const v of vouchers) {
      const entries = [...v.matchAll(/<ALLLEDGERENTRIES\.LIST><LEDGERNAME>[^<]*<\/LEDGERNAME><ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>(?:<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>)?<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)];
      expect(entries.length).toBeGreaterThanOrEqual(2);
      const total = entries.reduce((t, e) => t + Math.round(Number(e[2]) * 100), 0);
      expect(total).toBe(0);
      for (const e of entries) expect(e[1] === 'Yes').toBe(Number(e[2]) < 0); // debit ⇔ negative
    }
    const sale = vouchers.find((v) => v.includes(`<VOUCHERNUMBER>${invoice.number}</VOUCHERNUMBER>`))!;
    expect(sale).toContain('VCHTYPE="Sales"');
    expect(sale).toContain(`<LEDGERNAME>Sales GST ${h.tag}</LEDGERNAME>`);
    expect(sale).toContain('<LEDGERNAME>Cash</LEDGERNAME>');
    expect(sale).toContain('<DATE>' + today.replace(/-/g, '') + '</DATE>');

    const again = await inject(`/api/tally/vouchers.xml?${range}`, admin.token);
    expect(again.headers['x-overlaps']).toBe('1');
    expect((await inject(`/api/tally/vouchers.xml?${range}`, counter.token)).statusCode).toBe(403);
    expect((await admin.get('/api/tally/exports')).body.length).toBeGreaterThanOrEqual(2);
    await admin.put(`/api/tally/names/${sales!.id}`, { tallyName: null });
  });

  it('stock items with HSN and GST rates', async () => {
    const res = await inject('/api/tally/stock-items.xml', admin.token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(new RegExp(`<HSNCODE>2523</HSNCODE>`));
    expect(res.body).toContain('<UNIT NAME="bag"');
  });
});

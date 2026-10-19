import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let stock: Awaited<ReturnType<typeof h.loginAs>>;

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  stock = await h.loginAs('stock');
  await h.app`insert into categories (name, max_disc_type, max_disc_value) values (${'P2 ' + h.tag}, 'pct', 1000) on conflict do nothing`;
});
afterAll(() => h.close());

async function catId() {
  const [c] = await h.app<{ id: number }[]>`select id from categories where name = ${'P2 ' + h.tag}`;
  return c!.id;
}

async function newProduct(body: Record<string, unknown>) {
  const r = await admin.post('/api/products', { sku: `P2-${randomUUID().slice(0, 8)}`, name: `P2 item ${randomUUID().slice(0, 4)}`, unitCode: 'pcs', categoryId: await catId(), ...body });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.id as number;
}

async function customer(body: Record<string, unknown> = {}) {
  const r = await admin.post('/api/customers', { name: `Cust ${randomUUID().slice(0, 6)}`, ...body });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.id as number;
}

describe('prices including GST', () => {
  it('a product priced including GST bills at exactly that amount', async () => {
    const p = await newProduct({ salePricePaise: 99900, priceIncludesTax: true, gstRateBp: 1800, openingQtyMilli: 10000 });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 3000, discountBp: 0 }] });
    expect(r.status).toBe(200);
    const inv = (await admin.get(`/api/invoices/${r.body.id}`)).body;
    // 3 × 999 = 2997.00 incl → taxable 2539.83 + 228.58 + 228.58 = 2996.99; total 2997 with 0.01 round off
    expect(inv).toMatchObject({ taxable_paise: 253983, cgst_paise: 22858, sgst_paise: 22858, total_paise: 299700, round_off_paise: 1 });
    expect(inv.lines[0]).toMatchObject({ rate_mode: 'incl', rate_paise: 99900, amount_paise: 299700 });
  });

  it('an excl-priced product can be billed in incl mode at the converted rate without admin', async () => {
    const p = await newProduct({ salePricePaise: 100000, openingQtyMilli: 10000 });
    const ok = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, rateMode: 'incl', ratePaise: 118000, discountBp: 0 }] });
    expect(ok.status).toBe(200);
    const bad = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, rateMode: 'incl', ratePaise: 117000, discountBp: 0 }] });
    expect(bad.body.code).toBe('PRICE_CHANGE_NOT_ALLOWED');
  });
});

describe('units: steel stocked in rods, bought in tonnes', () => {
  let rod: number;
  beforeAll(async () => {
    rod = await newProduct({ name: `TMT 12mm ${h.tag}`, unitCode: 'rod', salePricePaise: 64500, units: [{ unitCode: 'tonne', factorNum: 94, forSale: false }] });
  });

  it('a purchase of 5 tonnes adds 470 rods; the actual count can be entered instead', async () => {
    const s = await admin.post('/api/suppliers', { name: `JSW ${randomUUID().slice(0, 5)}` });
    const r = await stock.post('/api/purchases', {
      supplierId: s.body.id,
      supplierInvoiceNo: `J-${randomUUID().slice(0, 6)}`,
      supplierInvoiceDate: '2026-10-15',
      lines: [{ productId: rod, qtyMilli: 5000, unitCode: 'tonne', taxablePaise: 27750000, gstRateBp: 1800 }],
    });
    expect(r.status).toBe(200);
    expect(await h.stockOf(rod)).toBe(470000);
    const d = (await stock.get(`/api/purchases/${r.body.id}`)).body;
    expect(d.lines[0]).toMatchObject({ qty_milli: 470000, unit_code: 'rod', bill_unit_code: 'tonne', bill_qty_milli: 5000, unit_cost_paise: 59043 });

    const counted = await stock.post('/api/purchases', {
      supplierId: s.body.id,
      supplierInvoiceNo: `J-${randomUUID().slice(0, 6)}`,
      supplierInvoiceDate: '2026-10-15',
      lines: [{ productId: rod, qtyMilli: 1000, unitCode: 'tonne', baseQtyMilli: 96000, taxablePaise: 5550000, gstRateBp: 1800 }],
    });
    expect(counted.status).toBe(200);
    expect(await h.stockOf(rod)).toBe(566000);
  });

  it('rods are sold by count; tonne is not a selling unit here', async () => {
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: rod, qtyMilli: 20000, discountBp: 0 }] });
    expect(r.status).toBe(200);
    expect(await h.stockOf(rod)).toBe(546000);
    const t = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: rod, qtyMilli: 1000, unitCode: 'tonne', discountBp: 0 }] });
    expect(t.body.code).toBe('BAD_UNIT');
  });

  it('selling in a bigger unit uses its own price and deducts base units', async () => {
    const wire = await newProduct({ unitCode: 'mtr', salePricePaise: 1700, openingQtyMilli: 900000, units: [{ unitCode: 'coil', factorNum: 90, pricePaise: 145000 }] });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: wire, qtyMilli: 2000, unitCode: 'coil', discountBp: 0 }] });
    expect(r.status).toBe(200);
    const inv = (await admin.get(`/api/invoices/${r.body.id}`)).body;
    expect(inv.lines[0]).toMatchObject({ unit_code: 'coil', qty_milli: 2000, base_qty_milli: 180000, rate_paise: 145000, taxable_paise: 290000 });
    expect(await h.stockOf(wire)).toBe(720000);
  });

  it("the base unit can't change once a product has stock", async () => {
    const r = await admin.patch(`/api/products/${rod}`, { unitCode: 'kg' });
    expect(r.body.code).toBe('UNIT_LOCKED');
  });
});

describe('GST rules on bills', () => {
  it('bills a customer from another state with IGST', async () => {
    const p = await newProduct({ salePricePaise: 100000, openingQtyMilli: 10000 });
    const c = await customer({ gstin: '27AAPFU0939F1ZV', address: 'Pune' });
    const r = await counter.post('/api/invoices', { paymentMode: 'credit', customerId: c, lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(r.status).toBe(200);
    const inv = (await admin.get(`/api/invoices/${r.body.id}`)).body;
    expect(inv).toMatchObject({ supply_type: 'inter', place_of_supply: '27', igst_paise: 18000, cgst_paise: 0, customer_gstin: '27AAPFU0939F1ZV' });
  });

  it('refuses a GSTIN whose check digit is wrong', async () => {
    const r = await admin.post('/api/customers', { name: 'Bad GSTIN', gstin: '27AAPFU0939F1ZW' });
    expect(r.body.code).toBe('BAD_GSTIN');
  });

  it('a business customer needs an address on the bill', async () => {
    const p = await newProduct({ salePricePaise: 1000, openingQtyMilli: 10000 });
    const c = await customer({ gstin: '27AAPFU0939F1ZV' });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', customerId: c, lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(r.body.code).toBe('B2B_NEEDS_ADDRESS');
  });

  it('a walk-in bill of ₹50,000 or more needs name and address', async () => {
    const p = await newProduct({ salePricePaise: 5000000, openingQtyMilli: 10000 });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(r.body.code).toBe('B2C_NEEDS_DETAILS');
    const ok = await counter.post('/api/invoices', { paymentMode: 'cash', customerName: 'Ramana', customerAddress: 'Kavali', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(ok.status).toBe(200);
  });
});

describe('sales returns (credit notes)', () => {
  it('partial returns add up exactly to the original, restock, and reduce the customer balance', async () => {
    const p = await newProduct({ salePricePaise: 33333, openingQtyMilli: 10000, maxDiscType: 'pct', maxDiscValue: 1000 });
    const c = await customer();
    const bill = await admin.post('/api/invoices', { paymentMode: 'credit', customerId: c, lines: [{ productId: p, qtyMilli: 3000, discountBp: 0 }] });
    const inv = (await admin.get(`/api/invoices/${bill.body.id}`)).body;
    const lineId = inv.lines[0].id;
    const bal = async () => (await admin.get(`/api/customers/${c}`)).body.customer.balance_paise as number;
    expect(await bal()).toBe(inv.total_paise);

    // counter staff need the admin PIN
    expect((await counter.post(`/api/invoices/${inv.id}/returns`, { reason: 'Extra', refundMode: 'account', lines: [{ invoiceLineId: lineId, qtyMilli: 1000, restock: true }] })).body.code).toBe('NEEDS_OVERRIDE');

    const r1 = await admin.post(`/api/invoices/${inv.id}/returns`, { reason: 'Extra bought', refundMode: 'account', lines: [{ invoiceLineId: lineId, qtyMilli: 1000, restock: true }] });
    expect(r1.status).toBe(200);
    expect(r1.body.number).toMatch(/^CN\//);
    expect(await h.stockOf(p)).toBe(8000);
    const r2 = await admin.post(`/api/invoices/${inv.id}/returns`, { reason: 'Rest', refundMode: 'account', lines: [{ invoiceLineId: lineId, qtyMilli: 2000, restock: false }] });
    expect(r2.status).toBe(200);
    expect(r1.body.totalPaise + r2.body.totalPaise).toBe(inv.total_paise);
    expect(await bal()).toBe(0);
    expect(await h.stockOf(p)).toBe(8000); // damaged ones written off
    const [adj] = await h.app`select kind, qty_milli from stock_movements where product_id = ${p} and kind = 'adjustment'`;
    expect(adj).toMatchObject({ qty_milli: -2000 });

    const more = await admin.post(`/api/invoices/${inv.id}/returns`, { reason: 'again', refundMode: 'cash', lines: [{ invoiceLineId: lineId, qtyMilli: 1000, restock: true }] });
    expect(more.body.code).toBe('TOO_MUCH');
    expect((await admin.post(`/api/invoices/${inv.id}/cancel`, { reason: 'try' })).body.code).toBe('HAS_RETURNS');
  });

  it('a walk-in return is refunded in cash, not to an account', async () => {
    const p = await newProduct({ salePricePaise: 10000, openingQtyMilli: 10000 });
    const bill = await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    const inv = (await admin.get(`/api/invoices/${bill.body.id}`)).body;
    expect((await admin.post(`/api/invoices/${inv.id}/returns`, { reason: 'Wrong item', refundMode: 'account', lines: [{ invoiceLineId: inv.lines[0].id, qtyMilli: 1000, restock: true }] })).body.code).toBe('NO_ACCOUNT');
    const ok = await admin.post(`/api/invoices/${inv.id}/returns`, { reason: 'Wrong item', refundMode: 'cash', lines: [{ invoiceLineId: inv.lines[0].id, qtyMilli: 1000, restock: true }] });
    expect(ok.body.totalPaise).toBe(inv.total_paise);
    const cn = (await admin.get(`/api/credit-notes/${ok.body.id}`)).body;
    const [v] = await h.app`select sum(dr_paise) dr, sum(cr_paise) cr from voucher_lines where voucher_id = ${cn.voucher_id}`;
    expect(v!.dr).toBe(v!.cr);
  });
});

describe('purchase returns (debit notes)', () => {
  it('sends goods back: stock out, supplier balance down', async () => {
    const p = await newProduct({ salePricePaise: 1000 });
    const s = await admin.post('/api/suppliers', { name: `Ret ${randomUUID().slice(0, 5)}` });
    const pu = await stock.post('/api/purchases', { supplierId: s.body.id, supplierInvoiceNo: `R-${randomUUID().slice(0, 5)}`, supplierInvoiceDate: '2026-10-15', lines: [{ productId: p, qtyMilli: 10000, taxablePaise: 100000, gstRateBp: 1800 }] });
    const d = (await stock.get(`/api/purchases/${pu.body.id}`)).body;
    const r = await stock.post(`/api/purchases/${pu.body.id}/returns`, { reason: 'Leaking tins', lines: [{ purchaseLineId: d.lines[0].id, baseQtyMilli: 4000 }] });
    expect(r.status).toBe(200);
    expect(r.body.number).toMatch(/^DN\//);
    expect(r.body.totalPaise).toBe(47200);
    expect(await h.stockOf(p)).toBe(6000);
    const payable = ((await admin.get('/api/suppliers?search=Ret')).body as { id: number; payable_paise: number }[]).find((x) => x.id === s.body.id)!.payable_paise;
    expect(payable).toBe(118000 - 47200);
    expect((await admin.post(`/api/purchases/${pu.body.id}/cancel`, { reason: 'x x' })).body.code).toBe('HAS_RETURNS');
    expect((await stock.post(`/api/purchases/${pu.body.id}/returns`, { reason: 'more', lines: [{ purchaseLineId: d.lines[0].id, baseQtyMilli: 7000 }] })).body.code).toBe('TOO_MUCH');
  });
});

describe('GST month lock', () => {
  it('once GSTR-1 is filed for the month, bills can only be corrected with credit notes', async () => {
    const p = await newProduct({ salePricePaise: 1000, openingQtyMilli: 5000 });
    const bill = await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    const month = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 7);
    expect((await counter.post(`/api/gst/periods/${month}`, { filed: true })).status).toBe(403);
    await admin.post(`/api/gst/periods/${month}`, { filed: true, note: 'Filed by CA' });
    try {
      expect((await admin.post(`/api/invoices/${bill.body.id}/cancel`, { reason: 'mistake' })).body.code).toBe('MONTH_FILED');
    } finally {
      await admin.post(`/api/gst/periods/${month}`, { filed: false });
    }
    expect((await admin.post(`/api/invoices/${bill.body.id}/cancel`, { reason: 'mistake' })).status).toBe(200);
  });
});

describe('books still balance', () => {
  it('every voucher balances and stock matches the ledger', async () => {
    expect(await h.app`select voucher_id from voucher_lines group by voucher_id having sum(dr_paise) <> sum(cr_paise)`).toEqual([]);
    expect((await admin.get('/api/stock/reconcile')).body).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInvoice } from '../src/services/billing.js';
import { createCustomer } from '../src/services/parties.js';
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
});
afterAll(() => h.close());

async function balanceOfCustomer(id: number) {
  const r = await admin.get(`/api/customers/${id}`);
  return r.body.customer.balance_paise as number;
}

describe('saving a bill', () => {
  it('saves a cash bill: number, totals, stock, voucher, audit', async () => {
    const p = await h.product({ price: 38550, qty: 10 }); // ₹385.50 excl GST
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 3000, discountBp: 0 }] });
    expect(r.status).toBe(200);
    expect(r.body.number).toMatch(/^KPH\/\d{2}-\d{2}\/\d{6}$/);

    const inv = (await counter.get(`/api/invoices/${r.body.id}`)).body;
    // 3 × 385.50 = 1156.50; CGST = SGST = 104.09 (104.085 → 104.09); total 1364.68 → 1365.00, round off +0.32
    expect(inv).toMatchObject({ taxable_paise: 115650, cgst_paise: 10409, sgst_paise: 10409, total_paise: 136500, round_off_paise: 32, status: 'posted' });
    expect(inv.lines[0].cost_price_cp).toBeUndefined(); // counter staff can't see cost
    expect(await h.stockOf(p)).toBe(7000);

    const lines = await h.app<{ dr: number; cr: number }[]>`
      select sum(dr_paise) as dr, sum(cr_paise) as cr from voucher_lines where voucher_id = ${inv.voucher_id}`;
    expect(lines[0]!.dr).toBe(136500);
    expect(lines[0]!.cr).toBe(136500);

    const [a] = await h.app`select user_id, device_id from audit_log where action = 'invoice.created' and entity_id = ${String(r.body.id)}`;
    expect(a).toMatchObject({ user_id: h.users.counter.id, device_id: h.deviceId });
  });

  it('selling more than the records show adds the missing stock first (with a note), then sells it', async () => {
    const p = await h.product({ qty: 2 });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 3000, discountBp: 0 }] });
    expect(r.status).toBe(200);
    expect(r.body.stockAdded).toEqual([expect.objectContaining({ productId: p, addMilli: 1000 })]);
    expect(await h.stockOf(p)).toBe(0);
    const [m] = await h.app<{ kind: string; qty_milli: number; reason: string }[]>`
      select kind, qty_milli, reason from stock_movements where product_id = ${p} and kind = 'adjustment'`;
    expect(m).toMatchObject({ qty_milli: 1000, reason: `Not in stock records — added when billing ${r.body.number}` });
  });

  it('counts the same product on two lines together for the stock check', async () => {
    const p = await h.product({ qty: 5 });
    const r = await counter.post('/api/invoices', {
      paymentMode: 'cash',
      lines: [
        { productId: p, qtyMilli: 3000, discountBp: 0 },
        { productId: p, qtyMilli: 3000, discountBp: 0 },
      ],
    });
    expect(r.body.stockAdded).toEqual([expect.objectContaining({ productId: p, addMilli: 1000 })]);
    expect(await h.stockOf(p)).toBe(0);
  });

  it('does not save the same bill twice when the button is pressed twice', async () => {
    const p = await h.product({ qty: 10 });
    const body = { clientRef: randomUUID(), paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] };
    const [a, b] = await Promise.all([counter.post('/api/invoices', body), counter.post('/api/invoices', body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.number).toBe(b.body.number);
    expect(await h.stockOf(p)).toBe(9000);
  });

  it('needs a customer for credit, and credit raises their balance', async () => {
    const p = await h.product({ price: 10000, qty: 10 });
    const noCustomer = await counter.post('/api/invoices', { paymentMode: 'credit', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(noCustomer.body.code).toBe('CREDIT_NEEDS_CUSTOMER');

    const c = await counter.post('/api/customers', { name: `Mason ${h.tag}`, phone: `98${Math.floor(Math.random() * 1e8)}` });
    expect(c.status).toBe(200);
    const r = await counter.post('/api/invoices', { paymentMode: 'credit', customerId: c.body.id, lines: [{ productId: p, qtyMilli: 2000, discountBp: 0 }] });
    expect(r.status).toBe(200);
    expect(await balanceOfCustomer(c.body.id)).toBe(23600); // 2 × 100 + 18% = 236.00

    const pay = await counter.post('/api/receipts', { customerId: c.body.id, mode: 'upi', amountPaise: 10000, reference: 'UPI ref' });
    expect(pay.status).toBe(200);
    expect(pay.body.number).toMatch(/^RCT\//);
    expect(pay.body.balancePaise).toBe(13600);
  });

  it('only admin can change the rate on a bill', async () => {
    const p = await h.product({ price: 10000 });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, ratePaise: 9000, discountBp: 0 }] });
    expect(r.body.code).toBe('PRICE_CHANGE_NOT_ALLOWED');
    const ok = await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, ratePaise: 9000, discountBp: 0 }] });
    expect(ok.status).toBe(200);
  });

  it('stock staff cannot bill', async () => {
    const p = await h.product();
    const r = await stock.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(r.status).toBe(403);
  });
});

describe('max discount and admin PIN override', () => {
  it('allows discount up to the product limit', async () => {
    const p = await h.product({ maxDisc: { type: 'pct', value: 800 } });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 800 }] });
    expect(r.status).toBe(200);
  });

  it('blocks a discount above the limit until an admin approves with their PIN', async () => {
    const p = await h.product({ maxDisc: { type: 'pct', value: 800 } });
    const line = { productId: p, qtyMilli: 1000, discountBp: 1000 };
    const blocked = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [line] });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('NEEDS_OVERRIDE');
    expect(blocked.body.details).toMatchObject({ permission: 'billing.discount_over_limit', productId: p });

    // Counter staff cannot approve themselves
    const self = await counter.post('/api/auth/override', {
      permission: 'billing.discount_over_limit', approverId: h.users.counter.id, pin: '2222', context: { productId: p, discountBp: 1000 },
    });
    expect(self.body.code).toBe('APPROVER_NOT_ALLOWED');

    const wrongPin = await counter.post('/api/auth/override', {
      permission: 'billing.discount_over_limit', approverId: h.users.admin.id, pin: '9999', context: { productId: p, discountBp: 1000 },
    });
    expect(wrongPin.body.code).toBe('BAD_PIN');

    const ok = await counter.post('/api/auth/override', {
      permission: 'billing.discount_over_limit', approverId: h.users.admin.id, pin: '1111', context: { productId: p, discountBp: 1000 },
    });
    expect(ok.status).toBe(200);

    const saved = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ ...line, overrideToken: ok.body.token }] });
    expect(saved.status).toBe(200);
    const [log] = await h.app`select approved_by, details from audit_log where action = 'discount.over_limit' and entity_id = ${String(saved.body.id)}`;
    expect(log!.approved_by).toBe(h.users.admin.id);
    expect(log!.details).toMatchObject({ discountBp: 1000, maxBp: 800 });

    // single use
    const again = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ ...line, overrideToken: ok.body.token }] });
    expect(again.body.code).toBe('OVERRIDE_INVALID');
  });

  it('an approval only covers the discount that was approved', async () => {
    const p = await h.product({ maxDisc: { type: 'pct', value: 500 } });
    const ok = await counter.post('/api/auth/override', {
      permission: 'billing.discount_over_limit', approverId: h.users.admin.id, pin: '1111', context: { productId: p, discountBp: 700 },
    });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 900, overrideToken: ok.body.token }] });
    expect(r.body.code).toBe('OVERRIDE_INVALID');
  });

  it('applies the lower of product limit and staff cap', async () => {
    await h.app`update users set discount_cap_bp = 300 where id = ${h.users.counter.id}`;
    try {
      const p = await h.product({ maxDisc: { type: 'pct', value: 800 } });
      const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 500 }] });
      expect(r.body.code).toBe('NEEDS_OVERRIDE');
      const ok = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 300 }] });
      expect(ok.status).toBe(200);
    } finally {
      await h.app`update users set discount_cap_bp = null where id = ${h.users.counter.id}`;
    }
  });

  it('uses the category default when the product has none, and 0% when neither is set', async () => {
    const [cat] = await h.app<{ id: number }[]>`insert into categories (name, max_disc_type, max_disc_value) values (${'Cat ' + h.tag}, 'pct', 200) returning id`;
    const p = await h.product();
    await h.app`update products set category_id = ${cat!.id} where id = ${p}`;
    expect((await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 200 }] })).status).toBe(200);
    expect((await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 201 }] })).body.code).toBe('NEEDS_OVERRIDE');
    const bare = await h.product();
    expect((await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: bare, qtyMilli: 1000, discountBp: 1 }] })).body.code).toBe('NEEDS_OVERRIDE');
  });

  it('₹ per unit limits are converted against the rate', async () => {
    const p = await h.product({ price: 33000, maxDisc: { type: 'amt', value: 300 } }); // ₹3 off ₹330 → 0.90%
    expect((await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 90 }] })).status).toBe(200);
    expect((await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 100 }] })).body.code).toBe('NEEDS_OVERRIDE');
  });
});

describe('cancelling a bill', () => {
  it('needs admin PIN for counter staff, restores stock and reverses accounts', async () => {
    const p = await h.product({ price: 50000, qty: 10 });
    const c = await createCustomer(h.app, h.ctx('admin'), { name: `Cancel test ${h.tag}` });
    const bill = await counter.post('/api/invoices', { paymentMode: 'credit', customerId: c.id, lines: [{ productId: p, qtyMilli: 4000, discountBp: 0 }] });
    expect(await h.stockOf(p)).toBe(6000);
    expect(await balanceOfCustomer(c.id)).toBe(236000);

    const noReason = await counter.post(`/api/invoices/${bill.body.id}/cancel`, { reason: '' });
    expect(noReason.body.code).toBe('REASON_REQUIRED');
    const blocked = await counter.post(`/api/invoices/${bill.body.id}/cancel`, { reason: 'Customer returned' });
    expect(blocked.body.code).toBe('NEEDS_OVERRIDE');

    const o = await counter.post('/api/auth/override', {
      permission: 'billing.cancel', approverId: h.users.admin.id, pin: '1111', context: { invoiceId: bill.body.id },
    });
    const done = await counter.post(`/api/invoices/${bill.body.id}/cancel`, { reason: 'Customer returned', overrideToken: o.body.token });
    expect(done.status).toBe(200);

    expect(await h.stockOf(p)).toBe(10000);
    expect(await balanceOfCustomer(c.id)).toBe(0);
    const inv = (await admin.get(`/api/invoices/${bill.body.id}`)).body;
    expect(inv).toMatchObject({ status: 'cancelled', cancel_reason: 'Customer returned', cancel_approved_by: h.users.admin.id, number: bill.body.number });

    const twice = await admin.post(`/api/invoices/${bill.body.id}/cancel`, { reason: 'again' });
    expect(twice.body.code).toBe('ALREADY_CANCELLED');
  });

  it('a posted bill cannot be edited or deleted, even directly in the database', async () => {
    const p = await h.product();
    const bill = await admin.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    await expect(h.owner`update sales_invoices set total_paise = 1 where id = ${bill.body.id}`).rejects.toThrow(/cannot be edited/);
    await expect(h.owner`delete from sales_invoices where id = ${bill.body.id}`).rejects.toThrow(/permanent/);
    await expect(h.owner`update sales_invoice_lines set qty_milli = 1 where invoice_id = ${bill.body.id}`).rejects.toThrow(/permanent/);
  });
});

describe('invoice numbering', () => {
  it('gives gapless, unique numbers when counters bill at the same moment', async () => {
    const p = await h.product({ qty: 1000 });
    const ctx = h.ctx('counter');
    const results = await Promise.all(
      Array.from({ length: 40 }, () => createInvoice(h.app, ctx, { paymentMode: 'cash', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] })),
    );
    const seqs = results.map((r) => Number(r.number.split('/')[2])).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(40);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! - seqs[i - 1]!).toBe(1);
    expect(await h.stockOf(p)).toBe(960000);
  });

  it('restarts at 1 every financial year (April, India time)', async () => {
    const p = await h.product({ qty: 100 });
    const ctx = h.ctx('admin');
    const line = { paymentMode: 'cash' as const, lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] };
    const march = await createInvoice(h.app, ctx, line, { at: new Date('2031-03-31T18:00:00Z') }); // 23:30 IST, 31 Mar 2031
    const april1 = await createInvoice(h.app, ctx, line, { at: new Date('2031-03-31T18:31:00Z') }); // 00:01 IST, 1 Apr 2031
    const april2 = await createInvoice(h.app, ctx, line, { at: new Date('2031-04-02T05:00:00Z') });
    expect(march.number).toBe('KPH/30-31/000001');
    expect(april1.number).toBe('KPH/31-32/000001');
    expect(april2.number).toBe('KPH/31-32/000002');
  });
});

describe('permissions', () => {
  it('counter staff cannot change stock, prices, or see cost', async () => {
    const p = await h.product();
    expect((await counter.post(`/api/products/${p}/adjust`, { newQtyMilli: 5000, reason: 'count' })).status).toBe(403);
    expect((await counter.patch(`/api/products/${p}`, { salePricePaise: 1 })).status).toBe(403);
    const list = (await counter.get('/api/products')).body;
    expect(list[0]).not.toHaveProperty('cost_price_cp');
    expect((await counter.get('/api/users')).status).toBe(403);
    expect((await counter.put('/api/settings', { idleLockMinutes: 9 })).status).toBe(403);
    expect((await counter.post('/api/backups/run')).status).toBe(403);
  });

  it('stock staff can adjust stock (with a reason) but not prices', async () => {
    const p = await h.product({ qty: 10 });
    expect((await stock.post(`/api/products/${p}/adjust`, { newQtyMilli: 8000, reason: '' })).body.code).toBe('REASON_REQUIRED');
    const r = await stock.post(`/api/products/${p}/adjust`, { newQtyMilli: 8000, reason: 'Damaged bags' });
    expect(r.status).toBe(200);
    expect(await h.stockOf(p)).toBe(8000);
    const [m] = await h.app`select kind, qty_milli, reason, user_id from stock_movements where product_id = ${p} order by id desc limit 1`;
    expect(m).toMatchObject({ kind: 'adjustment', qty_milli: -2000, reason: 'Damaged bags', user_id: h.users.stock.id });
    expect((await stock.patch(`/api/products/${p}`, { salePricePaise: 1 })).status).toBe(403);
  });

  it('admin price change is kept in price history and the activity log', async () => {
    const p = await h.product({ price: 10000 });
    expect((await admin.patch(`/api/products/${p}`, { salePricePaise: 12000 })).status).toBe(200);
    const [ph] = await h.app`select old_value, new_value from price_history where product_id = ${p}`;
    expect(ph).toEqual({ old_value: 10000, new_value: 12000 });
    const [a] = await h.app`select action from audit_log where entity = 'product' and entity_id = ${String(p)} order by id desc limit 1`;
    expect(a!.action).toBe('product.price_changed');
  });

  it('deleting a used product only deactivates it', async () => {
    const used = await h.product();
    expect((await admin.del(`/api/products/${used}`)).body).toEqual({ deleted: false, deactivated: true });
    const unused = await h.product({ qty: 0 });
    expect((await admin.del(`/api/products/${unused}`)).body).toEqual({ deleted: true, deactivated: false });
  });
});

describe('login', () => {
  it('locks a user out after 5 wrong PINs', async () => {
    const { id } = await (await import('../src/services/users.js')).createUser(h.app, null, { name: `Lock ${h.tag}`, roleId: 'counter', pin: '4444' });
    for (let i = 0; i < 4; i++) expect((await h.call('POST', '/api/auth/login', { userId: id, pin: '0000' })).body.code).toBe('BAD_PIN');
    expect((await h.call('POST', '/api/auth/login', { userId: id, pin: '0000' })).body.code).toBe('LOCKED');
    expect((await h.call('POST', '/api/auth/login', { userId: id, pin: '4444' })).body.code).toBe('LOCKED');
  });

  it('a new computer must be approved before anyone can log in on it', async () => {
    const reg = await h.call('POST', '/api/devices/register', { name: 'Counter 9' }, { device: '' });
    const dev = reg.body.token;
    expect((await h.call('POST', '/api/auth/login', { userId: h.users.counter.id, pin: '2222' }, { device: dev })).body.code).toBe('DEVICE_NOT_APPROVED');
    const bad = await h.call('POST', '/api/devices/approve-here', { approverId: h.users.counter.id, pin: '2222' }, { device: dev });
    expect(bad.status).toBe(403);
    const ok = await h.call('POST', '/api/devices/approve-here', { approverId: h.users.admin.id, pin: '1111' }, { device: dev });
    expect(ok.status).toBe(200);
    expect((await h.call('POST', '/api/auth/login', { userId: h.users.counter.id, pin: '2222' }, { device: dev })).status).toBe(200);
  });

  it('a session only works on the computer it was created on', async () => {
    const reg = await h.call('POST', '/api/devices/register', { name: 'Other PC' }, { device: '' });
    await h.call('POST', '/api/devices/approve-here', { approverId: h.users.admin.id, pin: '1111' }, { device: reg.body.token });
    const r = await h.call('GET', '/api/dashboard', undefined, { token: counter.token, device: reg.body.token });
    expect(r.body.code).toBe('NOT_LOGGED_IN');
  });
});

describe('stock ledger', () => {
  it('stock balances always equal the sum of the stock ledger', async () => {
    const r = await admin.get('/api/stock/reconcile');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('every voucher balances', async () => {
    const rows = await h.app`select voucher_id from voucher_lines group by voucher_id having sum(dr_paise) <> sum(cr_paise)`;
    expect(rows).toEqual([]);
  });
});

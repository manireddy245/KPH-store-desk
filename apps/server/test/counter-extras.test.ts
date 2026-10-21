import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => (h = await makeHarness()));
afterAll(async () => h.close());

describe('customer GST number typed on the bill', () => {
  it('is saved on the bill and sets the place of supply from its state', async () => {
    const counter = await h.loginAs('counter');
    const p = await h.product();
    const r = await counter.post('/api/invoices', {
      paymentMode: 'cash',
      customerName: 'Sri Builders',
      customerAddress: 'Nellore',
      customerGstin: '29abcde1234f1zw',
      lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }],
    });
    expect(r.status).toBe(200);
    const [inv] = await h.app<{ customer_gstin: string; place_of_supply: string; supply_type: string }[]>`select customer_gstin, place_of_supply, supply_type from sales_invoices where id = ${r.body.id}`;
    expect(inv).toMatchObject({ customer_gstin: '29ABCDE1234F1ZW', place_of_supply: '29', supply_type: 'inter' });
  });

  it('is optional, but must be valid and needs a name and address', async () => {
    const counter = await h.loginAs('counter');
    const p = await h.product();
    const bad = await counter.post('/api/invoices', { paymentMode: 'cash', customerName: 'X Y', customerAddress: 'Kavali', customerGstin: '12345', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(bad.body.code).toBe('BAD_GSTIN');
    const noAddr = await counter.post('/api/invoices', { paymentMode: 'cash', customerGstin: '37ABCDE1234F1ZZ', lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
    expect(noAddr.body.code).toBe('B2B_NEEDS_ADDRESS');
  });
});

describe('shipping charges', () => {
  it('counter staff can type the amount for the built-in shipping item, and no stock is used', async () => {
    const counter = await h.loginAs('counter');
    const [ship] = await h.app<{ id: number }[]>`select id from products where sku = 'SHIPPING'`;
    expect(ship).toBeTruthy();
    const p = await h.product();
    const r = await counter.post('/api/invoices', {
      paymentMode: 'cash',
      lines: [
        { productId: p, qtyMilli: 1000, discountBp: 0 },
        { productId: ship!.id, qtyMilli: 1000, discountBp: 0, ratePaise: 50000 },
      ],
    });
    expect(r.status).toBe(200);
    const [l] = await h.app<{ taxable_paise: number }[]>`select taxable_paise from sales_invoice_lines where invoice_id = ${r.body.id} and product_id = ${ship!.id}`;
    expect(l!.taxable_paise).toBe(50000);
    const [m] = await h.app`select 1 from stock_movements where product_id = ${ship!.id} limit 1`;
    expect(m).toBeUndefined();
  });
});

describe('"to order" list', () => {
  it('adds items, moves them to ordered, and deletes them', async () => {
    const stock = await h.loginAs('stock');
    const p = await h.product();
    const a = await stock.post('/api/order-list', { productId: p, qtyMilli: 20000, note: 'ask dealer' });
    const b = await stock.post('/api/order-list', { itemText: '6 mm binding wire' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await stock.post(`/api/order-list/${a.body.id}/ordered`, { ordered: true })).status).toBe(200);
    const l = await stock.get('/api/order-list');
    expect(l.body.toOrder.some((r: { id: number }) => r.id === b.body.id)).toBe(true);
    const done = l.body.ordered.find((r: { id: number }) => r.id === a.body.id);
    expect(done).toMatchObject({ qty_milli: 20000, note: 'ask dealer', ordered_by_name: expect.any(String) });
    expect((await stock.del(`/api/order-list/${b.body.id}`)).status).toBe(200);
    const counter = await h.loginAs('counter');
    expect((await counter.get('/api/order-list')).status).toBe(403);
  });
});

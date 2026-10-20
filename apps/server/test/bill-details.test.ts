import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
});
afterAll(() => h.close());

async function service() {
  const r = await admin.post('/api/products', {
    sku: `SVC-${randomUUID().slice(0, 8)}`,
    name: 'Loading and unloading charges',
    unitCode: 'nos',
    hsn: '996749',
    gstRateBp: 1800,
    salePricePaise: 120000,
    isService: true,
  });
  expect(r.status).toBe(200);
  return r.body.id as number;
}
const movementsOf = async (productId: number) => (await h.app<{ n: number }[]>`select count(*)::int as n from stock_movements where product_id = ${productId}`)[0]!.n;

describe('services on bills', () => {
  it('a service is billed with its SAC and GST but never touches stock', async () => {
    const svc = await service();
    const goods = await h.product({ price: 30000, qty: 10 });
    const r = await counter.post('/api/invoices', {
      paymentMode: 'cash',
      lines: [
        { productId: goods, qtyMilli: 2000, discountBp: 0 },
        { productId: svc, qtyMilli: 1000, discountBp: 0 },
      ],
    });
    expect(r.status).toBe(200);
    const inv = (await counter.get(`/api/invoices/${r.body.id}`)).body;
    // 600 + 1200 = 1800 taxable; 9% + 9% each
    expect(inv).toMatchObject({ taxable_paise: 180000, cgst_paise: 16200, sgst_paise: 16200, total_paise: 212400 });
    expect(inv.lines.map((l: { is_service: boolean }) => l.is_service)).toEqual([false, true]);
    expect(await h.stockOf(goods)).toBe(8000);
    expect(await movementsOf(svc)).toBe(0);

    // shown as a service in the product list, not "out of stock"
    const list = (await admin.get(`/api/products?search=${encodeURIComponent('Loading and unloading')}`)).body as { id: number; stock_status: string }[];
    expect(list.find((p) => p.id === svc)?.stock_status).toBe('service');

    // returning or cancelling leaves services out of the stock ledger
    const svcLine = inv.lines.find((l: { is_service: boolean }) => l.is_service);
    const ret = await admin.post(`/api/invoices/${r.body.id}/returns`, { reason: 'Not unloaded by us', refundMode: 'cash', lines: [{ invoiceLineId: svcLine.id, qtyMilli: 1000, restock: true }] });
    expect(ret.status).toBe(200);
    expect(await movementsOf(svc)).toBe(0);

    const r2 = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: goods, qtyMilli: 1000, discountBp: 0 }, { productId: svc, qtyMilli: 2000, discountBp: 0 }] });
    expect(r2.status).toBe(200);
    expect((await admin.post(`/api/invoices/${r2.body.id}/cancel`, { reason: 'Wrong customer' })).status).toBe(200);
    expect(await movementsOf(svc)).toBe(0);
    expect(await h.stockOf(goods)).toBe(8000);
  });
});

describe('ship-to, PAN and delivery details', () => {
  it('saved with the bill, shown back, corrected later; a wrong PAN is refused', async () => {
    const goods = await h.product({ price: 10000, qty: 5 });
    const r = await counter.post('/api/invoices', {
      paymentMode: 'cash',
      lines: [{ productId: goods, qtyMilli: 1000, discountBp: 0 }],
      details: { shipToName: 'Apartment site', shipToAddress: 'Musunur Road, Kavali', customerPan: 'abcfs1234k', dispatchedThrough: 'Own vehicle', termsOfDelivery: '  ' },
    });
    expect(r.status).toBe(200);
    let inv = (await counter.get(`/api/invoices/${r.body.id}`)).body;
    expect(inv.details).toMatchObject({ ship_to_name: 'Apartment site', ship_to_address: 'Musunur Road, Kavali', customer_pan: 'ABCFS1234K', dispatched_through: 'Own vehicle', terms_of_delivery: null });

    expect((await counter.put(`/api/invoices/${r.body.id}/details`, { destination: 'Kavali', dispatchedThrough: null })).status).toBe(200);
    inv = (await counter.get(`/api/invoices/${r.body.id}`)).body;
    expect(inv.details).toMatchObject({ ship_to_name: 'Apartment site', destination: 'Kavali', dispatched_through: null });

    const bad = await counter.put(`/api/invoices/${r.body.id}/details`, { customerPan: '1234' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BAD_PAN');

    // a bill without details has none
    const plain = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: goods, qtyMilli: 1000, discountBp: 0 }] });
    expect((await counter.get(`/api/invoices/${plain.body.id}`)).body.details).toBeNull();
  });
});

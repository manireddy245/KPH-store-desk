import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeGstin } from '@kph/core';
import { parseTaxpayer } from '../src/services/gstlookup.js';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => (h = await makeHarness()));
afterAll(async () => h.close());

describe('new item made at the billing counter', () => {
  it('counter staff add it, bill it at the typed rate, and the missing stock is added', async () => {
    const counter = await h.loginAs('counter');
    const name = `Binding wire 6mm ${h.tag}`;
    const q = await counter.post('/api/products/quick', { name, unitCode: 'kg', gstRateBp: 1800, hsn: null });
    expect(q.status).toBe(200);
    const again = await counter.post('/api/products/quick', { name, unitCode: 'kg', gstRateBp: 1800 });
    expect(again.body).toEqual({ id: q.body.id, existing: true });
    const r = await counter.post('/api/invoices', { paymentMode: 'cash', lines: [{ productId: q.body.id, qtyMilli: 5000, discountBp: 0, ratePaise: 9000 }] });
    expect(r.status).toBe(200);
    expect(r.body.stockAdded).toEqual([expect.objectContaining({ productId: q.body.id, addMilli: 5000 })]);
    const [l] = await h.app<{ taxable_paise: number }[]>`select taxable_paise from sales_invoice_lines where invoice_id = ${r.body.id}`;
    expect(l!.taxable_paise).toBe(45000);
    const [p] = await h.app<{ added_at_billing: boolean; hsn: string | null }[]>`select added_at_billing, hsn from products where id = ${q.body.id}`;
    expect(p).toEqual({ added_at_billing: true, hsn: null });
    expect(await h.stockOf(q.body.id)).toBe(0);

    const withHsn = await counter.post('/api/products/quick', { name: `Cement ${h.tag}`, unitCode: 'bag', gstRateBp: 2800, hsn: ' 2523 ' });
    expect(withHsn.status).toBe(200);
    const [c] = await h.app<{ hsn: string }[]>`select hsn from products where id = ${withHsn.body.id}`;
    expect(c!.hsn).toBe('2523');
    expect((await counter.post('/api/products/quick', { name: `Bad ${h.tag}`, unitCode: 'bag', gstRateBp: 1800, hsn: '25AB' })).body.code).toBe('BAD_HSN');
  });
});

describe('GST details', () => {
  it('a GSTIN tells its state, PAN and kind of business without going online', () => {
    expect(decodeGstin('37abcpe1234f1za')).toMatchObject({ stateCode: '37', stateName: 'Andhra Pradesh', pan: 'ABCPE1234F', holderType: 'Individual / proprietor' });
    expect(decodeGstin('37ABCDE1234F1Z5')).toBeNull();
  });

  it('reads the GST portal taxpayer record, wherever the lookup service puts it', () => {
    const rec = { lgnm: 'SRI SAI TRADERS PRIVATE LIMITED', tradeNam: 'SRI SAI TRADERS', dty: 'Regular', sts: 'Active', ctb: 'Private Limited Company', pradr: { addr: { bno: '12-3', st: 'Main Road', loc: 'Kavali', dst: 'Nellore', stcd: 'Andhra Pradesh', pncd: '524201' } } };
    expect(parseTaxpayer({ flag: true, data: rec })).toEqual({
      legalName: 'SRI SAI TRADERS PRIVATE LIMITED',
      tradeName: 'SRI SAI TRADERS',
      type: 'Regular',
      status: 'Active',
      constitution: 'Private Limited Company',
      address: '12-3, Main Road, Kavali, Nellore, Andhra Pradesh, 524201',
    });
    expect(parseTaxpayer({ error: 'not found' })).toBeNull();
  });

  it('with no lookup service set up, the GSTIN is still read offline', async () => {
    const admin = await h.loginAs('admin');
    const r = await admin.get('/api/gstin/37ABCDE1234F1ZZ');
    expect(r.body).toMatchObject({ lookup: 'off', details: null, decoded: { pan: 'ABCDE1234F' } });
    expect((await admin.get('/api/gstin/37ABCDE1234F1Z5')).body.code).toBe('BAD_GSTIN');
  });

  it("are saved with the customer, apart from the contact details", async () => {
    const admin = await h.loginAs('admin');
    const c = await admin.post('/api/customers', {
      name: `Sri Sai Traders ${h.tag}`,
      gstin: '37ABCDE1234F1ZZ',
      address: 'Kavali',
      gst: { legalName: 'SRI SAI TRADERS PVT LTD', tradeName: 'SRI SAI TRADERS', type: 'Composition', status: 'Active', checked: true },
    });
    expect(c.status).toBe(200);
    const [row] = await h.app<{ gst_legal_name: string; gst_type: string; gst_checked_at: Date | null }[]>`select gst_legal_name, gst_type, gst_checked_at from customers where id = ${c.body.id}`;
    expect(row).toMatchObject({ gst_legal_name: 'SRI SAI TRADERS PVT LTD', gst_type: 'Composition' });
    expect(row!.gst_checked_at).toBeTruthy();
  });
});

it('"Sale by" is saved with the bill', async () => {
  const counter = await h.loginAs('counter');
  const p = await h.product();
  const r = await counter.post('/api/invoices', { paymentMode: 'cash', details: { saleBy: 'Ravi' }, lines: [{ productId: p, qtyMilli: 1000, discountBp: 0 }] });
  expect(r.status).toBe(200);
  const inv = await counter.get(`/api/invoices/${r.body.id}`);
  expect(inv.body.details.sale_by).toBe('Ravi');
});

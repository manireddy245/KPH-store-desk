import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => (h = await makeHarness()));
afterAll(async () => h.close());

it('a product with stock in tonnes can switch to selling in rods: stock, cost and price are converted', async () => {
  const a = await h.loginAs('admin');
  const id = await h.product({ qty: 5, price: 6000000, cost: 5500000 }); // 5 t, ₹60,000/t, cost ₹55,000/t
  await h.app`update products set unit_code = 'tonne' where id = ${id}`;
  const e = await a.patch(`/api/products/${id}`, {
    unitCode: 'rod',
    salePricePaise: 6000000, // left as it was in the form
    costPriceCp: 5500000 * 100,
    units: [{ unitCode: 'tonne', factorNum: 135, factorDen: 1, forSale: false, forPurchase: true }],
  });
  expect(e.status).toBe(200);
  expect(await h.stockOf(id)).toBe(675_000); // 5 × 135 rods
  const [p] = await h.app<{ unit_code: string; sale_price_paise: number; cost_price_cp: number }[]>`select unit_code, sale_price_paise, cost_price_cp from products where id = ${id}`;
  expect(p).toMatchObject({ unit_code: 'rod', sale_price_paise: Math.round(6000000 / 135), cost_price_cp: Math.round((5500000 * 100) / 135) });
  const [m] = await h.app<{ kind: string; reason: string }[]>`select kind, reason from stock_movements where product_id = ${id} order by id desc limit 1`;
  expect(m).toMatchObject({ kind: 'unit_change', reason: 'Unit changed: 1 tonne = 135 rod' });

  // without the conversion it explains what is needed
  const id2 = await h.product({ qty: 2 });
  const bad = await a.patch(`/api/products/${id2}`, { unitCode: 'rod', units: [] });
  expect(bad.status).toBe(400);
  expect(bad.body.message).toMatch(/how many rod are in 1 bag/);
});

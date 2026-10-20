import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { upgradeRows } from '../src/services/backup.js';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;

beforeAll(async () => {
  h = await makeHarness();
  admin = await h.loginAs('admin');
});
afterAll(() => h.close());

describe('cost prices with 4 decimals', () => {
  it('a cost like ₹57.2034 a kg is kept exactly; stock value is in paise', async () => {
    const r = await admin.post('/api/products', { sku: `KG-${randomUUID().slice(0, 8)}`, name: 'Binding wire', unitCode: 'kg', salePricePaise: 7500, costPriceCp: 572034, openingQtyMilli: 1525000 });
    expect(r.status).toBe(200);
    const [p] = await h.app<{ cost_price_cp: number }[]>`select cost_price_cp from products where id = ${r.body.id}`;
    expect(p!.cost_price_cp).toBe(572034);
    const [m] = await h.app<{ unit_cost_cp: number }[]>`select unit_cost_cp from stock_movements where product_id = ${r.body.id}`;
    expect(m!.unit_cost_cp).toBe(572034);
    // 1,525 kg × ₹57.2034 = ₹87,235.185 → ₹87,235.19
    const sv = await admin.get(`/api/reports/stock-value`);
    expect(sv.status).toBe(200);
    const row = sv.body.rows.find((x: { id: number }) => x.id === r.body.id);
    expect(row).toMatchObject({ qty: 1525000, cost: 572034, value: 8723519 });
  });

  it('old backups (cost in paise) are converted when restored', () => {
    expect(upgradeRows('products', [{ id: 1, cost_price_paise: 29200 }, { id: 2, cost_price_paise: null }])).toEqual([{ id: 1, cost_price_cp: 2920000 }, { id: 2, cost_price_cp: null }]);
    expect(upgradeRows('stock_movements', [{ id: 1, unit_cost_paise: 100 }])).toEqual([{ id: 1, unit_cost_cp: 10000 }]);
    expect(upgradeRows('price_history', [{ field: 'cost_price_paise', old_value: 100, new_value: 150 }, { field: 'sale_price_paise', old_value: 1, new_value: 2 }])).toEqual([
      { field: 'cost_price_cp', old_value: 10000, new_value: 15000 },
      { field: 'sale_price_paise', old_value: 1, new_value: 2 },
    ]);
    // new backups pass through untouched
    const fresh = [{ id: 1, cost_price_cp: 5 }];
    expect(upgradeRows('products', fresh)).toBe(fresh);
  });
});

import { describe, expect, inject, it } from 'vitest';
import { connect } from '../src/db/connect.js';
import { createDatabase, migrate } from '../src/db/migrate.js';
import { seedSample } from '../src/services/seed.js';

/** The sample workspace must always load completely (it is what staff train on). */
describe('sample data', () => {
  it('loads into a fresh database and the books balance', async () => {
    const ownerUrl = inject('ownerUrl');
    const admin = connect(ownerUrl.replace(/\/[^/]+$/, '/postgres'), { max: 1 });
    await admin.unsafe('drop database if exists storedesk_seedtest');
    await createDatabase(admin, 'storedesk_seedtest');
    const owner = connect(ownerUrl.replace(/\/[^/]+$/, '/storedesk_seedtest'), { max: 1 });
    const app = connect(inject('appUrl').replace(/\/[^/]+$/, '/storedesk_seedtest'), { max: 5 });
    try {
      await migrate(owner);
      await seedSample(app);
      const [c] = await app<{ p: number; i: number; u: number }[]>`
        select (select count(*)::int from products) p, (select count(*)::int from sales_invoices) i, (select count(*)::int from product_units) u`;
      expect(c!.p).toBeGreaterThanOrEqual(40);
      expect(c!.i).toBeGreaterThan(30);
      expect(c!.u).toBeGreaterThanOrEqual(4); // steel tonne units
      expect(await app`select voucher_id from voucher_lines group by voucher_id having sum(dr_paise) <> sum(cr_paise)`).toEqual([]);
      const [rod] = await app`select unit_code from products where sku = 'SMP-JSW-12'`;
      expect(rod!.unit_code).toBe('rod');
    } finally {
      await app.end();
      await owner.end();
      await admin.unsafe('drop database if exists storedesk_seedtest');
      await admin.end();
    }
  }, 120000);
});

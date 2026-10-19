import { afterAll, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/db/connect.js';

const owner = connect(inject('ownerUrl'), { max: 2 });
const app = connect(inject('appUrl'), { max: 2 });
afterAll(async () => {
  await owner.end();
  await app.end();
});

async function makeProduct(sku: string) {
  const [p] = await app<{ id: number }[]>`
    insert into products (sku, name, unit_code, sale_price_paise) values (${sku}, ${'Guard test ' + sku}, 'pcs', 1000) returning id`;
  return p!.id;
}

describe('database types', () => {
  it('returns bigint as number and date as string', async () => {
    const [r] = await app`select 12345678901::bigint as b, sum(x)::numeric as s, date '2026-04-01' as d from (values (1::bigint),(2::bigint)) t(x)`;
    expect(r).toEqual({ b: 12345678901, s: 3, d: '2026-04-01' });
  });
});

describe('stock ledger guards', () => {
  it('keeps stock_balances in step with movements', async () => {
    const id = await makeProduct('G-1');
    await app`insert into stock_movements (product_id, qty_milli, kind) values (${id}, 5000, 'opening'), (${id}, -2000, 'sale')`;
    const [b] = await app`select qty_milli from stock_balances where product_id = ${id}`;
    expect(b!.qty_milli).toBe(3000);
  });

  it('blocks editing or deleting stock movements, even for the owner', async () => {
    const id = await makeProduct('G-2');
    await app`insert into stock_movements (product_id, qty_milli, kind) values (${id}, 1000, 'opening')`;
    await expect(owner`update stock_movements set qty_milli = 9 where product_id = ${id}`).rejects.toThrow(/permanent/);
    await expect(owner`delete from stock_movements where product_id = ${id}`).rejects.toThrow(/permanent/);
  });

  it('app login cannot write stock balances directly', async () => {
    const id = await makeProduct('G-3');
    await expect(app`insert into stock_balances (product_id, qty_milli) values (${id}, 100)`).rejects.toThrow(/permission denied/);
  });

  it('app login cannot delete or truncate business records', async () => {
    await expect(app`delete from audit_log`).rejects.toThrow(/permission denied/);
    await expect(app`truncate sales_invoices`).rejects.toThrow(/permission denied/);
  });
});

describe('voucher guards', () => {
  it('rejects an unbalanced voucher at commit', async () => {
    await expect(
      app.begin(async (tx) => {
        const [v] = await tx`insert into vouchers (vtype, vdate) values ('journal', '2026-10-19') returning id`;
        await tx`insert into voucher_lines (voucher_id, ledger_id, dr_paise) values (${v!.id}, 1, 100)`;
        await tx`insert into voucher_lines (voucher_id, ledger_id, cr_paise) values (${v!.id}, 2, 99)`;
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('accepts a balanced voucher', async () => {
    await app.begin(async (tx) => {
      const [v] = await tx`insert into vouchers (vtype, vdate) values ('journal', '2026-10-19') returning id`;
      await tx`insert into voucher_lines (voucher_id, ledger_id, dr_paise) values (${v!.id}, 1, 100)`;
      await tx`insert into voucher_lines (voucher_id, ledger_id, cr_paise) values (${v!.id}, 2, 100)`;
    });
  });
});

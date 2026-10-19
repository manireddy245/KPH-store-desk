import { istDate } from '@kph/core';
import type { Q } from '../db/connect.js';
import { can, type Ctx } from './common.js';
import { getSettings } from './settings.js';

export async function dashboard(q: Q, ctx: Ctx) {
  const today = istDate();
  const s = await getSettings(q);

  const [todayRow] = await q`
    select count(*) filter (where status = 'posted')::int as bills,
           coalesce(sum(total_paise) filter (where status = 'posted'), 0) as total_paise,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'cash'), 0) as cash_paise,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'upi'), 0) as upi_paise,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'card'), 0) as card_paise,
           coalesce(sum(total_paise) filter (where status = 'posted' and payment_mode = 'credit'), 0) as credit_paise,
           coalesce(sum(discount_paise) filter (where status = 'posted'), 0) as discount_paise,
           count(*) filter (where status = 'cancelled')::int as cancelled
    from sales_invoices where invoice_date = ${today}`;

  const [collections] = await q`
    select coalesce(sum(amount_paise), 0) as total_paise, count(*)::int as n
    from receipts where receipt_date = ${today} and status = 'posted'`;

  const [fy] = await q`
    select count(*)::int as bills, coalesce(sum(total_paise), 0) as total_paise
    from sales_invoices where status = 'posted'
      and invoice_date >= make_date(case when extract(month from ${today}::date) >= 4 then extract(year from ${today}::date)::int
                                         else extract(year from ${today}::date)::int - 1 end, 4, 1)`;

  const [stock] = await q`
    select count(*)::int as products,
           count(*) filter (where coalesce(sb.qty_milli, 0) <= 0)::int as out_of_stock,
           count(*) filter (where coalesce(sb.qty_milli, 0) > 0 and coalesce(sb.qty_milli, 0) <= coalesce(p.reorder_level_milli, ${s.lowStockThresholdMilli}))::int as low_stock,
           coalesce(sum(greatest(coalesce(sb.qty_milli, 0), 0) * coalesce(p.cost_price_paise, 0) / 1000), 0)::bigint as value_at_cost_paise
    from products p left join stock_balances sb on sb.product_id = p.id where p.active`;

  const lowItems = await q`
    select p.id, p.name, p.unit_code, coalesce(sb.qty_milli, 0) as qty_milli,
           coalesce(p.reorder_level_milli, ${s.lowStockThresholdMilli}) as reorder_milli
    from products p left join stock_balances sb on sb.product_id = p.id
    where p.active and coalesce(sb.qty_milli, 0) <= coalesce(p.reorder_level_milli, ${s.lowStockThresholdMilli})
    order by coalesce(sb.qty_milli, 0) <= 0 desc, coalesce(sb.qty_milli, 0) - coalesce(p.reorder_level_milli, ${s.lowStockThresholdMilli}), p.name
    limit 12`;

  const daily = await q`
    select d::date::text as date, coalesce(sum(si.total_paise), 0) as total_paise, count(si.id)::int as bills
    from generate_series(${today}::date - 29, ${today}::date, interval '1 day') d
    left join sales_invoices si on si.invoice_date = d::date and si.status = 'posted'
    group by d order by d`;

  const recent = await q`
    select si.id, si.number, si.at, si.customer_name, si.payment_mode, si.total_paise, si.status, u.name as user_name, d.name as device_name
    from sales_invoices si join users u on u.id = si.user_id left join devices d on d.id = si.device_id
    order by si.id desc limit 10`;

  const alerts = can(ctx, 'activity.view')
    ? await q`
        select a.id, a.at, a.action, a.details, a.reason, u.name as user_name, d.name as device_name, ap.name as approved_by_name
        from audit_log a left join users u on u.id = a.user_id left join devices d on d.id = a.device_id left join users ap on ap.id = a.approved_by
        where a.at >= (${today}::date)::timestamp at time zone 'Asia/Kolkata'
          and a.action in ('discount.over_limit', 'invoice.cancelled', 'override.approved', 'receipt.cancelled', 'stock.adjusted', 'product.price_changed', 'auth.locked_out')
        order by a.id desc limit 20`
    : [];

  const [lastBackup] = can(ctx, 'settings.manage')
    ? await q`select at, ok, kind, error from backups_log order by id desc limit 1`
    : [];

  const [stockMismatch] = await q`
    select count(*)::int as n from products p
    left join stock_balances sb on sb.product_id = p.id
    left join (select product_id, sum(qty_milli) as total from stock_movements group by product_id) m on m.product_id = p.id
    where coalesce(sb.qty_milli, 0) <> coalesce(m.total, 0)`;

  return {
    today: { date: today, ...todayRow, collections },
    fy,
    stock: can(ctx, 'products.view_cost') ? stock : { ...stock, value_at_cost_paise: undefined },
    lowItems,
    daily,
    recent,
    alerts,
    lastBackup: lastBackup ?? null,
    stockMismatchCount: stockMismatch?.n ?? 0,
  };
}

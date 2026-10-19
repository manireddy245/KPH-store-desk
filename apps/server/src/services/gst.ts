import type { Q, Sql } from '../db/connect.js';
import { AppError, audit, requirePerm, type Ctx } from './common.js';

/**
 * GST month lock. After a month's GSTR-1 is filed, its sales can no longer be
 * cancelled (GST rules: corrections after filing go through credit notes).
 */
export async function isMonthLocked(q: Q, date: string): Promise<boolean> {
  const [r] = await q`select 1 from gst_periods where month = ${date.slice(0, 7)} and filed_at is not null`;
  return !!r;
}

export async function assertMonthOpen(q: Q, date: string, message: string) {
  if (await isMonthLocked(q, date)) throw new AppError(409, 'MONTH_FILED', message);
}

export async function listPeriods(q: Q) {
  return q`
    with months as (
      select distinct to_char(invoice_date, 'YYYY-MM') as month from sales_invoices
      union select to_char(current_date, 'YYYY-MM')
      union select month from gst_periods
    )
    select m.month, g.filed_at, u.name as filed_by_name, g.note,
           (select count(*)::int from sales_invoices si where to_char(si.invoice_date, 'YYYY-MM') = m.month) as bills
    from months m left join gst_periods g on g.month = m.month left join users u on u.id = g.filed_by
    order by m.month desc limit 36`;
}

export async function setMonthFiled(sql: Sql, ctx: Ctx, month: string, filed: boolean, note?: string) {
  requirePerm(ctx, 'reports.view', 'Only admin can mark GST months as filed');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(400, 'BAD_MONTH', 'Month should look like 2026-10');
  await sql`
    insert into gst_periods (month, filed_at, filed_by, note) values (${month}, ${filed ? new Date() : null}, ${filed ? ctx.userId : null}, ${note ?? null})
    on conflict (month) do update set filed_at = excluded.filed_at, filed_by = excluded.filed_by, note = excluded.note`;
  await audit(sql, ctx, filed ? 'gst.month_filed' : 'gst.month_reopened', { entity: 'gst_period', entityId: month, details: { month }, reason: note ?? null });
}

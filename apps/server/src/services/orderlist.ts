import type { Q } from '../db/connect.js';
import { AppError, requirePerm, type Ctx } from './common.js';

/**
 * "To order" list: a notepad of things to buy. Tick "Ordered" and an item moves to the ordered list
 * (with who and when). No stock or money moves, so items can be deleted.
 */

export interface OrderListInput {
  productId?: number | null;
  itemText?: string;
  qtyMilli?: number | null;
  unitCode?: string | null;
  note?: string | null;
}

const PERM = 'Only admin or stock staff can change the order list';

export async function listOrderList(q: Q, ctx: Ctx) {
  requirePerm(ctx, 'stock.adjust', PERM);
  const rows = await q<
    { id: number; product_id: number | null; item_text: string; qty_milli: number | null; unit_code: string | null; note: string | null; status: 'to_order' | 'ordered'; created_at: Date; created_by_name: string | null; ordered_at: Date | null; ordered_by_name: string | null; stock_milli: number | null }[]
  >`
    select o.id, o.product_id, o.item_text, o.qty_milli, o.unit_code, o.note, o.status, o.created_at, cu.name as created_by_name,
           o.ordered_at, ou.name as ordered_by_name, sb.qty_milli as stock_milli
    from order_list o
    left join users cu on cu.id = o.created_by
    left join users ou on ou.id = o.ordered_by
    left join stock_balances sb on sb.product_id = o.product_id
    where o.status = 'to_order' or o.ordered_at > now() - interval '90 days'
    order by o.status desc, coalesce(o.ordered_at, o.created_at) desc`;
  return { toOrder: rows.filter((r) => r.status === 'to_order'), ordered: rows.filter((r) => r.status === 'ordered') };
}

export async function addToOrderList(q: Q, ctx: Ctx, input: OrderListInput) {
  requirePerm(ctx, 'stock.adjust', PERM);
  let text = input.itemText?.trim() ?? '';
  let unit = input.unitCode ?? null;
  if (input.productId) {
    const [p] = await q<{ name: string; unit_code: string }[]>`select name, unit_code from products where id = ${input.productId}`;
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found');
    text = p.name;
    unit = unit ?? p.unit_code;
  }
  if (text.length < 2) throw new AppError(400, 'BAD_ITEM', 'Choose a product or type what to order');
  if (input.qtyMilli != null && (!Number.isSafeInteger(input.qtyMilli) || input.qtyMilli <= 0)) throw new AppError(400, 'BAD_QTY', 'Quantity must be more than zero');
  const [r] = await q<{ id: number }[]>`
    insert into order_list (product_id, item_text, qty_milli, unit_code, note, created_by)
    values (${input.productId ?? null}, ${text}, ${input.qtyMilli ?? null}, ${unit}, ${input.note?.trim() || null}, ${ctx.userId})
    returning id`;
  return { id: r!.id };
}

/** Tick "Ordered" (or move it back to the to-order list). */
export async function markOrdered(q: Q, ctx: Ctx, id: number, ordered: boolean) {
  requirePerm(ctx, 'stock.adjust', PERM);
  const r = ordered
    ? await q`update order_list set status = 'ordered', ordered_by = ${ctx.userId}, ordered_at = now() where id = ${id} returning id`
    : await q`update order_list set status = 'to_order', ordered_by = null, ordered_at = null where id = ${id} returning id`;
  if (!r.length) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  return { ok: true };
}

export async function deleteOrderItem(q: Q, ctx: Ctx, id: number) {
  requirePerm(ctx, 'stock.adjust', PERM);
  const r = await q`delete from order_list where id = ${id} returning id`;
  if (!r.length) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  return { ok: true };
}

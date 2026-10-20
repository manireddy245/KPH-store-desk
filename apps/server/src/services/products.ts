import type { Q, Sql, Tx } from '../db/connect.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';
import { getSettings } from './settings.js';

export interface ProductInput {
  sku?: string;
  name?: string;
  categoryId?: number | null;
  brandId?: number | null;
  unitCode?: string;
  hsn?: string | null;
  gstRateBp?: number;
  salePricePaise?: number;
  costPriceCp?: number | null;
  mrpPaise?: number | null;
  reorderLevelMilli?: number | null;
  maxDiscType?: 'pct' | 'amt' | null;
  maxDiscValue?: number | null;
  active?: boolean;
  /** Only when creating: opening stock, posted as an "opening" stock movement. */
  openingQtyMilli?: number;
  /** true = sale price is typed including GST. */
  priceIncludesTax?: boolean;
  /** Pack contents for reports, e.g. 20 litres in a 20L bucket. */
  contentsMilli?: number | null;
  contentsUnit?: string | null;
  /** A service (loading charges, transport…): sold on bills, never counted as stock. */
  isService?: boolean;
  /** Other units this product is sold/bought in (replaces the whole list when given). */
  units?: UnitInput[];
}

export interface UnitInput {
  unitCode: string;
  /** 1 of this unit = factorNum / factorDen base units, e.g. 1 tonne = 94 rods. */
  factorNum: number;
  factorDen?: number;
  forSale?: boolean;
  forPurchase?: boolean;
  /** Own selling price for one of this unit (same incl/excl mode as the product). */
  pricePaise?: number | null;
}

const PRICE_FIELDS: (keyof ProductInput)[] = ['salePricePaise', 'maxDiscType', 'maxDiscValue', 'priceIncludesTax'];
const COST_FIELDS: (keyof ProductInput)[] = ['costPriceCp'];

const COLUMN: Record<string, string> = {
  sku: 'sku',
  name: 'name',
  categoryId: 'category_id',
  brandId: 'brand_id',
  unitCode: 'unit_code',
  hsn: 'hsn',
  gstRateBp: 'gst_rate_bp',
  salePricePaise: 'sale_price_paise',
  costPriceCp: 'cost_price_cp',
  mrpPaise: 'mrp_paise',
  reorderLevelMilli: 'reorder_level_milli',
  maxDiscType: 'max_disc_type',
  maxDiscValue: 'max_disc_value',
  active: 'active',
  priceIncludesTax: 'price_includes_tax',
  contentsMilli: 'contents_milli',
  contentsUnit: 'contents_unit',
  isService: 'is_service',
};

function checkFieldPermissions(ctx: Ctx, input: ProductInput, creating: boolean) {
  requirePerm(ctx, 'products.manage', 'Only admin can add or edit products');
  const touched = (fields: (keyof ProductInput)[]) => fields.some((f) => input[f] !== undefined && (!creating || input[f] !== null));
  if (touched(PRICE_FIELDS) && !can(ctx, 'products.edit_price')) throw new AppError(403, 'FORBIDDEN', 'Only admin can change prices or discount limits');
  if (touched(COST_FIELDS) && !can(ctx, 'products.view_cost')) throw new AppError(403, 'FORBIDDEN', 'Only admin can set cost price');
  if (input.units?.some((u) => u.pricePaise != null) && !can(ctx, 'products.edit_price')) throw new AppError(403, 'FORBIDDEN', 'Only admin can set unit prices');
}

/** Replace a product's extra units. */
async function saveUnits(tx: Tx, productId: number, baseUnit: string, units: UnitInput[]) {
  const seen = new Set<string>();
  for (const u of units) {
    if (u.unitCode === baseUnit) throw new AppError(400, 'BAD_UNIT', `${u.unitCode} is already the base unit`);
    if (seen.has(u.unitCode)) throw new AppError(400, 'BAD_UNIT', `${u.unitCode} is listed twice`);
    seen.add(u.unitCode);
    const den = u.factorDen ?? 1;
    if (!Number.isSafeInteger(u.factorNum) || u.factorNum <= 0 || !Number.isSafeInteger(den) || den <= 0)
      throw new AppError(400, 'BAD_UNIT', `How many ${baseUnit} are in one ${u.unitCode}? Enter a whole number`);
    if (u.pricePaise != null && (!Number.isSafeInteger(u.pricePaise) || u.pricePaise < 0)) throw new AppError(400, 'BAD_UNIT', 'Unit price is not valid');
  }
  await tx`delete from product_units where product_id = ${productId}`;
  if (units.length) {
    await tx`insert into product_units ${tx(
      units.map((u) => ({
        product_id: productId,
        unit_code: u.unitCode,
        factor_num: u.factorNum,
        factor_den: u.factorDen ?? 1,
        for_sale: u.forSale ?? true,
        for_purchase: u.forPurchase ?? true,
        price_paise: u.pricePaise ?? null,
      })),
    )}`;
  }
}

function validate(input: ProductInput) {
  if (input.name !== undefined && input.name.trim().length < 2) throw new AppError(400, 'BAD_NAME', 'Product name is too short');
  if (input.sku !== undefined && !input.sku.trim()) throw new AppError(400, 'BAD_SKU', 'SKU / item code is required');
  if (input.gstRateBp !== undefined && (input.gstRateBp < 0 || input.gstRateBp > 10000)) throw new AppError(400, 'BAD_GST', 'GST rate is not valid');
  if ((input.maxDiscType == null) !== (input.maxDiscValue == null) && input.maxDiscType !== undefined && input.maxDiscValue !== undefined)
    throw new AppError(400, 'BAD_DISCOUNT', 'Give both the type and the value of the max discount, or neither');
  if (input.maxDiscType === 'pct' && input.maxDiscValue != null && input.maxDiscValue > 10000) throw new AppError(400, 'BAD_DISCOUNT', 'Max discount cannot be over 100%');
  for (const k of ['salePricePaise', 'costPriceCp', 'mrpPaise', 'reorderLevelMilli', 'maxDiscValue', 'openingQtyMilli'] as const) {
    const v = input[k];
    if (v != null && (!Number.isSafeInteger(v) || v < 0)) throw new AppError(400, 'BAD_NUMBER', `${k} must be zero or more`);
  }
}

function friendlyDbError(e: unknown): never {
  const err = e as { code?: string; constraint_name?: string };
  if (err.code === '23505' && err.constraint_name === 'products_sku_uq') throw new AppError(409, 'DUPLICATE_SKU', 'Another product already has this SKU / item code');
  throw e;
}

export async function listProducts(
  q: Q,
  ctx: Ctx,
  f: { id?: number; search?: string; categoryId?: number; stock?: 'low' | 'out' | 'ok'; includeInactive?: boolean; limit?: number } = {},
) {
  const s = await getSettings(q);
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  const rows = await q`
    select * from (
      select p.id, p.sku, p.name, p.category_id, c.name as category_name, p.brand_id, b.name as brand_name, p.unit_code,
             p.hsn, p.gst_rate_bp, p.sale_price_paise, p.price_includes_tax, p.cost_price_cp, p.mrp_paise,
             p.reorder_level_milli, p.max_disc_type, p.max_disc_value, c.max_disc_type as cat_disc_type,
             c.max_disc_value as cat_disc_value, p.active, p.is_sample, p.updated_at, p.contents_milli, p.contents_unit, p.on_rate_board, p.track_batches,
             coalesce((select json_agg(json_build_object('unit_code', u.unit_code, 'factor_num', u.factor_num, 'factor_den', u.factor_den,
                        'for_sale', u.for_sale, 'for_purchase', u.for_purchase, 'price_paise', u.price_paise) order by u.factor_num::numeric / u.factor_den)
                       from product_units u where u.product_id = p.id), '[]'::json) as units,
             coalesce(sb.qty_milli, 0) as qty_milli,
             p.is_service,
             case when p.is_service then 'service'
                  when coalesce(sb.qty_milli, 0) <= 0 then 'out'
                  when coalesce(sb.qty_milli, 0) <= coalesce(p.reorder_level_milli, ${s.lowStockThresholdMilli}) then 'low'
                  else 'ok' end as stock_status
      from products p
      left join categories c on c.id = p.category_id
      left join brands b on b.id = p.brand_id
      left join stock_balances sb on sb.product_id = p.id
      where (${f.includeInactive ?? false} or p.active)
        and (${f.id ?? null}::int is null or p.id = ${f.id ?? null})
        and (${f.categoryId ?? null}::int is null or p.category_id = ${f.categoryId ?? null})
        and (${search}::text is null or lower(p.name) like ${search} or lower(p.sku) like ${search}
             or lower(coalesce(b.name, '')) like ${search} or lower(coalesce(c.name, '')) like ${search})
    ) x
    where (${f.stock ?? null}::text is null or stock_status = ${f.stock ?? null})
    order by lower(name)
    limit ${Math.min(f.limit ?? 2000, 5000)}`;
  if (!can(ctx, 'products.view_cost')) for (const r of rows) delete r.cost_price_cp;
  return rows;
}

export async function getProduct(q: Q, ctx: Ctx, id: number) {
  const [p] = await listProducts(q, ctx, { id, includeInactive: true });
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  return p;
}

export async function createProduct(sql: Sql, ctx: Ctx, input: ProductInput & { sku: string; name: string; unitCode: string }, opts: { isSample?: boolean; openingAt?: Date } = {}) {
  checkFieldPermissions(ctx, input, true);
  validate(input);
  try {
    return await sql.begin(async (tx) => {
      const [p] = await tx<{ id: number }[]>`
        insert into products (sku, name, category_id, brand_id, unit_code, hsn, gst_rate_bp, sale_price_paise, cost_price_cp,
                              mrp_paise, reorder_level_milli, max_disc_type, max_disc_value, is_sample, price_includes_tax,
                              contents_milli, contents_unit, is_service)
        values (${input.sku.trim()}, ${input.name.trim()}, ${input.categoryId ?? null}, ${input.brandId ?? null}, ${input.unitCode},
                ${input.hsn?.trim() || null}, ${input.gstRateBp ?? 1800}, ${input.salePricePaise ?? 0}, ${input.costPriceCp ?? null},
                ${input.mrpPaise ?? null}, ${input.reorderLevelMilli ?? null}, ${input.maxDiscType ?? null},
                ${input.maxDiscValue ?? null}, ${opts.isSample ?? false}, ${input.priceIncludesTax ?? false},
                ${input.contentsMilli ?? null}, ${input.contentsUnit ?? null}, ${input.isService ?? false})
        returning id`;
      const id = p!.id;
      if (input.units?.length) await saveUnits(tx, id, input.unitCode, input.units);
      if (input.openingQtyMilli && input.openingQtyMilli > 0 && !input.isService) {
        await tx`insert into stock_movements (product_id, qty_milli, kind, unit_cost_cp, reason, user_id, device_id, at)
                 values (${id}, ${input.openingQtyMilli}, 'opening', ${input.costPriceCp ?? null}, 'Opening stock', ${ctx.userId}, ${ctx.deviceId}, ${opts.openingAt ?? new Date()})`;
      }
      await audit(tx, ctx, 'product.created', { entity: 'product', entityId: id, details: { sku: input.sku, name: input.name, openingQtyMilli: input.openingQtyMilli ?? 0 } });
      return { id };
    });
  } catch (e) {
    friendlyDbError(e);
  }
}

export async function updateProduct(sql: Sql, ctx: Ctx, id: number, input: ProductInput) {
  if (input.openingQtyMilli !== undefined) throw new AppError(400, 'USE_ADJUSTMENT', 'Change quantity with a stock adjustment');
  checkFieldPermissions(ctx, input, false);
  validate(input);
  try {
    return await sql.begin(async (tx) => {
      const [old] = await tx<Record<string, unknown>[]>`select * from products where id = ${id} for update`;
      if (!old) throw new AppError(404, 'NOT_FOUND', 'Product not found');
      if (input.unitCode !== undefined && input.unitCode !== old.unit_code) {
        const [moved] = await tx`select 1 from stock_movements where product_id = ${id} limit 1`;
        if (moved) throw new AppError(400, 'UNIT_LOCKED', `Stock of this product is kept in ${old.unit_code}. Its base unit can't change once it has stock — add other units instead.`);
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(COLUMN)) {
        const v = (input as Record<string, unknown>)[k];
        if (v === undefined) continue;
        const nv = typeof v === 'string' ? v.trim() || (k === 'hsn' ? null : v.trim()) : v;
        if (nv === old[col]) continue;
        set[col] = nv;
        changes[k] = { from: old[col], to: nv };
      }
      if (input.units !== undefined) {
        await saveUnits(tx, id, (set.unit_code as string) ?? (old.unit_code as string), input.units);
        changes.units = { from: 'previous', to: input.units };
      }
      if (!Object.keys(changes).length) return { id, changed: false };
      if (Object.keys(set).length) await tx`update products set ${tx(set)}, updated_at = now() where id = ${id}`;
      for (const f of ['sale_price_paise', 'cost_price_cp', 'mrp_paise'] as const) {
        if (f in set) {
          await tx`insert into price_history (product_id, field, old_value, new_value, user_id, device_id)
                   values (${id}, ${f}, ${(old[f] as number | null) ?? null}, ${(set[f] as number | null) ?? null}, ${ctx.userId}, ${ctx.deviceId})`;
        }
      }
      const priceChanged = 'sale_price_paise' in set || 'max_disc_value' in set || 'max_disc_type' in set;
      await audit(tx, ctx, priceChanged ? 'product.price_changed' : 'product.updated', {
        entity: 'product',
        entityId: id,
        details: { name: old.name, changes: can(ctx, 'products.view_cost') ? changes : omit(changes, 'costPriceCp') },
      });
      return { id, changed: true };
    });
  } catch (e) {
    friendlyDbError(e);
  }
}

const omit = <T extends Record<string, unknown>>(o: T, k: string) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));

/** Delete only if the product was never used; otherwise mark it inactive. */
export async function deleteProduct(sql: Sql, ctx: Ctx, id: number) {
  requirePerm(ctx, 'products.manage');
  return sql.begin(async (tx) => {
    const [p] = await tx<{ name: string }[]>`select name from products where id = ${id} for update`;
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found');
    const [used] = await tx`
      select 1 from stock_movements where product_id = ${id}
      union all select 1 from sales_invoice_lines where product_id = ${id}
      union all select 1 from price_history where product_id = ${id}
      union all select 1 from purchase_lines where product_id = ${id} limit 1`;
    if (used) {
      await tx`update products set active = false, updated_at = now() where id = ${id}`;
      await audit(tx, ctx, 'product.deactivated', { entity: 'product', entityId: id, details: { name: p.name } });
      return { deleted: false, deactivated: true };
    }
    await tx`delete from products where id = ${id}`;
    await audit(tx, ctx, 'product.deleted', { entity: 'product', entityId: id, details: { name: p.name } });
    return { deleted: true, deactivated: false };
  });
}

// ------------------------------------------------------------------ stock

/**
 * Manual stock change. Staff give either the counted quantity (newQtyMilli) or a
 * change (deltaMilli); either way it is recorded as an "adjustment" with a reason.
 */
export async function adjustStock(sql: Sql, ctx: Ctx, productId: number, input: { newQtyMilli?: number; deltaMilli?: number; reason: string }) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can change stock');
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason for the stock change');
  return sql.begin(async (tx) => {
    const [p] = await tx<{ id: number; name: string; cost_price_cp: number | null }[]>`select id, name, cost_price_cp from products where id = ${productId}`;
    if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found');
    const current = await lockedQty(tx, productId);
    let delta: number;
    if (input.newQtyMilli != null) {
      if (!Number.isSafeInteger(input.newQtyMilli) || input.newQtyMilli < 0) throw new AppError(400, 'BAD_QTY', 'Quantity must be zero or more');
      delta = input.newQtyMilli - current;
    } else if (input.deltaMilli != null && Number.isSafeInteger(input.deltaMilli)) {
      delta = input.deltaMilli;
    } else throw new AppError(400, 'BAD_QTY', 'Enter the new quantity');
    if (delta === 0) return { productId, qtyMilli: current, changed: false };
    await tx`insert into stock_movements (product_id, qty_milli, kind, unit_cost_cp, reason, user_id, device_id)
             values (${productId}, ${delta}, 'adjustment', ${p.cost_price_cp}, ${reason}, ${ctx.userId}, ${ctx.deviceId})`;
    await audit(tx, ctx, 'stock.adjusted', {
      entity: 'product',
      entityId: productId,
      details: { name: p.name, fromMilli: current, toMilli: current + delta, deltaMilli: delta },
      reason,
    });
    return { productId, qtyMilli: current + delta, changed: true };
  });
}

/**
 * Stock changes for a product are serialised by locking its product row
 * (stock_balances is written only by the database trigger, so it can't be locked by the app).
 */
export async function lockProducts(tx: Tx, productIds: number[]) {
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  if (ids.length) await tx`select id from products where id in ${tx(ids)} order by id for no key update`;
}

async function lockedQty(tx: Tx, productId: number) {
  await lockProducts(tx, [productId]);
  const [b] = await tx<{ qty_milli: number }[]>`select qty_milli from stock_balances where product_id = ${productId}`;
  return b?.qty_milli ?? 0;
}

export async function stockCard(q: Q, ctx: Ctx, productId: number, limit = 300) {
  const rows = await q`
    select m.id, m.at, m.kind, m.qty_milli, m.reason, m.ref_type, m.ref_id, m.unit_cost_cp,
           u.name as user_name, d.name as device_name,
           case when m.ref_type = 'sales_invoice' then (select number from sales_invoices where id = m.ref_id) end as ref_number,
           sum(m.qty_milli) over (order by m.id) as running_milli
    from stock_movements m left join users u on u.id = m.user_id left join devices d on d.id = m.device_id
    where m.product_id = ${productId}
    order by m.id desc
    limit ${limit}`;
  if (!can(ctx, 'products.view_cost')) for (const r of rows) delete r.unit_cost_cp;
  return rows;
}

/** Nightly / on-demand check: stock_balances must equal the sum of the stock ledger. */
export async function reconcileStock(q: Q) {
  return q<{ product_id: number; name: string; balance_milli: number; ledger_milli: number }[]>`
    select p.id as product_id, p.name, coalesce(sb.qty_milli, 0) as balance_milli, coalesce(m.total, 0) as ledger_milli
    from products p
    left join stock_balances sb on sb.product_id = p.id
    left join (select product_id, sum(qty_milli) as total from stock_movements group by product_id) m on m.product_id = p.id
    where coalesce(sb.qty_milli, 0) <> coalesce(m.total, 0)`;
}

// ------------------------------------------------------------------ categories, brands, units

export async function listCategories(q: Q) {
  return q`select c.*, (select count(*)::int from products p where p.category_id = c.id and p.active) as product_count
           from categories c order by lower(c.name)`;
}

export async function saveCategory(
  sql: Sql,
  ctx: Ctx,
  id: number | null,
  input: { name?: string; maxDiscType?: 'pct' | 'amt' | null; maxDiscValue?: number | null; defaultGstBp?: number; active?: boolean },
) {
  requirePerm(ctx, 'products.manage');
  if (input.maxDiscType !== undefined || input.maxDiscValue !== undefined) requirePerm(ctx, 'products.edit_price', 'Only admin can change discount limits');
  if ((input.maxDiscType == null) !== (input.maxDiscValue == null)) throw new AppError(400, 'BAD_DISCOUNT', 'Give both the type and value of the max discount, or neither');
  const name = input.name?.trim();
  try {
    if (id == null) {
      if (!name) throw new AppError(400, 'BAD_NAME', 'Category name is required');
      const [c] = await sql<{ id: number }[]>`
        insert into categories (name, max_disc_type, max_disc_value, default_gst_bp)
        values (${name}, ${input.maxDiscType ?? null}, ${input.maxDiscValue ?? null}, ${input.defaultGstBp ?? 1800}) returning id`;
      await audit(sql, ctx, 'category.created', { entity: 'category', entityId: c!.id, details: { name, ...input } });
      return { id: c!.id };
    }
    const set: Record<string, unknown> = {};
    if (name) set.name = name;
    if (input.maxDiscType !== undefined) set.max_disc_type = input.maxDiscType;
    if (input.maxDiscValue !== undefined) set.max_disc_value = input.maxDiscValue;
    if (input.defaultGstBp !== undefined) set.default_gst_bp = input.defaultGstBp;
    if (input.active !== undefined) set.active = input.active;
    if (Object.keys(set).length) await sql`update categories set ${sql(set)} where id = ${id}`;
    await audit(sql, ctx, 'category.updated', { entity: 'category', entityId: id, details: input });
    return { id };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError(409, 'DUPLICATE', 'A category with this name already exists');
    throw e;
  }
}

export async function findOrCreateBrand(q: Q, name: string) {
  const clean = name.trim();
  const [b] = await q<{ id: number }[]>`
    insert into brands (name) values (${clean}) on conflict (lower(name)) do update set name = brands.name returning id`;
  return b!.id;
}

export async function findOrCreateCategory(q: Q, name: string, defaultGstBp = 1800) {
  const clean = name.trim();
  const [c] = await q<{ id: number }[]>`
    insert into categories (name, default_gst_bp) values (${clean}, ${defaultGstBp})
    on conflict (lower(name)) do update set name = categories.name returning id`;
  return c!.id;
}

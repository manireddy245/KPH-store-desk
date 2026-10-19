import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { isValidGstin, parsePercent, parseQty, parseRupees } from '@kph/core';
import type { Sql } from '../db/connect.js';
import { AppError, audit, requirePerm, type Ctx } from './common.js';
import { createPartyLedger } from './ledger.js';
import { findOrCreateBrand, findOrCreateCategory } from './products.js';

/**
 * One-time import of products, customers and suppliers from Excel or CSV.
 * Flow: upload → we guess which column is which → preview with a problem report → apply.
 * Rows with errors are skipped; rows with warnings are imported with the default shown.
 */

export type ImportKind = 'products' | 'customers' | 'suppliers';

export interface RawTable {
  headers: string[];
  rows: string[][];
}

export async function parseUpload(filename: string, data: Buffer): Promise<RawTable> {
  const lower = filename.toLowerCase();
  let grid: string[][];
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const parsed = Papa.parse<string[]>(data.toString('utf8').replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
    grid = parsed.data.map((r) => r.map((c) => String(c ?? '').trim()));
  } else if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
    if (!ws) throw new AppError(400, 'EMPTY_FILE', 'The Excel file has no data');
    grid = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c)));
      if (cells.some((x) => x)) grid.push(cells);
    });
  } else if (lower.endsWith('.xls')) {
    throw new AppError(400, 'OLD_EXCEL', 'Old .xls files are not supported. In Excel, use File → Save As → Excel Workbook (.xlsx).');
  } else {
    throw new AppError(400, 'BAD_FILE', 'Please upload an Excel (.xlsx) or CSV file');
  }
  if (grid.length < 2) throw new AppError(400, 'EMPTY_FILE', 'The file needs a header row and at least one data row');
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  return { headers: pad(grid[0]!), rows: grid.slice(1).map(pad) };
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v == null) return '';
  if (typeof v === 'object' && v !== null) {
    if ('result' in v) return String((v as { result: unknown }).result ?? '').trim();
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('').trim();
    if ('text' in v) return String((v as { text: unknown }).text).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

// ------------------------------------------------------------------ column mapping

export const FIELDS: Record<ImportKind, Record<string, { label: string; synonyms: string[]; required?: boolean }>> = {
  products: {
    name: { label: 'Product name', synonyms: ['name', 'item', 'item name', 'product', 'product name', 'description', 'particulars', 'stock item'], required: true },
    sku: { label: 'SKU / item code', synonyms: ['sku', 'code', 'item code', 'product code', 'itemcode', 'part no', 'alias'] },
    category: { label: 'Category', synonyms: ['category', 'group', 'stock group', 'item group', 'under'] },
    brand: { label: 'Brand', synonyms: ['brand', 'make', 'company', 'manufacturer'] },
    unit: { label: 'Unit', synonyms: ['unit', 'uom', 'units', 'unit of measure'] },
    hsn: { label: 'HSN code', synonyms: ['hsn', 'hsn code', 'hsn/sac', 'hsn sac', 'hsn_code', 'hsncode'] },
    gst: { label: 'GST %', synonyms: ['gst', 'gst %', 'gst%', 'gst rate', 'tax', 'tax %', 'tax rate', 'gst_rate', 'igst', 'igst %'] },
    price: { label: 'Selling price (excl. GST)', synonyms: ['price', 'sale price', 'selling price', 'rate', 'sales rate', 'sp', 'sale rate'] },
    cost: { label: 'Cost price (excl. GST)', synonyms: ['cost', 'cost price', 'purchase price', 'purchase rate', 'cp', 'buying price'] },
    mrp: { label: 'MRP', synonyms: ['mrp', 'm.r.p', 'm.r.p.'] },
    qty: { label: 'Opening stock qty', synonyms: ['qty', 'quantity', 'stock', 'opening qty', 'opening stock', 'closing stock', 'closing qty', 'balance', 'stock qty', 'on hand'] },
    reorder: { label: 'Reorder level', synonyms: ['reorder', 'reorder level', 'min qty', 'minimum', 'minimum stock', 'min stock'] },
    maxDiscount: { label: 'Max discount % (or ₹5)', synonyms: ['max discount', 'max disc', 'discount limit', 'max discount %', 'max disc %'] },
  },
  customers: {
    name: { label: 'Name', synonyms: ['name', 'customer', 'customer name', 'party', 'party name', 'ledger', 'ledger name'], required: true },
    phone: { label: 'Phone', synonyms: ['phone', 'mobile', 'contact', 'phone number', 'mobile no', 'mobile number', 'cell', 'phone no'] },
    gstin: { label: 'GSTIN', synonyms: ['gstin', 'gst no', 'gst number', 'gstin/uin', 'gst'] },
    address: { label: 'Address', synonyms: ['address', 'area', 'place', 'village', 'town', 'city'] },
    creditLimit: { label: 'Credit limit', synonyms: ['credit limit', 'limit', 'credit'] },
    opening: { label: 'Outstanding balance', synonyms: ['balance', 'outstanding', 'opening balance', 'due', 'dues', 'closing balance', 'amount due'] },
  },
  suppliers: {
    name: { label: 'Name', synonyms: ['name', 'supplier', 'supplier name', 'party', 'party name', 'vendor', 'company'], required: true },
    phone: { label: 'Phone', synonyms: ['phone', 'mobile', 'contact', 'phone number', 'mobile no'] },
    category: { label: 'Category', synonyms: ['category', 'type', 'supplies', 'products'] },
    gstin: { label: 'GSTIN', synonyms: ['gstin', 'gst no', 'gst number', 'gst'] },
    address: { label: 'Address', synonyms: ['address', 'city', 'place'] },
    leadTime: { label: 'Lead time (days)', synonyms: ['lead time', 'lead time days', 'delivery days'] },
    opening: { label: 'Amount we owe', synonyms: ['balance', 'outstanding', 'opening balance', 'payable', 'due'] },
  },
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%/]+/g, ' ').trim();

/** Guess which file column holds each field. Returns field → column index. */
export function guessMapping(kind: ImportKind, headers: string[]): Record<string, number | null> {
  const mapping: Record<string, number | null> = {};
  const used = new Set<number>();
  for (const [field, def] of Object.entries(FIELDS[kind])) {
    const idx = headers.findIndex((h, i) => !used.has(i) && def.synonyms.includes(norm(h)));
    mapping[field] = idx >= 0 ? idx : null;
    if (idx >= 0) used.add(idx);
  }
  return mapping;
}

const UNIT_SYNONYMS: Record<string, string> = {
  no: 'nos', nos: 'nos', 'no.': 'nos', number: 'nos', numbers: 'nos',
  pc: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs',
  bag: 'bag', bags: 'bag',
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg',
  ton: 'tonne', tons: 'tonne', tonne: 'tonne', tonnes: 'tonne', mt: 'tonne',
  l: 'ltr', ltr: 'ltr', ltrs: 'ltr', litre: 'ltr', litres: 'ltr', liter: 'ltr', liters: 'ltr', lt: 'ltr',
  m: 'mtr', mtr: 'mtr', mtrs: 'mtr', meter: 'mtr', meters: 'mtr', metre: 'mtr', metres: 'mtr',
  ft: 'ft', feet: 'ft', foot: 'ft',
  coil: 'coil', coils: 'coil', box: 'box', boxes: 'box', set: 'set', sets: 'set',
  rod: 'rod', rods: 'rod', bundle: 'bundle', bundles: 'bundle', pkt: 'pkt', packet: 'pkt', packets: 'pkt',
  sqft: 'sqft', 'sq ft': 'sqft', bucket: 'bucket', buckets: 'bucket', tin: 'tin', tins: 'tin', length: 'length', lengths: 'length',
};

export interface PreviewRow {
  rowNo: number;
  values: Record<string, unknown>;
  errors: string[];
  warnings: string[];
  action: 'create' | 'update' | 'skip';
}

export async function analyse(
  sql: Sql,
  kind: ImportKind,
  table: RawTable,
  mapping: Record<string, number | null>,
  opts: { updateExisting?: boolean } = {},
): Promise<{ rows: PreviewRow[]; summary: Record<string, number>; newUnits: string[] }> {
  const get = (r: string[], f: string) => {
    const i = mapping[f];
    return i == null ? '' : (r[i] ?? '').trim();
  };
  const required = Object.entries(FIELDS[kind]).filter(([, d]) => d.required).map(([f]) => f);
  for (const f of required) if (mapping[f] == null) throw new AppError(400, 'MAPPING_MISSING', `Choose which column has the ${FIELDS[kind][f]!.label}`);

  const units = new Set((await sql<{ code: string }[]>`select code from units`).map((u) => u.code));
  const existingSkus = new Map(
    kind === 'products' ? (await sql<{ sku: string; id: number }[]>`select lower(sku) as sku, id from products`).map((p) => [p.sku, p.id]) : [],
  );
  const existingPhones = new Set(
    kind === 'customers' ? (await sql<{ phone: string }[]>`select phone from customers where phone is not null`).map((c) => c.phone) : [],
  );
  const seenSku = new Map<string, number>();
  const seenPhone = new Map<string, number>();
  const newUnits = new Set<string>();
  let autoSku = 1;

  const rows: PreviewRow[] = table.rows.map((r, i) => {
    const rowNo = i + 2; // spreadsheet row number (header is row 1)
    const errors: string[] = [];
    const warnings: string[] = [];
    const v: Record<string, unknown> = {};
    let action: PreviewRow['action'] = 'create';
    const name = get(r, 'name');
    if (!name) errors.push('Name is missing');
    v.name = name;

    const money = (f: string, label: string, opt: { warnIfMissing?: string } = {}) => {
      const raw = get(r, f);
      if (!raw) {
        if (opt.warnIfMissing) warnings.push(opt.warnIfMissing);
        return null;
      }
      const p = parseRupees(raw);
      if (p == null || p < 0) {
        errors.push(`${label} "${raw}" is not a valid amount`);
        return null;
      }
      return p;
    };

    if (kind === 'products') {
      let sku = get(r, 'sku');
      if (!sku) {
        sku = `IMP-${String(autoSku++).padStart(5, '0')}`;
        warnings.push(`No SKU — will use ${sku}`);
      }
      v.sku = sku;
      const key = sku.toLowerCase();
      if (seenSku.has(key)) errors.push(`Same SKU as row ${seenSku.get(key)}`);
      else seenSku.set(key, rowNo);
      if (existingSkus.has(key)) {
        action = opts.updateExisting ? 'update' : 'skip';
        warnings.push(opts.updateExisting ? 'SKU already exists — details will be updated (stock not changed)' : 'SKU already exists — row will be skipped');
      }

      const unitRaw = get(r, 'unit').toLowerCase();
      if (!unitRaw) {
        warnings.push('Unit missing — will use "pcs"');
        v.unit = 'pcs';
      } else {
        const u = UNIT_SYNONYMS[unitRaw] ?? unitRaw.replace(/[^a-z0-9]/g, '');
        if (!units.has(u)) {
          newUnits.add(u);
          warnings.push(`New unit "${u}" will be created`);
        }
        v.unit = u;
      }

      const hsn = get(r, 'hsn').replace(/\s/g, '');
      if (!hsn) warnings.push('HSN code missing');
      else if (!/^\d{4,8}$/.test(hsn)) warnings.push(`HSN "${hsn}" should be 4–8 digits`);
      v.hsn = hsn || null;

      const gstRaw = get(r, 'gst');
      if (!gstRaw) {
        warnings.push('GST rate missing — will use 18%');
        v.gstRateBp = 1800;
      } else {
        const bp = parsePercent(gstRaw.replace(/%/g, ''));
        if (bp == null || bp > 10000) errors.push(`GST "${gstRaw}" is not a valid rate`);
        else {
          if (![0, 25, 100, 300, 500, 1200, 1800, 2800, 4000].includes(bp)) warnings.push(`GST ${gstRaw}% is unusual — please check`);
          v.gstRateBp = bp;
        }
      }
      v.salePricePaise = money('price', 'Selling price', { warnIfMissing: 'Selling price missing — will be ₹0' }) ?? 0;
      if (v.salePricePaise === 0 && get(r, 'price')) warnings.push('Selling price is ₹0');
      v.costPricePaise = money('cost', 'Cost price');
      v.mrpPaise = money('mrp', 'MRP');
      if (v.costPricePaise != null && (v.salePricePaise as number) > 0 && (v.costPricePaise as number) > (v.salePricePaise as number))
        warnings.push('Cost price is higher than selling price');

      const qtyRaw = get(r, 'qty');
      if (qtyRaw) {
        const q = parseQty(qtyRaw);
        if (q == null) errors.push(`Quantity "${qtyRaw}" is not valid (negative or more than 3 decimals?)`);
        else v.openingQtyMilli = q;
      }
      const reorderRaw = get(r, 'reorder');
      if (reorderRaw) {
        const q = parseQty(reorderRaw);
        if (q == null) warnings.push(`Reorder level "${reorderRaw}" ignored`);
        else v.reorderLevelMilli = q;
      }
      const discRaw = get(r, 'maxDiscount');
      if (discRaw) {
        if (/₹|rs/i.test(discRaw)) {
          const p = parseRupees(discRaw.replace(/rs\.?/i, ''));
          if (p == null) warnings.push(`Max discount "${discRaw}" ignored`);
          else Object.assign(v, { maxDiscType: 'amt', maxDiscValue: p });
        } else {
          const bp = parsePercent(discRaw);
          if (bp == null || bp > 10000) warnings.push(`Max discount "${discRaw}" ignored`);
          else Object.assign(v, { maxDiscType: 'pct', maxDiscValue: bp });
        }
      }
      v.category = get(r, 'category') || null;
      v.brand = get(r, 'brand') || null;
      if (!v.category) warnings.push('No category');
    } else {
      const phone = get(r, 'phone').replace(/[^\d+]/g, '');
      if (phone && phone.length < 7) warnings.push(`Phone "${get(r, 'phone')}" looks too short — ignored`);
      v.phone = phone.length >= 7 ? phone : null;
      if (kind === 'customers' && v.phone) {
        const p = v.phone as string;
        if (seenPhone.has(p)) warnings.push(`Same phone as row ${seenPhone.get(p)}`);
        else seenPhone.set(p, rowNo);
        if (existingPhones.has(p)) {
          action = 'skip';
          warnings.push('A customer with this phone already exists — row will be skipped');
        }
      }
      const gstin = get(r, 'gstin').toUpperCase().replace(/\s/g, '');
      if (gstin && !isValidGstin(gstin)) warnings.push(`GSTIN "${gstin}" is not valid (check digit) — ignored`);
      else v.gstin = gstin || null;
      v.address = get(r, 'address') || null;
      if (kind === 'customers') {
        v.creditLimitPaise = money('creditLimit', 'Credit limit');
        const raw = get(r, 'opening');
        if (raw) {
          const neg = /cr$/i.test(raw) || raw.startsWith('-');
          const p = parseRupees(raw.replace(/\s*(dr|cr)$/i, '').replace(/^-/, ''));
          if (p == null) errors.push(`Balance "${raw}" is not a valid amount`);
          else v.openingBalancePaise = neg ? -p : p;
        }
      } else {
        v.category = get(r, 'category') || null;
        const lt = get(r, 'leadTime');
        v.leadTimeDays = lt && /^\d+$/.test(lt) ? Number(lt) : null;
        const raw = get(r, 'opening');
        if (raw) {
          const p = parseRupees(raw.replace(/\s*(dr|cr)$/i, ''));
          if (p == null) errors.push(`Balance "${raw}" is not a valid amount`);
          else v.openingBalancePaise = p;
        }
      }
    }
    if (errors.length) action = 'skip';
    return { rowNo, values: v, errors, warnings, action };
  });

  const summary = {
    total: rows.length,
    create: rows.filter((r) => r.action === 'create').length,
    update: rows.filter((r) => r.action === 'update').length,
    skip: rows.filter((r) => r.action === 'skip').length,
    errors: rows.filter((r) => r.errors.length).length,
    warnings: rows.filter((r) => r.warnings.length).length,
  };
  return { rows, summary, newUnits: [...newUnits] };
}

export async function applyImport(
  sql: Sql,
  ctx: Ctx,
  kind: ImportKind,
  table: RawTable,
  mapping: Record<string, number | null>,
  opts: { updateExisting?: boolean; isSample?: boolean } = {},
) {
  requirePerm(ctx, 'settings.manage', 'Only admin can import data');
  const { rows, summary, newUnits } = await analyse(sql, kind, table, mapping, opts);
  await sql.begin(async (tx) => {
    for (const u of newUnits) await tx`insert into units (code, name) values (${u}, ${u}) on conflict do nothing`;
    const catIds = new Map<string, number>();
    const brandIds = new Map<string, number>();
    for (const row of rows) {
      if (row.action === 'skip') continue;
      const v = row.values as Record<string, any>;
      if (kind === 'products') {
        let categoryId: number | null = null;
        if (v.category) {
          const k = v.category.toLowerCase();
          if (!catIds.has(k)) catIds.set(k, await findOrCreateCategory(tx, v.category, v.gstRateBp));
          categoryId = catIds.get(k)!;
        }
        let brandId: number | null = null;
        if (v.brand) {
          const k = v.brand.toLowerCase();
          if (!brandIds.has(k)) brandIds.set(k, await findOrCreateBrand(tx, v.brand));
          brandId = brandIds.get(k)!;
        }
        if (row.action === 'update') {
          await tx`
            update products set name = ${v.name}, category_id = coalesce(${categoryId}, category_id), brand_id = coalesce(${brandId}, brand_id),
              unit_code = ${v.unit}, hsn = coalesce(${v.hsn}, hsn), gst_rate_bp = ${v.gstRateBp}, sale_price_paise = ${v.salePricePaise},
              cost_price_paise = coalesce(${v.costPricePaise}, cost_price_paise), mrp_paise = coalesce(${v.mrpPaise}, mrp_paise),
              reorder_level_milli = coalesce(${v.reorderLevelMilli ?? null}, reorder_level_milli), updated_at = now()
            where lower(sku) = ${v.sku.toLowerCase()}`;
          continue;
        }
        const [p] = await tx<{ id: number }[]>`
          insert into products (sku, name, category_id, brand_id, unit_code, hsn, gst_rate_bp, sale_price_paise, cost_price_paise,
                                mrp_paise, reorder_level_milli, max_disc_type, max_disc_value, is_sample)
          values (${v.sku}, ${v.name}, ${categoryId}, ${brandId}, ${v.unit}, ${v.hsn}, ${v.gstRateBp}, ${v.salePricePaise},
                  ${v.costPricePaise}, ${v.mrpPaise}, ${v.reorderLevelMilli ?? null}, ${v.maxDiscType ?? null}, ${v.maxDiscValue ?? null},
                  ${opts.isSample ?? false})
          returning id`;
        if (v.openingQtyMilli > 0) {
          await tx`insert into stock_movements (product_id, qty_milli, kind, unit_cost_paise, reason, user_id, device_id)
                   values (${p!.id}, ${v.openingQtyMilli}, 'opening', ${v.costPricePaise}, 'Opening stock (import)', ${ctx.userId}, ${ctx.deviceId})`;
        }
      } else if (kind === 'customers') {
        const [c] = await tx<{ id: number }[]>`
          insert into customers (name, phone, gstin, address, credit_limit_paise, is_sample)
          values (${v.name}, ${v.phone}, ${v.gstin ?? null}, ${v.address}, ${v.creditLimitPaise ?? null}, ${opts.isSample ?? false}) returning id`;
        const ledgerId = await createPartyLedger(tx, 'customer', c!.id, v.name, v.openingBalancePaise ?? 0);
        await tx`update customers set ledger_id = ${ledgerId} where id = ${c!.id}`;
      } else {
        const [s] = await tx<{ id: number }[]>`
          insert into suppliers (name, phone, category, gstin, address, lead_time_days, is_sample)
          values (${v.name}, ${v.phone}, ${v.category}, ${v.gstin ?? null}, ${v.address}, ${v.leadTimeDays}, ${opts.isSample ?? false}) returning id`;
        const ledgerId = await createPartyLedger(tx, 'supplier', s!.id, v.name, -(v.openingBalancePaise ?? 0));
        await tx`update suppliers set ledger_id = ${ledgerId} where id = ${s!.id}`;
      }
    }
    await audit(tx, ctx, 'import.applied', { entity: kind, details: { ...summary, newUnits } });
  });
  return { summary, newUnits };
}

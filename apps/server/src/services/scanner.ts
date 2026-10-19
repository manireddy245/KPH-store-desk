import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from '../db/connect.js';
import { AppError, audit, requirePerm, type Ctx } from './common.js';
import { matchProduct, matchSupplier, normalizeText, type MatchKind } from './matching.js';
import { getSettings } from './settings.js';

/**
 * Invoice scanner: photos (phone camera) or a PDF/image file (PC) of a supplier's
 * bill go to Google Gemini, which reads them into structured data. Nothing is
 * saved to stock here — the result is a draft for a person to check on the
 * review screen, then save as a purchase.
 */

export interface ScanPage {
  mimeType: string;
  base64: string;
}

/** What we ask the model to return. Amounts in rupees, as printed. */
export interface ReadBill {
  supplier: { name: string | null; gstin: string | null; phone: string | null; address: string | null };
  invoice: { number: string | null; date: string | null; is_interstate: boolean | null };
  lines: {
    description: string;
    item_code: string | null;
    hsn: string | null;
    quantity: number;
    unit: string | null;
    rate: number | null;
    discount_percent: number | null;
    taxable_value: number | null;
    gst_percent: number | null;
    line_total: number | null;
  }[];
  freight: number | null;
  round_off: number | null;
  grand_total: number | null;
  notes: string | null;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    supplier: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING', nullable: true }, gstin: { type: 'STRING', nullable: true }, phone: { type: 'STRING', nullable: true }, address: { type: 'STRING', nullable: true } },
    },
    invoice: {
      type: 'OBJECT',
      properties: { number: { type: 'STRING', nullable: true }, date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD' }, is_interstate: { type: 'BOOLEAN', nullable: true } },
    },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          item_code: { type: 'STRING', nullable: true },
          hsn: { type: 'STRING', nullable: true },
          quantity: { type: 'NUMBER' },
          unit: { type: 'STRING', nullable: true },
          rate: { type: 'NUMBER', nullable: true },
          discount_percent: { type: 'NUMBER', nullable: true },
          taxable_value: { type: 'NUMBER', nullable: true },
          gst_percent: { type: 'NUMBER', nullable: true },
          line_total: { type: 'NUMBER', nullable: true },
        },
        required: ['description', 'quantity'],
      },
    },
    freight: { type: 'NUMBER', nullable: true },
    round_off: { type: 'NUMBER', nullable: true },
    grand_total: { type: 'NUMBER', nullable: true },
    notes: { type: 'STRING', nullable: true },
  },
  required: ['supplier', 'invoice', 'lines'],
};

const PROMPT = `You are reading a GST tax invoice from a supplier to "Kanakapatnam Paints and Hardwares" (Kavali, Andhra Pradesh) — a paint, cement, steel, pipes, sanitary, electrical and hardware shop. The images are pages of ONE invoice, in order.

Return every item line exactly as printed. For each line:
- description: the item name as printed (include size/pack, e.g. "PPC 50 KG", "Emulsion 20 Ltr")
- item_code: the supplier's item/part code if a separate column shows one, else null
- hsn: HSN/SAC code
- quantity and unit (bags, kg, ltr, nos, mtr, coils, ton...). If both "Qty" and "Alt qty" are printed, use the billed quantity.
- rate: rate per unit BEFORE GST
- discount_percent: trade/cash discount % on the line, if any
- taxable_value: the line amount BEFORE GST and AFTER discount
- gst_percent: total GST rate for the line (CGST% + SGST%, or IGST%)
- line_total: line amount including GST if printed, else null
Also: supplier name, supplier GSTIN, invoice number, invoice date as YYYY-MM-DD (Indian dates are day-month-year), whether the supply is inter-state (IGST charged), freight/transport/loading charges, round off, and the grand total.
Use plain numbers without commas or currency symbols. Do not invent values: use null when something is not printed or unreadable. Put anything unclear (smudged figures, handwritten changes) in notes.`;

export type ModelCaller = (args: { apiKey: string; model: string; pages: ScanPage[] }) => Promise<ReadBill>;

/** POST a generateContent request to Google Gemini and return the answer text. Errors become plain messages. */
export async function postGemini(apiKey: string, model: string, body: unknown, timeoutMs = 120_000): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    throw new AppError(503, 'SCANNER_OFFLINE', timeout ? 'Google Gemini took too long to answer. Try again.' : "Can't reach Google Gemini. Check the internet connection.");
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {
      /* keep text */
    }
    if (res.status === 400 && /api key/i.test(msg)) throw new AppError(400, 'SCANNER_KEY', 'The Gemini API key is not valid. Check it in Settings → Shop & billing.');
    if (res.status === 403) throw new AppError(400, 'SCANNER_KEY', 'The Gemini API key was refused. Check it in Settings → Shop & billing.');
    if (res.status === 404) throw new AppError(400, 'SCANNER_MODEL', `The Gemini model "${model}" is not available. Change it in Settings → Shop & billing.`);
    if (res.status === 429) throw new AppError(429, 'SCANNER_BUSY', 'Google Gemini is busy or the free limit is used up. Try again in a minute.');
    throw new AppError(502, 'SCANNER_ERROR', `Google Gemini could not handle this (${res.status}): ${msg.slice(0, 200)}`);
  }
  let data: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new AppError(502, 'SCANNER_ERROR', 'Google Gemini gave an unreadable answer. Try again.');
  }
  return data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
}

/** Real call to the Gemini API. Tests swap this out. */
export const callGemini: ModelCaller = async ({ apiKey, model, pages }) => {
  const out = await postGemini(apiKey, model, {
    contents: [{ role: 'user', parts: [{ text: PROMPT }, ...pages.map((p) => ({ inline_data: { mime_type: p.mimeType, data: p.base64 } }))] }],
    generationConfig: { temperature: 0, response_mime_type: 'application/json', response_schema: SCHEMA },
  });
  return parseReadBill(out);
};

export function parseReadBill(out: string): ReadBill {
  let parsed: ReadBill;
  try {
    parsed = JSON.parse(out.replace(/^```(json)?\s*|\s*```$/g, ''));
  } catch {
    throw new AppError(502, 'SCANNER_ERROR', 'The scanner could not make sense of this bill. Take a clearer photo, or enter it by hand.');
  }
  if (!parsed || !Array.isArray(parsed.lines)) throw new AppError(502, 'SCANNER_ERROR', 'No items were found on this bill. Take a clearer photo, or enter it by hand.');
  return parsed;
}

const MAX_PAGES = 6;
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

const toPaise = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null);
const toMilli = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null);
const toBp = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null);

export interface ScanDraftLine {
  description: string;
  itemCode: string | null;
  hsn: string | null;
  qtyMilli: number | null;
  billUnit: string | null;
  ratePaise: number | null;
  discountBp: number | null;
  taxablePaise: number | null;
  gstRateBp: number | null;
  lineTotalPaise: number | null;
  match: { kind: MatchKind; productId: number | null; score: number; alternatives: { productId: number; score: number }[] };
  lastCostPaise: number | null;
  warnings: string[];
}

export async function scanBill(
  sql: Sql,
  ctx: Ctx,
  opts: { pages: ScanPage[]; scanDir: string; supplierId?: number | null; caller?: ModelCaller },
) {
  requirePerm(ctx, 'stock.adjust', 'Only admin or stock staff can scan purchase bills');
  if (!opts.pages.length) throw new AppError(400, 'NO_PAGES', 'Add a photo or file of the bill');
  if (opts.pages.length > MAX_PAGES) throw new AppError(400, 'TOO_MANY_PAGES', `At most ${MAX_PAGES} pages per bill`);
  const buffers = opts.pages.map((p) => {
    if (!ALLOWED.includes(p.mimeType)) throw new AppError(400, 'BAD_FILE', 'Use a photo (JPG/PNG) or a PDF of the bill');
    const b = Buffer.from(p.base64, 'base64');
    if (b.length > MAX_BYTES) throw new AppError(400, 'FILE_TOO_BIG', 'A page is larger than 12 MB. Take the photo again at a lower size.');
    return b;
  });
  const settings = await getSettings(sql);
  if (!settings.geminiApiKey) throw new AppError(400, 'SCANNER_KEY', 'The scanner needs a Gemini API key. Admin can add it in Settings → Shop & billing.');

  // Keep the pages on disk so the purchase can always be checked against the original.
  const hashes = buffers.map((b) => createHash('sha256').update(b).digest('hex'));
  const [scan] = await sql<{ id: number }[]>`
    insert into purchase_scans (user_id, device_id, model, page_hashes) values (${ctx.userId}, ${ctx.deviceId}, ${settings.geminiModel}, ${hashes}) returning id`;
  const scanId = scan!.id;
  const month = new Date().toISOString().slice(0, 7);
  const dir = join(opts.scanDir, month);
  mkdirSync(dir, { recursive: true });
  const files = buffers.map((b, i) => {
    const ext = opts.pages[i]!.mimeType === 'application/pdf' ? 'pdf' : opts.pages[i]!.mimeType.split('/')[1]!.replace('jpeg', 'jpg');
    const rel = `${month}/scan-${scanId}-p${i + 1}.${ext}`;
    writeFileSync(join(opts.scanDir, rel), b);
    return rel;
  });

  // Same photo already used for a saved purchase?
  const [seen] = await sql<{ number: string }[]>`
    select p.number from purchase_scans s join purchase_invoices p on p.id = s.purchase_id
    where s.page_hashes && ${hashes} and s.id <> ${scanId} and p.status = 'posted' limit 1`;

  let read: ReadBill;
  try {
    read = await (opts.caller ?? callGemini)({ apiKey: settings.geminiApiKey, model: settings.geminiModel, pages: opts.pages });
  } catch (e) {
    await sql`update purchase_scans set status = 'failed', error = ${(e as Error).message}, page_files = ${files} where id = ${scanId}`;
    throw e;
  }
  await sql`update purchase_scans set raw = ${sql.json(read as never)}, page_files = ${files} where id = ${scanId}`;

  // Supplier
  const suppliers = await sql<{ id: number; name: string; gstin: string | null }[]>`select id, name, gstin from suppliers where active`;
  const sup = opts.supplierId ? { supplierId: opts.supplierId, by: 'chosen' as const } : matchSupplier(read.supplier ?? {}, suppliers);

  // Products
  const products = await sql<{ id: number; sku: string; name: string; brand_name: string | null; cost_price_paise: number | null; unit_code: string }[]>`
    select p.id, p.sku, p.name, b.name as brand_name, p.cost_price_paise, p.unit_code from products p left join brands b on b.id = p.brand_id where p.active`;
  const aliasRows = await sql<{ alias: string; product_id: number; supplier_id: number | null }[]>`
    select alias, product_id, supplier_id from product_aliases where supplier_id is null or supplier_id = ${sup.supplierId ?? -1}
    order by supplier_id nulls first`;
  const aliases = new Map(aliasRows.map((a) => [a.alias, a.product_id]));
  const costs = new Map(products.map((p) => [p.id, p.cost_price_paise]));

  const lines: ScanDraftLine[] = read.lines.map((l) => {
    const qtyMilli = toMilli(l.quantity);
    const ratePaise = toPaise(l.rate);
    const discountBp = toBp(l.discount_percent);
    let taxablePaise = toPaise(l.taxable_value);
    const gstRateBp = toBp(l.gst_percent);
    const warnings: string[] = [];
    if (taxablePaise == null && ratePaise != null && qtyMilli != null) {
      taxablePaise = Math.round((ratePaise * qtyMilli) / 1000 - (discountBp ? (ratePaise * qtyMilli * discountBp) / 1000 / 10000 : 0));
      warnings.push('Line amount worked out from rate × quantity');
    }
    if (ratePaise != null && qtyMilli != null && taxablePaise != null) {
      const expected = (ratePaise * qtyMilli) / 1000 * (1 - (discountBp ?? 0) / 10000);
      if (Math.abs(expected - taxablePaise) > Math.max(100, expected * 0.01)) warnings.push('Rate × quantity does not match the line amount — check this line');
    }
    if (qtyMilli == null) warnings.push('Quantity not readable');
    if (gstRateBp == null) warnings.push('GST % not readable');
    const match = matchProduct({ description: l.description, itemCode: l.item_code }, products, aliases);
    const lastCost = match.productId ? (costs.get(match.productId) ?? null) : null;
    if (lastCost != null && qtyMilli && taxablePaise != null) {
      const unitCost = (taxablePaise * 1000) / qtyMilli;
      if (lastCost > 0 && Math.abs(unitCost - lastCost) / lastCost > 0.25) warnings.push(`Cost is very different from last time (₹${(lastCost / 100).toFixed(2)}) — check the unit and quantity`);
    }
    return {
      description: l.description,
      itemCode: l.item_code ?? null,
      hsn: l.hsn?.replace(/\s/g, '') || null,
      qtyMilli,
      billUnit: l.unit ?? null,
      ratePaise,
      discountBp,
      taxablePaise,
      gstRateBp,
      lineTotalPaise: toPaise(l.line_total),
      match,
      lastCostPaise: lastCost,
      warnings,
    };
  });

  let date = read.invoice?.date ?? null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = null;

  let duplicateOf: string | null = seen?.number ?? null;
  if (!duplicateOf && sup.supplierId && read.invoice?.number) {
    const [d] = await sql<{ number: string }[]>`
      select number from purchase_invoices where supplier_id = ${sup.supplierId} and lower(supplier_invoice_no) = ${read.invoice.number.trim().toLowerCase()} and status = 'posted'`;
    duplicateOf = d?.number ?? null;
  }

  await audit(sql, ctx, 'purchase.scanned', { entity: 'purchase_scan', entityId: scanId, details: { pages: files.length, lines: lines.length, supplier: read.supplier?.name ?? null, billNo: read.invoice?.number ?? null } });

  return {
    scanId,
    pageCount: files.length,
    supplier: { ...read.supplier, matchedId: sup.supplierId, matchedBy: sup.by },
    invoice: { number: read.invoice?.number ?? null, date, isInterstate: read.invoice?.is_interstate ?? null },
    lines,
    freightPaise: toPaise(read.freight),
    roundOffPaise: toPaise(read.round_off),
    grandTotalPaise: toPaise(read.grand_total),
    notes: read.notes ?? null,
    duplicateOf,
  };
}

export function readScanPage(scanDir: string, rel: string) {
  if (!/^\d{4}-\d{2}\/scan-\d+-p\d+\.(jpg|png|webp|heic|heif|pdf)$/.test(rel)) throw new AppError(400, 'BAD_PATH', 'Not a scan file');
  return readFileSync(join(scanDir, rel));
}

export { normalizeText };

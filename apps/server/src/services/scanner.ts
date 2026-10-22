import { createHash } from 'node:crypto';
import { formatCost } from '@kph/core';
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
  invoice: { number: string | null; date: string | null; is_interstate: boolean | null; billed_to_us?: boolean | null; billed_to_name?: string | null };
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
      properties: {
        number: { type: 'STRING', nullable: true },
        date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD' },
        is_interstate: { type: 'BOOLEAN', nullable: true },
        billed_to_us: { type: 'BOOLEAN', nullable: true },
        billed_to_name: { type: 'STRING', nullable: true },
      },
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

const PROMPT = `You are reading a GST tax invoice for goods bought by "Kanakapatnam Paints and Hardwares" (Kavali, Andhra Pradesh, GSTIN 37DZMPM4249D1Z3) — a paint, cement, steel, pipes, sanitary, electrical and hardware shop. The images are pages of ONE invoice, in order. A photo may be sideways or upside down: read it in whatever direction the text runs. Items and totals may continue over several pages: read all pages, and take the totals from the last page.

Bills the shop gets look like these:
- Manufacturers' e-invoices (UltraTech, Grasim / Birla Pivot, V-Guard, Sudhakar PVC…) with an IRN, QR code, e-way bill number and many columns.
- Distributors' printed or handwritten bills (e.g. steel from a JSW Neosteel dealer), where quantity is often shown both in M.T. and in KGs.
- Some come through Grasim / Birla Pivot: the manufacturer's bill is "Billed to" GRASIM INDUSTRIES and only "Shipped to" / "Consignee" Kanakapatnam. Grasim then sends its own bill to the shop.

THE SELLER is the company in the header at the top (with its GSTIN), never the "Bill to", "Buyer", "Ship to" or "Consignee" party. Kanakapatnam is never the seller.
billed_to_us: true when the "Bill to" / "Buyer" party is Kanakapatnam Paints and Hardwares (or GSTIN 37DZMPM4249D1Z3); false when the bill is made out to another company (e.g. Grasim Industries) and Kanakapatnam is only the consignee / ship-to; null if not shown.

MOST IMPORTANT — the cost is the FINAL price the shop pays, before GST. The shop adds GST on top itself.
- taxable_value: the line's final amount AFTER EVERY discount (line discount %, header discount, trade discount, cash discount, scheme / special discount) and BEFORE GST. It is usually the column called "Taxable Value", "Taxable Amount" or "Assessable Value". Never give the gross amount, the MRP or the list / "Basic Price" amount.
- If a discount is printed only once for the whole bill (not per line), share it out over the lines in proportion to their amounts, so that the lines' taxable values add up to the bill's total taxable value.
- rate: the FINAL rate per unit after all discounts, before GST (= taxable_value ÷ quantity). Not the list rate, not MRP.
- discount_percent: the total discount % that was taken off the list price, for information only; null if none.
- Do not add GST, cess or round-off into taxable_value or rate.

For each item line:
- description: the item name as printed, with size / grade / pack (e.g. "ULTRATECH SUPER PPC 50 KG", "12 MM TMT FE550D", "Legrand Myrius 6A switch")
- item_code: the supplier's item / material / "Mfg Item Id" / SKU code if printed, else null
- hsn: the HSN/SAC code exactly as printed (digits only)
- quantity and unit: the quantity in the unit the RATE is charged per (M.T. / MT / Ton for steel and cement billed per tonne; NOS / EA / PCS / Piece; BAGS; KG; LTR; MTR; COIL; BOX). If the same quantity is also shown in another unit (e.g. "5.165 MTs = 5165 KGs", "10 MT = 200 bags of 50 kg"), still give the unit the rate is per, and mention the other figure in notes.
- gst_percent: the line's total GST rate (CGST% + SGST%, or the IGST%), e.g. 18 or 28
- line_total: the line amount including GST if printed, else null
Also: the seller's name, GSTIN, phone and address; the invoice number (the "Invoice No" / "Bill No" — not the IRN, ack number, order number, e-way bill number or delivery number); the invoice date as YYYY-MM-DD (Indian dates are day-month-year, e.g. 09.10.2026 = 2026-10-09); is_interstate (true when IGST is charged, false for CGST + SGST); freight / transport / loading / shipping charges billed separately (not inside a line); round off (+ or −); and the grand total payable.
Ignore the IRN, QR code, bank details, terms and conditions and signatures.
notes: short, plain notes for the person checking the bill: the e-way bill number and vehicle number if printed, other-unit quantities (KGs, bags), how a bill-level discount was shared out, and anything unclear (smudged figures, handwritten changes).
Use plain numbers without commas or currency symbols. Do not invent values: use null when something is not printed or unreadable.`;

export type ModelCaller = (args: { apiKey: string; model: string; pages: ScanPage[]; thinking?: ThinkingLevel }) => Promise<ReadBill>;
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Gemini 3 models think before answering ("medium" by default), which is slow for reading a bill.
 * A lower level answers much faster. Older models don't take this setting, so it is left out for them.
 */
export function thinkingConfig(model: string, level: ThinkingLevel | undefined) {
  return level && /^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: level } } : {};
}

/** POST a generateContent request to Google Gemini and return the answer text. Errors become plain messages. */
/** Waits between automatic retries when Google says it is busy (tests set these to 0). */
export const GEMINI_RETRY_WAITS_MS = [2000, 5000];

/**
 * POST a generateContent request to Google Gemini and return the answer text. When Google
 * is overloaded (503/500) or rate-limited (429) it is tried again a couple of times before
 * giving up. Errors become plain messages.
 */
export async function postGemini(apiKey: string, model: string, body: unknown, timeoutMs = 120_000): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postGeminiOnce(apiKey, model, body, timeoutMs);
    } catch (e) {
      const wait = GEMINI_RETRY_WAITS_MS[attempt];
      if (!(e instanceof AppError) || !e.retryable || wait == null) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function postGeminiOnce(apiKey: string, model: string, body: unknown, timeoutMs: number): Promise<string> {
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
    if (res.status === 429) throw retryable(new AppError(429, 'SCANNER_BUSY', 'Google Gemini is busy or the free limit is used up. Try again in a minute.'));
    if (res.status === 503 || res.status === 500 || res.status === 504)
      throw retryable(new AppError(503, 'GEMINI_BUSY', "Google Gemini is overloaded right now (a problem on Google's side, not your shop or key). Try again in a minute."));
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
function retryable(e: AppError) {
  e.retryable = true;
  return e;
}

export const callGemini: ModelCaller = async ({ apiKey, model, pages, thinking }) => {
  const out = await postGemini(apiKey, model, {
    contents: [{ role: 'user', parts: [{ text: PROMPT }, ...pages.map((p) => ({ inline_data: { mime_type: p.mimeType, data: p.base64 } }))] }],
    generationConfig: { temperature: 0, response_mime_type: 'application/json', response_schema: SCHEMA, ...thinkingConfig(model, thinking) },
  }, scanTimeoutMs(pages.length));
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

export const MAX_PAGES = 15;
/** Google takes about 20 MB per request (pages travel as base64, a third bigger than the files). */
const MAX_TOTAL_BASE64 = 19 * 1024 * 1024;
/** Two minutes, plus 10 seconds a page beyond 6 (a 15-page bill gets 3½ minutes). */
export const scanTimeoutMs = (pages: number) => 120_000 + Math.max(0, pages - 6) * 10_000;
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
  lastCostCp: number | null;
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
  if (opts.pages.reduce((n, p) => n + p.base64.length, 0) > MAX_TOTAL_BASE64)
    throw new AppError(400, 'TOO_BIG', 'These pages are too large together for the scanner (about 14 MB in all). Take the photos again from a little further away, or scan the bill in two parts.');
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
    read = await (opts.caller ?? callGemini)({ apiKey: settings.geminiApiKey, model: settings.geminiModel, pages: opts.pages, thinking: settings.geminiThinking });
  } catch (e) {
    await sql`update purchase_scans set status = 'failed', error = ${(e as Error).message}, page_files = ${files} where id = ${scanId}`;
    throw e;
  }
  await sql`update purchase_scans set raw = ${sql.json(read as never)}, page_files = ${files} where id = ${scanId}`;

  // Supplier
  const suppliers = await sql<{ id: number; name: string; gstin: string | null }[]>`select id, name, gstin from suppliers where active`;
  const sup = opts.supplierId ? { supplierId: opts.supplierId, by: 'chosen' as const } : matchSupplier(read.supplier ?? {}, suppliers);

  // Products
  const products = await sql<{ id: number; sku: string; name: string; brand_name: string | null; cost_price_cp: number | null; unit_code: string }[]>`
    select p.id, p.sku, p.name, b.name as brand_name, p.cost_price_cp, p.unit_code from products p left join brands b on b.id = p.brand_id where p.active`;
  const aliasRows = await sql<{ alias: string; product_id: number; supplier_id: number | null }[]>`
    select alias, product_id, supplier_id from product_aliases where supplier_id is null or supplier_id = ${sup.supplierId ?? -1}
    order by supplier_id nulls first`;
  const aliases = new Map(aliasRows.map((a) => [a.alias, a.product_id]));
  const costs = new Map(products.map((p) => [p.id, p.cost_price_cp]));

  const lines: ScanDraftLine[] = read.lines.map((l) => {
    const qtyMilli = toMilli(l.quantity);
    const ratePaise = toPaise(l.rate);
    const discountBp = toBp(l.discount_percent);
    let taxablePaise = toPaise(l.taxable_value);
    const gstRateBp = toBp(l.gst_percent);
    const warnings: string[] = [];
    // rate is the final rate after all discounts (discount_percent is for information only)
    if (taxablePaise == null && ratePaise != null && qtyMilli != null) {
      taxablePaise = Math.round((ratePaise * qtyMilli) / 1000);
      warnings.push('Line amount worked out from rate × quantity');
    }
    if (ratePaise != null && qtyMilli != null && taxablePaise != null) {
      const expected = (ratePaise * qtyMilli) / 1000;
      if (Math.abs(expected - taxablePaise) > Math.max(100, expected * 0.01)) warnings.push('Rate × quantity does not match the line amount — check this line');
    }
    if (qtyMilli == null) warnings.push('Quantity not readable');
    if (gstRateBp == null) warnings.push('GST % not readable');
    const match = matchProduct({ description: l.description, itemCode: l.item_code }, products, aliases);
    const lastCost = match.productId ? (costs.get(match.productId) ?? null) : null;
    if (lastCost != null && qtyMilli && taxablePaise != null) {
      const unitCost = (taxablePaise * 100000) / qtyMilli; // cp, like the product's cost
      if (lastCost > 0 && Math.abs(unitCost - lastCost) / lastCost > 0.25) warnings.push(`Cost is very different from last time (₹${formatCost(lastCost)}) — check the unit and quantity`);
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
      lastCostCp: lastCost,
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
    notes:
      [
        read.invoice?.billed_to_us === false
          ? `This bill is made out to ${read.invoice.billed_to_name || 'another company'}, not to us — we are only the ship-to. Our purchase bill for these goods is that company's bill (e.g. Grasim / Birla Pivot): enter that one instead, so the stock isn't added twice.`
          : null,
        read.notes,
      ]
        .filter(Boolean)
        .join(' ') || null,
    billedToUs: read.invoice?.billed_to_us ?? null,
    duplicateOf,
  };
}

export function readScanPage(scanDir: string, rel: string) {
  if (!/^\d{4}-\d{2}\/scan-\d+-p\d+\.(jpg|png|webp|heic|heif|pdf)$/.test(rel)) throw new AppError(400, 'BAD_PATH', 'Not a scan file');
  return readFileSync(join(scanDir, rel));
}

export { normalizeText };

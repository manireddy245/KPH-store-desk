import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidGstin, istDate, type Permission } from '@kph/core';
import type { Sql } from '../db/connect.js';
import { AppError, can, type Ctx } from './common.js';
import { normalizeText } from './matching.js';
import { listCustomers, listSuppliers } from './parties.js';
import { listInvoices } from './billing.js';
import { listProducts } from './products.js';
import { postGemini, scanBill, type ModelCaller, type ScanPage } from './scanner.js';
import { getSettings } from './settings.js';

/**
 * The shop assistant: a chat where staff type, attach photos (supplier bills, PDFs)
 * or send voice notes (Telugu or English). Google Gemini reads the message, may look
 * things up in the books (read-only), and answers. When something should be done —
 * a bill, a stock correction, a new customer, a payment, a purchase from a bill photo —
 * it only PROPOSES it as a card. Nothing is saved until a person presses the button
 * on the card, which goes through the normal screens, permission checks and admin PIN.
 */

// ------------------------------------------------------------------ model contract

export type LookupTool = 'find_products' | 'find_customers' | 'find_suppliers' | 'sales_summary' | 'low_stock' | 'recent_bills';
export type ActionType = 'purchase_from_photo' | 'bill_draft' | 'stock_adjust' | 'add_customer' | 'receive_payment';

export interface Lookup {
  tool: LookupTool;
  query?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface Action {
  type: ActionType;
  customer_id?: number | null;
  customer?: string | null;
  payment_mode?: string | null;
  items?: { product_id?: number | null; product?: string | null; qty: number; unit?: string | null }[] | null;
  product_id?: number | null;
  product?: string | null;
  qty_change?: number | null;
  new_qty?: number | null;
  reason?: string | null;
  name?: string | null;
  phone?: string | null;
  gstin?: string | null;
  address?: string | null;
  amount?: number | null;
}

/** One answer from the model. */
export interface AgentReply {
  heard?: string | null;
  reply: string;
  lookups?: Lookup[] | null;
  actions?: Action[] | null;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: ({ text: string } | { inline_data: { mime_type: string; data: string } })[];
}

export type AssistantModel = (args: { apiKey: string; model: string; system: string; contents: GeminiContent[] }) => Promise<AgentReply>;

const LOOKUPS: LookupTool[] = ['find_products', 'find_customers', 'find_suppliers', 'sales_summary', 'low_stock', 'recent_bills'];
const ACTIONS: ActionType[] = ['purchase_from_photo', 'bill_draft', 'stock_adjust', 'add_customer', 'receive_payment'];
const S = (description?: string) => ({ type: 'STRING', nullable: true, ...(description ? { description } : {}) });
const N = (description?: string) => ({ type: 'NUMBER', nullable: true, ...(description ? { description } : {}) });

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    heard: S('Only when the message has a voice note: exactly what was said, written in the language and script spoken'),
    reply: { type: 'STRING', description: 'What to say to the person. Short and plain.' },
    lookups: {
      type: 'ARRAY',
      description: 'Look things up in the shop books before answering or proposing. Leave empty when you have what you need.',
      items: {
        type: 'OBJECT',
        properties: { tool: { type: 'STRING', enum: LOOKUPS }, query: S(), from: S('YYYY-MM-DD'), to: S('YYYY-MM-DD') },
        required: ['tool'],
      },
    },
    actions: {
      type: 'ARRAY',
      description: 'Things to propose. Each becomes a card the person must confirm.',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ACTIONS },
          customer_id: { type: 'INTEGER', nullable: true },
          customer: S('customer name if no id'),
          payment_mode: S('cash, upi, card, credit, bank or cheque'),
          items: {
            type: 'ARRAY',
            nullable: true,
            items: {
              type: 'OBJECT',
              properties: { product_id: { type: 'INTEGER', nullable: true }, product: S(), qty: { type: 'NUMBER' }, unit: S() },
              required: ['qty'],
            },
          },
          product_id: { type: 'INTEGER', nullable: true },
          product: S(),
          qty_change: N('stock_adjust: + to add, - to remove'),
          new_qty: N('stock_adjust: the counted quantity, instead of qty_change'),
          reason: S(),
          name: S(),
          phone: S(),
          gstin: S(),
          address: S(),
          amount: N('rupees'),
        },
        required: ['type'],
      },
    },
  },
  required: ['reply', 'lookups', 'actions'],
};

export const callAssistantModel: AssistantModel = async ({ apiKey, model, system, contents }) => {
  const out = await postGemini(
    apiKey,
    model,
    {
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.2, response_mime_type: 'application/json', response_schema: SCHEMA },
    },
    90_000,
  );
  return parseAgentReply(out);
};

export function parseAgentReply(out: string): AgentReply {
  try {
    const r = JSON.parse(out.replace(/^```(json)?\s*|\s*```$/g, '')) as AgentReply;
    if (typeof r?.reply !== 'string') throw new Error('no reply');
    return r;
  } catch {
    throw new AppError(502, 'ASSISTANT_ERROR', 'The assistant gave an answer that could not be read. Try again.');
  }
}

// ------------------------------------------------------------------ prompt

const ROLE_WORDS: [Permission, string][] = [
  ['billing.create', 'make bills'],
  ['payments.receive', 'take payments'],
  ['customers.manage', 'add customers'],
  ['stock.adjust', 'enter purchases and correct stock'],
  ['reports.view', 'see sales reports'],
];

function systemPrompt(ctx: Ctx, userName: string, storeName: string) {
  const allowed = ROLE_WORDS.filter(([p]) => can(ctx, p)).map(([, w]) => w);
  return `You are the assistant inside "Store Desk", the billing and stock app of ${storeName} — a paint, cement, steel (TMT rods), pipes, sanitary, electrical and hardware shop in Kavali, Andhra Pradesh. Today is ${istDate()} (India time).
You are talking to ${userName}, who may: ${allowed.length ? allowed.join(', ') : 'only look things up'}.

How to work:
- Reply in the language the person used (Telugu in Telugu script, English, or a mix). Keep replies short — this is a busy shop counter, often on a phone.
- Use lookups to find products, customers, suppliers, stock and sales. Never guess stock figures, prices or balances; look them up. Product and customer ids MUST come from lookup results.
- Prices are in rupees. Quantities are in each product's unit (bag, rod, ltr, nos...). Steel is sold by the rod.
- You never save anything yourself. To get something done, add an action; it becomes a card the person checks and confirms. Say "check and confirm the card" — never say it is done or saved.
  - purchase_from_photo: the message has a photo or PDF of a SUPPLIER's bill/invoice to enter as a purchase (stock comes in).
  - bill_draft: selling to a customer — items with product_id and qty; customer_id if a known customer; payment_mode (credit = on account).
  - stock_adjust: correcting stock — damaged, lost, found, counted. qty_change (+/-) or new_qty, and a short reason.
  - add_customer: a new customer — name, phone, address, GSTIN if a business.
  - receive_payment: a customer paid money towards their account — customer_id, amount in rupees, payment_mode.
- If a photo is not a supplier bill (e.g. a customer's list of items), read it and propose a bill_draft instead.
- If something is unclear (which product, how many), ask one short question instead of guessing.
- If the person isn't allowed to do something, say they need admin.
- For a voice note, write what you heard in "heard" first, then act on it.`;
}

// ------------------------------------------------------------------ attachments

export interface AttachmentInput {
  mimeType: string;
  base64: string;
}

const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const AUDIO = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/opus', 'audio/aiff'];
const MAX_FILES = 6;
const MAX_TOTAL = 15 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/opus': 'opus', 'audio/aiff': 'aiff' };

export type FileKind = 'image' | 'pdf' | 'audio';
export interface StoredFile {
  kind: FileKind;
  mimeType: string;
  file: string;
}

function kindOf(mime: string): FileKind {
  if (IMAGE.includes(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (AUDIO.includes(mime)) return 'audio';
  throw new AppError(400, 'BAD_FILE', 'Send photos, PDFs or voice notes only');
}

/** Gemini's names for audio types. */
const geminiMime = (m: string) => (m === 'audio/x-m4a' || m === 'audio/m4a' ? 'audio/mp4' : m === 'audio/mp3' ? 'audio/mpeg' : m === 'audio/x-wav' ? 'audio/wav' : m);

export function chatDir(scanDir: string) {
  return join(scanDir, 'chat');
}

export function readChatFile(scanDir: string, rel: string) {
  if (!/^\d{4}-\d{2}\/m-\d+-\d+\.[a-z0-9]+$/.test(rel)) throw new AppError(400, 'BAD_PATH', 'Not a chat file');
  return readFileSync(join(chatDir(scanDir), rel));
}

// ------------------------------------------------------------------ lookups (read-only)

type ProductLite = { id: number; name: string; sku: string; brand_name: string | null; category_name: string | null; unit_code: string; qty_milli: number; sale_price_paise: number; price_includes_tax: boolean; gst_rate_bp: number; units: { unit_code: string; factor_num: number; factor_den: number; for_sale: boolean }[]; stock_status: string };

const rupees = (p: number | null | undefined) => (p == null ? null : Math.round(p) / 100);
const qty = (m: number) => Math.round(m) / 1000;

/** Products ranked by how many of the typed words they contain ("ppc cement" → "UltraTech PPC Cement 50kg"). */
export function rankProducts<T extends { name: string; sku: string; brand_name?: string | null; category_name?: string | null }>(products: T[], query: string): T[] {
  const toks = normalizeText(query)
    .split(' ')
    .filter((t) => t && !['bag', 'bags', 'the', 'of', 'nos', 'pcs'].includes(t));
  if (!toks.length) return [];
  return products
    .map((p) => {
      const hay = ` ${normalizeText([p.name, p.sku, p.brand_name, p.category_name].filter(Boolean).join(' '))} `;
      let s = 0;
      for (const t of toks) s += hay.includes(` ${t} `) ? 1 : hay.includes(` ${t}`) ? 0.8 : hay.includes(t) ? 0.4 : 0;
      return { p, s: s / toks.length };
    })
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s || a.p.name.length - b.p.name.length)
    .map((x) => x.p);
}

class Books {
  private products: ProductLite[] | null = null;
  constructor(
    private sql: Sql,
    private ctx: Ctx,
  ) {}

  async allProducts() {
    this.products ??= (await listProducts(this.sql, this.ctx, { limit: 5000 })) as unknown as ProductLite[];
    return this.products;
  }

  async run(l: Lookup): Promise<unknown> {
    const q = l.query?.trim() ?? '';
    switch (l.tool) {
      case 'find_products': {
        const found = rankProducts(await this.allProducts(), q).slice(0, 8);
        return found.map((p) => ({
          product_id: p.id,
          name: p.name,
          unit: p.unit_code,
          in_stock: qty(p.qty_milli),
          price: rupees(p.sale_price_paise),
          price_includes_gst: p.price_includes_tax,
          gst_percent: p.gst_rate_bp / 100,
          other_units: p.units.map((u) => `${u.unit_code} = ${u.factor_num / u.factor_den} ${p.unit_code}${u.for_sale ? '' : ' (buying only)'}`),
        }));
      }
      case 'find_customers': {
        let rows = (await listCustomers(this.sql, { search: q })) as unknown as { id: number; name: string; phone: string | null; gstin: string | null; balance_paise: number; credit_limit_paise: number | null; last_bill_at: string | null }[];
        if (!rows.length && q.includes(' ')) rows = (await listCustomers(this.sql, { search: q.split(/\s+/)[0] })) as never;
        return rows.slice(0, 8).map((c) => ({ customer_id: c.id, name: c.name, phone: c.phone, gstin: c.gstin, owes_us: rupees(c.balance_paise), credit_limit: rupees(c.credit_limit_paise), last_bill: c.last_bill_at }));
      }
      case 'find_suppliers': {
        const rows = (await listSuppliers(this.sql, { search: q })) as unknown as { id: number; name: string; phone: string | null; gstin: string | null; payable_paise: number }[];
        return rows.slice(0, 8).map((s) => ({ supplier_id: s.id, name: s.name, phone: s.phone, gstin: s.gstin, we_owe: rupees(s.payable_paise) }));
      }
      case 'low_stock': {
        const rows = (await listProducts(this.sql, this.ctx, { stock: 'low' })) as unknown as ProductLite[];
        const out = (await listProducts(this.sql, this.ctx, { stock: 'out' })) as unknown as ProductLite[];
        return { out_of_stock: out.slice(0, 30).map((p) => p.name), low: rows.slice(0, 30).map((p) => ({ name: p.name, in_stock: qty(p.qty_milli), unit: p.unit_code })) };
      }
      case 'recent_bills': {
        const rows = (await listInvoices(this.sql, { search: q || undefined, from: l.from ?? undefined, to: l.to ?? undefined, limit: 10 })) as unknown as { number: string; invoice_date: string; customer_name: string | null; payment_mode: string; total_paise: number; status: string }[];
        return rows.map((r) => ({ number: r.number, date: r.invoice_date, customer: r.customer_name ?? 'Walk-in', mode: r.payment_mode, total: rupees(r.total_paise), status: r.status }));
      }
      case 'sales_summary': {
        if (!can(this.ctx, 'reports.view')) return { error: 'This person is not allowed to see sales reports.' };
        const from = l.from && /^\d{4}-\d{2}-\d{2}$/.test(l.from) ? l.from : istDate();
        const to = l.to && /^\d{4}-\d{2}-\d{2}$/.test(l.to) ? l.to : from;
        const [t] = await this.sql<{ bills: number; total: number; discount: number }[]>`
          select count(*)::int as bills, coalesce(sum(total_paise), 0) as total, coalesce(sum(discount_paise), 0) as discount
          from sales_invoices where status = 'posted' and invoice_date between ${from} and ${to}`;
        const modes = await this.sql<{ payment_mode: string; total: number }[]>`
          select payment_mode, sum(total_paise) as total from sales_invoices
          where status = 'posted' and invoice_date between ${from} and ${to} group by payment_mode`;
        const top = await this.sql<{ name: string; q: number; amount: number }[]>`
          select l.name, sum(l.base_qty_milli) as q, sum(l.amount_paise) as amount
          from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id
          where si.status = 'posted' and si.invoice_date between ${from} and ${to}
          group by l.name order by amount desc limit 8`;
        const [col] = await this.sql<{ total: number }[]>`
          select coalesce(sum(amount_paise), 0) as total from receipts where status = 'posted' and receipt_date between ${from} and ${to}`;
        return {
          from,
          to,
          bills: t!.bills,
          sales_total: rupees(t!.total),
          discount_given: rupees(t!.discount),
          by_payment_mode: Object.fromEntries(modes.map((m) => [m.payment_mode, rupees(m.total)])),
          payments_collected: rupees(col!.total),
          top_items: top.map((x) => ({ name: x.name, qty: qty(x.q), amount: rupees(x.amount) })),
        };
      }
      default:
        return { error: 'Unknown lookup' };
    }
  }
}

// ------------------------------------------------------------------ cards

export type Card =
  | { kind: 'purchase'; status: CardStatus; scan: Awaited<ReturnType<typeof scanBill>>; result?: CardResult }
  | {
      kind: 'bill';
      status: CardStatus;
      customer: { id: number; name: string; phone: string | null; address: string | null; gstin: string | null; balance_paise: number; credit_limit_paise: number | null } | null;
      walkinName: string | null;
      mode: 'cash' | 'upi' | 'card' | 'credit';
      lines: { productId: number; name: string; unitCode: string; qtyMilli: number; stockMilli: number }[];
      warnings: string[];
      result?: CardResult;
    }
  | { kind: 'stock_adjust'; status: CardStatus; productId: number; name: string; unitCode: string; currentMilli: number; deltaMilli: number; reason: string; result?: CardResult }
  | { kind: 'customer'; status: CardStatus; name: string; phone: string | null; gstin: string | null; address: string | null; warnings: string[]; result?: CardResult }
  | { kind: 'payment'; status: CardStatus; customerId: number; name: string; balancePaise: number; amountPaise: number; mode: 'cash' | 'upi' | 'card' | 'bank' | 'cheque'; result?: CardResult };

export type CardStatus = 'proposed' | 'done' | 'dismissed';
export interface CardResult {
  label: string;
  link?: string;
}

const NEED: Record<ActionType, [Permission, string]> = {
  purchase_from_photo: ['stock.adjust', 'enter purchases'],
  bill_draft: ['billing.create', 'make bills'],
  stock_adjust: ['stock.adjust', 'change stock'],
  add_customer: ['customers.manage', 'add customers'],
  receive_payment: ['payments.receive', 'take payments'],
};

const toMilli = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) : null);
const unitKey = (u: string) => u.toLowerCase().replace(/[^a-z]/g, '').replace(/(es|s)$/, '');

async function resolveProduct(books: Books, id: number | null | undefined, name: string | null | undefined) {
  const all = await books.allProducts();
  if (id) {
    const p = all.find((x) => x.id === id);
    if (p) return p;
  }
  return name ? (rankProducts(all, name)[0] ?? null) : null;
}

async function resolveCustomer(sql: Sql, id: number | null | undefined, name: string | null | undefined) {
  type C = { id: number; name: string; phone: string | null; address: string | null; gstin: string | null; balance_paise: number; credit_limit_paise: number | null };
  if (id) {
    const [c] = (await listCustomers(sql, { id })) as unknown as C[];
    if (c) return { c, sure: true };
  }
  if (!name?.trim()) return null;
  const rows = (await listCustomers(sql, { search: name.trim() })) as unknown as C[];
  if (rows.length === 1) return { c: rows[0]!, sure: true };
  const exact = rows.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
  return exact ? { c: exact, sure: true } : rows.length ? { c: rows[0]!, sure: false } : null;
}

async function makeCards(
  sql: Sql,
  ctx: Ctx,
  books: Books,
  actions: Action[],
  opts: { pages: ScanPage[]; scanDir: string; scanner?: ModelCaller },
): Promise<{ cards: Card[]; notes: string[] }> {
  const cards: Card[] = [];
  const notes: string[] = [];
  let scanned = false;
  for (const a of actions.slice(0, 5)) {
    if (!ACTIONS.includes(a.type)) continue;
    const [perm, words] = NEED[a.type];
    if (!can(ctx, perm)) {
      notes.push(`You aren't allowed to ${words} — ask admin.`);
      continue;
    }
    switch (a.type) {
      case 'purchase_from_photo': {
        if (scanned) break;
        scanned = true;
        if (!opts.pages.length) {
          notes.push('Attach a photo or PDF of the supplier bill and I will read it.');
          break;
        }
        try {
          const scan = await scanBill(sql, ctx, { pages: opts.pages, scanDir: opts.scanDir, caller: opts.scanner });
          cards.push({ kind: 'purchase', status: 'proposed', scan });
        } catch (e) {
          if (e instanceof AppError) notes.push(e.message);
          else throw e;
        }
        break;
      }
      case 'bill_draft': {
        const warnings: string[] = [];
        const lines: Extract<Card, { kind: 'bill' }>['lines'] = [];
        for (const it of a.items ?? []) {
          const p = await resolveProduct(books, it.product_id, it.product);
          const q = toMilli(it.qty);
          if (!p) {
            warnings.push(`Couldn't find "${it.product ?? it.product_id}" — add it on the billing screen.`);
            continue;
          }
          if (!q || q <= 0) {
            warnings.push(`How many ${p.name}?`);
            continue;
          }
          let unitCode = p.unit_code;
          if (it.unit && unitKey(it.unit) !== unitKey(p.unit_code)) {
            const u = p.units.find((x) => unitKey(x.unit_code) === unitKey(it.unit!));
            if (u?.for_sale) unitCode = u.unit_code;
            else if (u) warnings.push(`${p.name} is sold by the ${p.unit_code}, not by the ${u.unit_code} — quantity taken as ${p.unit_code}s.`);
          }
          lines.push({ productId: p.id, name: p.name, unitCode, qtyMilli: q, stockMilli: p.qty_milli });
        }
        if (!lines.length) {
          notes.push(...warnings);
          break;
        }
        const found = await resolveCustomer(sql, a.customer_id, a.customer);
        if (a.customer && !found) warnings.push(`"${a.customer}" is not a saved customer — kept as a walk-in name.`);
        if (found && !found.sure) warnings.push(`Check the customer: picked ${found.c.name} for "${a.customer}".`);
        const m = (a.payment_mode ?? '').toLowerCase();
        const mode = m === 'credit' || m === 'account' || m === 'udhaar' ? 'credit' : m === 'upi' || m === 'phonepe' || m === 'gpay' ? 'upi' : m === 'card' ? 'card' : 'cash';
        if (mode === 'credit' && !found) warnings.push('A credit bill needs a saved customer.');
        cards.push({
          kind: 'bill',
          status: 'proposed',
          customer: found ? { id: found.c.id, name: found.c.name, phone: found.c.phone, address: found.c.address, gstin: found.c.gstin, balance_paise: found.c.balance_paise, credit_limit_paise: found.c.credit_limit_paise } : null,
          walkinName: found ? null : (a.customer?.trim() ?? null),
          mode,
          lines,
          warnings,
        });
        break;
      }
      case 'stock_adjust': {
        const p = await resolveProduct(books, a.product_id, a.product);
        if (!p) {
          notes.push(`Couldn't find "${a.product ?? a.product_id}" in the products.`);
          break;
        }
        const newQ = toMilli(a.new_qty);
        const delta = newQ != null && newQ >= 0 ? newQ - p.qty_milli : toMilli(a.qty_change);
        if (!delta) {
          notes.push(`How much should ${p.name} change by?`);
          break;
        }
        cards.push({ kind: 'stock_adjust', status: 'proposed', productId: p.id, name: p.name, unitCode: p.unit_code, currentMilli: p.qty_milli, deltaMilli: delta, reason: a.reason?.trim() || 'Stock correction' });
        break;
      }
      case 'add_customer': {
        if (!a.name?.trim()) {
          notes.push("What is the new customer's name?");
          break;
        }
        const warnings: string[] = [];
        const gstin = a.gstin?.replace(/\s/g, '').toUpperCase() || null;
        if (gstin && !isValidGstin(gstin)) warnings.push('This GSTIN does not look right — check it before saving.');
        if (gstin && !a.address) warnings.push('A business customer needs an address for GST bills.');
        cards.push({ kind: 'customer', status: 'proposed', name: a.name.trim(), phone: a.phone?.replace(/[^\d+]/g, '') || null, gstin, address: a.address?.trim() || null, warnings });
        break;
      }
      case 'receive_payment': {
        const found = await resolveCustomer(sql, a.customer_id, a.customer);
        const amount = typeof a.amount === 'number' && a.amount > 0 ? Math.round(a.amount * 100) : null;
        if (!found) {
          notes.push(`Which customer paid${a.customer ? ` ("${a.customer}" not found)` : ''}?`);
          break;
        }
        if (!amount) {
          notes.push(`How much did ${found.c.name} pay?`);
          break;
        }
        const m = (a.payment_mode ?? 'cash').toLowerCase();
        const mode = (['cash', 'upi', 'card', 'bank', 'cheque'] as const).find((x) => x === m) ?? (m === 'phonepe' || m === 'gpay' ? 'upi' : 'cash');
        cards.push({ kind: 'payment', status: 'proposed', customerId: found.c.id, name: found.c.name, balancePaise: found.c.balance_paise, amountPaise: amount, mode });
        break;
      }
    }
  }
  return { cards, notes };
}

// ------------------------------------------------------------------ conversation

interface MessageRow {
  id: number;
  at: string;
  role: 'user' | 'assistant';
  text: string;
  heard: string | null;
  files: StoredFile[];
  cards: Card[];
  error: string | null;
}

export async function listMessages(sql: Sql, ctx: Ctx, opts: { before?: number; limit?: number } = {}) {
  const rows = await sql<MessageRow[]>`
    select id, at, role, text, heard, files, cards, error from assistant_messages
    where user_id = ${ctx.userId} and not hidden and (${opts.before ?? null}::bigint is null or id < ${opts.before ?? null})
    order by id desc limit ${Math.min(opts.limit ?? 50, 200)}`;
  return rows.reverse();
}

export async function clearChat(sql: Sql, ctx: Ctx) {
  await sql`update assistant_messages set hidden = true where user_id = ${ctx.userId} and not hidden`;
  return { ok: true };
}

/** Mark a card done (after the person confirmed it on the normal screen) or dismissed. */
export async function updateCard(sql: Sql, ctx: Ctx, messageId: number, index: number, patch: { status: CardStatus; result?: CardResult }) {
  const [m] = await sql<{ cards: Card[] }[]>`select cards from assistant_messages where id = ${messageId} and user_id = ${ctx.userId}`;
  if (!m || !m.cards[index]) throw new AppError(404, 'NOT_FOUND', 'Card not found');
  const cards = m.cards.map((c, i) => (i === index ? { ...c, status: patch.status, ...(patch.result ? { result: patch.result } : {}) } : c));
  await sql`update assistant_messages set cards = ${sql.json(cards as never)} where id = ${messageId}`;
  return { ok: true };
}

/** Earlier messages as model context: text only (photos and audio are not sent again). */
function historyContents(rows: MessageRow[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const r of rows) {
    let text = r.role === 'user' ? [r.text, r.heard ? `(voice note) ${r.heard}` : '', r.files.length ? `[attached ${r.files.map((f) => f.kind).join(', ')}]` : ''].filter(Boolean).join('\n') : r.text;
    if (r.role === 'assistant' && r.cards.length) text += `\n[cards: ${r.cards.map((c) => `${c.kind} ${c.status}${c.result ? ` (${c.result.label})` : ''}`).join('; ')}]`;
    if (!text.trim()) continue;
    const role = r.role === 'user' ? 'user' : 'model';
    // Gemini wants turns to alternate.
    const last = out[out.length - 1];
    if (last?.role === role) (last.parts[0] as { text: string }).text += `\n${text}`;
    else out.push({ role, parts: [{ text }] });
  }
  while (out[0]?.role === 'model') out.shift();
  return out;
}

const MAX_ROUNDS = 4;

export async function sendMessage(
  sql: Sql,
  ctx: Ctx,
  input: { text?: string; files?: AttachmentInput[] },
  opts: { scanDir: string; model?: AssistantModel; scanner?: ModelCaller },
) {
  const text = (input.text ?? '').trim().slice(0, 4000);
  const files = (input.files ?? []).map((f) => ({ ...f, mimeType: f.mimeType.split(';')[0]!.trim().toLowerCase() }));
  if (!text && !files.length) throw new AppError(400, 'EMPTY', 'Type a message, add a photo or record a voice note');
  if (files.length > MAX_FILES) throw new AppError(400, 'TOO_MANY_FILES', `At most ${MAX_FILES} files in one message`);
  const buffers = files.map((f) => ({ kind: kindOf(f.mimeType), mimeType: f.mimeType, buf: Buffer.from(f.base64, 'base64'), base64: f.base64 }));
  if (buffers.reduce((s, b) => s + b.buf.length, 0) > MAX_TOTAL) throw new AppError(400, 'FILE_TOO_BIG', 'The files are too large together (15 MB). Send fewer photos or a shorter voice note.');

  // Save the person's message and its files first, so nothing is lost if Gemini fails.
  const [u] = await sql<{ id: number }[]>`
    insert into assistant_messages (user_id, device_id, role, text) values (${ctx.userId}, ${ctx.deviceId}, 'user', ${text}) returning id`;
  const month = new Date().toISOString().slice(0, 7);
  const dir = join(chatDir(opts.scanDir), month);
  if (buffers.length) mkdirSync(dir, { recursive: true });
  const stored: StoredFile[] = buffers.map((b, i) => {
    const rel = `${month}/m-${u!.id}-${i + 1}.${EXT[b.mimeType] ?? 'bin'}`;
    writeFileSync(join(chatDir(opts.scanDir), rel), b.buf);
    return { kind: b.kind, mimeType: b.mimeType, file: rel };
  });
  if (stored.length) await sql`update assistant_messages set files = ${sql.json(stored as never)} where id = ${u!.id}`;
  return respond(sql, ctx, u!.id, opts);
}

/** "Try again" on an answer that failed (Gemini busy, no internet): the failed answer is hidden and the same message is answered again. */
export async function retryMessage(sql: Sql, ctx: Ctx, failedId: number, opts: { scanDir: string; model?: AssistantModel; scanner?: ModelCaller }) {
  const [a] = await sql<{ id: number }[]>`
    select id from assistant_messages where id = ${failedId} and user_id = ${ctx.userId} and role = 'assistant' and error is not null and not hidden`;
  if (!a) throw new AppError(404, 'NOT_FOUND', 'Nothing to try again');
  const [u] = await sql<{ id: number }[]>`
    select id from assistant_messages where user_id = ${ctx.userId} and role = 'user' and id < ${failedId} order by id desc limit 1`;
  if (!u) throw new AppError(404, 'NOT_FOUND', 'Nothing to try again');
  await sql`update assistant_messages set hidden = true where id = ${failedId}`;
  return respond(sql, ctx, u.id, opts);
}

/** Answer a saved message of the person. */
async function respond(sql: Sql, ctx: Ctx, userMsgId: number, opts: { scanDir: string; model?: AssistantModel; scanner?: ModelCaller }) {
  const [msg] = await sql<MessageRow[]>`select id, at, role, text, heard, files, cards, error from assistant_messages where id = ${userMsgId}`;
  const text = msg!.text;
  const buffers = msg!.files.map((f) => ({ kind: f.kind, mimeType: f.mimeType, base64: readChatFile(opts.scanDir, f.file).toString('base64') }));
  const settings = await getSettings(sql);
  const history = await listMessages(sql, ctx, { before: userMsgId, limit: 12 });
  const u = { id: userMsgId };

  const finish = async (fields: { text: string; heard?: string | null; cards?: Card[]; error?: string | null }) => {
    if (fields.heard) await sql`update assistant_messages set heard = ${fields.heard} where id = ${u.id}`;
    const [a] = await sql<{ id: number }[]>`
      insert into assistant_messages (user_id, device_id, role, text, cards, error)
      values (${ctx.userId}, ${ctx.deviceId}, 'assistant', ${fields.text}, ${sql.json((fields.cards ?? []) as never)}, ${fields.error ?? null}) returning id`;
    const [mine, theirs] = await Promise.all([
      sql<MessageRow[]>`select id, at, role, text, heard, files, cards, error from assistant_messages where id = ${u.id}`,
      sql<MessageRow[]>`select id, at, role, text, heard, files, cards, error from assistant_messages where id = ${a!.id}`,
    ]);
    return { messages: [mine[0]!, theirs[0]!] };
  };

  if (!settings.geminiApiKey) return finish({ text: '', error: 'The assistant needs a Gemini API key. Admin can add it in Settings → Shop & billing.' });

  const [me] = await sql<{ name: string }[]>`select name from users where id = ${ctx.userId}`;
  const system = systemPrompt(ctx, me?.name ?? 'staff', settings.storeName);
  const parts: GeminiContent['parts'] = [];
  const hasAudio = buffers.some((b) => b.kind === 'audio');
  parts.push({ text: text || (hasAudio ? '(voice note)' : '(attachment)') });
  for (const b of buffers) parts.push({ inline_data: { mime_type: geminiMime(b.mimeType), data: b.base64 } });
  const contents: GeminiContent[] = [...historyContents(history), { role: 'user', parts }];
  if (contents.length > 1 && contents[contents.length - 2]!.role === 'user') {
    // two user turns in a row (e.g. the last answer failed): merge
    const prev = contents.splice(contents.length - 2, 1)[0]!;
    contents[contents.length - 1]!.parts.unshift(...prev.parts);
  }

  const books = new Books(sql, ctx);
  const model = opts.model ?? callAssistantModel;
  let heard: string | null = null;
  let answer: AgentReply;
  try {
    for (let round = 1; ; round++) {
      answer = await model({ apiKey: settings.geminiApiKey, model: settings.geminiModel, system, contents });
      if (round === 1 && hasAudio && answer.heard?.trim()) heard = answer.heard.trim();
      const lookups = (answer.lookups ?? []).filter((l) => LOOKUPS.includes(l.tool)).slice(0, 6);
      if (!lookups.length || round >= MAX_ROUNDS) break;
      const results = [];
      for (const l of lookups) results.push({ lookup: l, result: await books.run(l) });
      contents.push({ role: 'model', parts: [{ text: JSON.stringify(answer) }] });
      contents.push({ role: 'user', parts: [{ text: `Lookup results (from the shop books):\n${JSON.stringify(results)}\nNow answer the person, and add actions if something should be done.` }] });
    }
  } catch (e) {
    if (e instanceof AppError) return finish({ text: '', heard, error: e.message });
    throw e;
  }

  const scanPages: ScanPage[] = buffers.filter((b) => b.kind !== 'audio').map((b) => ({ mimeType: b.mimeType, base64: b.base64 }));
  const { cards, notes } = await makeCards(sql, ctx, books, answer.actions ?? [], { pages: scanPages, scanDir: opts.scanDir, scanner: opts.scanner });
  const reply = [answer.reply.trim(), ...notes].filter(Boolean).join('\n\n');
  return finish({ text: reply, heard, cards });
}

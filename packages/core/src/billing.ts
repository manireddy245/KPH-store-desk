import { mulDivRound, roundToRupee, type BasisPoints, type Milli, type Paise } from './money.js';

/**
 * Bill calculation. The same code runs on the billing screen (preview) and on
 * the server (authoritative), so what staff see is exactly what gets saved.
 *
 * Price typed EXCLUDING GST ("excl"), rounding points in order:
 *  1. gross  = rate × qty                 → rounded to the paisa
 *  2. disc   = gross × discount%          → rounded to the paisa
 *  3. taxable = gross − disc
 *  4. CGST = SGST = taxable × rate/2      → each rounded to the paisa (so they are always equal)
 *     IGST = taxable × rate               → rounded to the paisa
 *
 * Price typed INCLUDING GST ("incl"):
 *  1. amount = rate × qty − discount      → this is what the customer is charged for the line
 *  2. taxable = amount × 100 / (100 + GST%) → rounded to the paisa
 *  3. taxes from taxable exactly as above
 *  4. taxable + taxes can differ from the amount by a few paise; that difference goes to
 *     the invoice round-off, so the bill total is exactly what was typed.
 *
 * Invoice total = sum of line amounts, rounded to the rupee; "Round off" makes
 * taxable + taxes + round off = total, always.
 */

export type PriceMode = 'excl' | 'incl';

export interface LineInput {
  qtyMilli: Milli;
  /** Rate per unit, in the given mode (default: excluding GST). */
  ratePaise: Paise;
  discountBp: BasisPoints;
  gstRateBp: BasisPoints;
  mode?: PriceMode;
}

export interface LineResult {
  /** Gross value before discount, excluding GST. */
  grossPaise: Paise;
  /** Discount, excluding GST. */
  discountPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  /** taxable + taxes */
  totalPaise: Paise;
  /** What the customer sees for the line: totalPaise (excl) or the typed inclusive amount (incl). */
  amountPaise: Paise;
}

export type SupplyType = 'intra' | 'inter';

function taxesOn(taxablePaise: number, gstRateBp: number, supply: SupplyType) {
  if (supply === 'intra') {
    const half = mulDivRound(taxablePaise, gstRateBp, 20000);
    return { cgstPaise: half, sgstPaise: half, igstPaise: 0 };
  }
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: mulDivRound(taxablePaise, gstRateBp, 10000) };
}

/** Value excluding GST from a value including GST (rounded to the paisa). */
export function exclFromIncl(inclPaise: Paise, gstRateBp: BasisPoints): Paise {
  return mulDivRound(inclPaise, 10000, 10000 + gstRateBp);
}

/** Value including GST from a value excluding GST (rounded to the paisa). */
export function inclFromExcl(exclPaise: Paise, gstRateBp: BasisPoints): Paise {
  return exclPaise + mulDivRound(exclPaise, gstRateBp, 10000);
}

/** Convert a unit rate between modes. Used everywhere a rate is shown in the other mode. */
export function convertRate(ratePaise: Paise, from: PriceMode, to: PriceMode, gstRateBp: BasisPoints): Paise {
  if (from === to) return ratePaise;
  return to === 'incl' ? inclFromExcl(ratePaise, gstRateBp) : exclFromIncl(ratePaise, gstRateBp);
}

export function calcLine(line: LineInput, supply: SupplyType = 'intra'): LineResult {
  validateLine(line);
  if ((line.mode ?? 'excl') === 'excl') {
    const grossPaise = mulDivRound(line.ratePaise, line.qtyMilli, 1000);
    const discountPaise = mulDivRound(grossPaise, line.discountBp, 10000);
    const taxablePaise = grossPaise - discountPaise;
    const t = taxesOn(taxablePaise, line.gstRateBp, supply);
    const totalPaise = taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise;
    return { grossPaise, discountPaise, taxablePaise, ...t, totalPaise, amountPaise: totalPaise };
  }
  const grossIncl = mulDivRound(line.ratePaise, line.qtyMilli, 1000);
  const discountIncl = mulDivRound(grossIncl, line.discountBp, 10000);
  const amountPaise = grossIncl - discountIncl;
  const taxablePaise = exclFromIncl(amountPaise, line.gstRateBp);
  const grossPaise = exclFromIncl(grossIncl, line.gstRateBp);
  const t = taxesOn(taxablePaise, line.gstRateBp, supply);
  return {
    grossPaise,
    discountPaise: grossPaise - taxablePaise,
    taxablePaise,
    ...t,
    totalPaise: taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise,
    amountPaise,
  };
}

export function validateLine(line: LineInput) {
  if (!Number.isSafeInteger(line.qtyMilli) || line.qtyMilli <= 0) throw new BillError('Quantity must be more than zero');
  if (!Number.isSafeInteger(line.ratePaise) || line.ratePaise < 0) throw new BillError('Rate cannot be negative');
  if (!Number.isSafeInteger(line.discountBp) || line.discountBp < 0 || line.discountBp > 10000)
    throw new BillError('Discount must be between 0% and 100%');
  if (!Number.isSafeInteger(line.gstRateBp) || line.gstRateBp < 0 || line.gstRateBp > 10000)
    throw new BillError('GST rate is not valid');
}

export interface BillTotals {
  grossPaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  /** taxable + taxes, before rounding. */
  rawTotalPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise;
  lines: LineResult[];
}

export function calcBill(lines: LineInput[], supply: SupplyType = 'intra'): BillTotals {
  const results = lines.map((l) => calcLine(l, supply));
  const sum = (k: keyof LineResult) => results.reduce((s, r) => s + r[k], 0);
  const rawTotalPaise = sum('totalPaise');
  const totalPaise = roundToRupee(sum('amountPaise'));
  return {
    grossPaise: sum('grossPaise'),
    discountPaise: sum('discountPaise'),
    taxablePaise: sum('taxablePaise'),
    cgstPaise: sum('cgstPaise'),
    sgstPaise: sum('sgstPaise'),
    igstPaise: sum('igstPaise'),
    rawTotalPaise,
    roundOffPaise: totalPaise - rawTotalPaise,
    totalPaise,
    lines: results,
  };
}

/** GST-wise summary for the invoice footer: one row per rate. */
export function taxSummaryByRate(lines: (Pick<LineInput, 'gstRateBp'> & LineResult)[]) {
  const byRate = new Map<number, { gstRateBp: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }>();
  for (const l of lines) {
    const row = byRate.get(l.gstRateBp) ?? { gstRateBp: l.gstRateBp, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
    row.taxablePaise += l.taxablePaise;
    row.cgstPaise += l.cgstPaise;
    row.sgstPaise += l.sgstPaise;
    row.igstPaise += l.igstPaise;
    byRate.set(l.gstRateBp, row);
  }
  return [...byRate.values()].sort((a, b) => a.gstRateBp - b.gstRateBp);
}

/** HSN-wise summary (needed on invoices and in GSTR-1): one row per HSN + rate. */
export function taxSummaryByHsn(lines: { hsn: string | null; gstRateBp: number; qtyMilli: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }[], digits = 4) {
  const map = new Map<string, { hsn: string; gstRateBp: number; qtyMilli: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }>();
  for (const l of lines) {
    const hsn = (l.hsn ?? '').replace(/\D/g, '').slice(0, digits) || '—';
    const key = `${hsn}|${l.gstRateBp}`;
    const row = map.get(key) ?? { hsn, gstRateBp: l.gstRateBp, qtyMilli: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
    row.qtyMilli += l.qtyMilli;
    row.taxablePaise += l.taxablePaise;
    row.cgstPaise += l.cgstPaise;
    row.sgstPaise += l.sgstPaise;
    row.igstPaise += l.igstPaise;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.gstRateBp - b.gstRateBp);
}

export class BillError extends Error {}

/** "+20%", "20%", "+ 12.5 %" → markup in basis points (2000); null if it isn't a markup. */
export function parseMarkup(input: string): BasisPoints | null {
  const m = input.trim().match(/^\+?\s*(\d{1,3}(?:\.\d{1,2})?)\s*%$/);
  if (!m) return null;
  const bp = Math.round(Number(m[1]) * 100);
  return bp <= 100000 ? bp : null;
}

/**
 * Selling price from cost: cost (excl. GST, 4 decimals) + markup → price excl. GST, rounded to the paisa.
 * GST goes on top at billing, so the customer pays cost + markup + GST. For a product whose price
 * is kept including GST, the GST is added here.
 */
export function priceFromCost(costCp: number, markupBp: BasisPoints, gstRateBp: BasisPoints, includesTax: boolean): Paise {
  const excl = mulDivRound(costCp, 10000 + markupBp, 100 * 10000);
  return includesTax ? inclFromExcl(excl, gstRateBp) : excl;
}

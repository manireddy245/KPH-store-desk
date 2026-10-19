import { mulDivRound, roundToRupee, type BasisPoints, type Milli, type Paise } from './money.js';

/**
 * Bill calculation. The same code runs on the billing screen (preview) and on
 * the server (authoritative), so what staff see is exactly what gets saved.
 *
 * Rounding points, in order:
 *  1. gross  = rate × qty                 → rounded to the paisa
 *  2. disc   = gross × discount%          → rounded to the paisa
 *  3. taxable = gross − disc
 *  4. CGST = SGST = taxable × rate/2      → each rounded to the paisa (so they are always equal)
 *     IGST = taxable × rate               → rounded to the paisa
 *  5. invoice total rounded to the rupee; the difference is "Round off".
 */

export interface LineInput {
  qtyMilli: Milli;
  /** Rate per unit, excluding GST. */
  ratePaise: Paise;
  discountBp: BasisPoints;
  gstRateBp: BasisPoints;
}

export interface LineResult {
  grossPaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  totalPaise: Paise;
}

export type SupplyType = 'intra' | 'inter';

export function calcLine(line: LineInput, supply: SupplyType = 'intra'): LineResult {
  validateLine(line);
  const grossPaise = mulDivRound(line.ratePaise, line.qtyMilli, 1000);
  const discountPaise = mulDivRound(grossPaise, line.discountBp, 10000);
  const taxablePaise = grossPaise - discountPaise;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  if (supply === 'intra') {
    cgstPaise = mulDivRound(taxablePaise, line.gstRateBp, 20000);
    sgstPaise = cgstPaise;
  } else {
    igstPaise = mulDivRound(taxablePaise, line.gstRateBp, 10000);
  }
  return {
    grossPaise,
    discountPaise,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalPaise: taxablePaise + cgstPaise + sgstPaise + igstPaise,
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
  /** Sum before rounding to the rupee. */
  rawTotalPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise;
  lines: LineResult[];
}

export function calcBill(lines: LineInput[], supply: SupplyType = 'intra'): BillTotals {
  const results = lines.map((l) => calcLine(l, supply));
  const sum = (k: keyof LineResult) => results.reduce((s, r) => s + r[k], 0);
  const rawTotalPaise = sum('totalPaise');
  const totalPaise = roundToRupee(rawTotalPaise);
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
export function taxSummaryByRate(lines: (LineInput & LineResult)[]) {
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

export class BillError extends Error {}

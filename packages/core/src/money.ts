/**
 * Money is always integer paise. Quantities are integer thousandths of a unit ("milli").
 * Rates (GST, discount) are basis points: 1800 = 18%.
 *
 * All division goes through mulDivRound, which works in BigInt so large
 * quantity × rate products never lose precision, and rounds half away from zero.
 */

export type Paise = number;
export type Milli = number;
export type BasisPoints = number;

/** round(a * b / c), half away from zero, exact. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (c === 0) throw new Error('mulDivRound: division by zero');
  assertInt(a, 'a');
  assertInt(b, 'b');
  assertInt(c, 'c');
  let num = BigInt(a) * BigInt(b);
  let den = BigInt(c);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const neg = num < 0n;
  const abs = neg ? -num : num;
  const q = (abs * 2n + den) / (den * 2n);
  const result = neg ? -q : q;
  return Number(result);
}

/** floor(a * b / c) for non-negative inputs, exact. */
export function mulDivFloor(a: number, b: number, c: number): number {
  assertInt(a, 'a');
  assertInt(b, 'b');
  assertInt(c, 'c');
  if (a < 0 || b < 0 || c <= 0) throw new Error('mulDivFloor: expects non-negative inputs');
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

function assertInt(n: number, name: string) {
  if (!Number.isSafeInteger(n)) throw new Error(`Expected a safe integer for ${name}, got ${n}`);
}

/** Round paise to the nearest whole rupee (half up). */
export function roundToRupee(paise: Paise): Paise {
  return mulDivRound(paise, 1, 100) * 100;
}

/**
 * Parse a rupee amount typed by a person ("1,180", "1180.5", "₹ 99.99") into paise.
 * Returns null for anything that is not a valid amount with at most 2 decimals.
 */
export function parseRupees(input: string | number): Paise | null {
  const s = String(input).replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  if (!/^-?(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace('-', '').split('.');
  const paise = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -paise : paise;
}

/** Parse a quantity ("2.5", "10") into milli-units, up to 3 decimals. */
export function parseQty(input: string | number): Milli | null {
  const s = String(input).replace(/[,\s]/g, '');
  if (!/^\d*(\.\d{1,3})?$/.test(s) || s === '' || s === '.') return null;
  const [whole = '0', frac = ''] = s.split('.');
  return Number(whole || '0') * 1000 + Number((frac + '000').slice(0, 3));
}

/** Parse a percentage ("8", "7.5") into basis points, up to 2 decimals. */
export function parsePercent(input: string | number): BasisPoints | null {
  const s = String(input).replace(/[%\s]/g, '');
  if (!/^\d*(\.\d{1,2})?$/.test(s) || s === '' || s === '.') return null;
  const [whole = '0', frac = ''] = s.split('.');
  return Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 118000 → "1,180.00" (Indian grouping). */
export function formatPaise(paise: Paise): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const s = inr.format(rupees).replace(/\.00$/, '') + '.' + String(p).padStart(2, '0');
  return (neg ? '-' : '') + s;
}

/** 118000 → "₹1,180.00" */
export function formatRupees(paise: Paise): string {
  return paise < 0 ? '-₹' + formatPaise(-paise) : '₹' + formatPaise(paise);
}

/** 2500 → "2.5", 10000 → "10" */
export function formatQty(milli: Milli): string {
  const neg = milli < 0;
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const frac = abs % 1000;
  const s = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`;
  return neg ? '-' + s : s;
}

/** 1800 → "18", 750 → "7.5" */
export function formatPercent(bp: BasisPoints): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0+$/, '')}`;
}

/**
 * Cost prices carry 4 decimals: whole numbers of 1/10,000 rupee ("cp"), e.g. ₹57.2034 = 572034.
 * Exact integers, never floats. Bills, GST and totals stay in paise.
 */
export type CostCp = number;
export const CP_PER_PAISA = 100;

/** "57.2034" / "₹1,200.5" → cost in cp, up to 4 decimals; null if not a valid amount. */
export function parseCost(input: string | number): CostCp | null {
  const s = String(input).replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  if (!/^(\d+(\.\d{0,4})?|\.\d{1,4})$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  return Number(whole || '0') * 10000 + Number((frac + '0000').slice(0, 4));
}

/** 572034 → "57.2034", 3000000 → "300.00" (at least 2 decimals, up to 4; Indian grouping). */
export function formatCost(cp: CostCp): string {
  const neg = cp < 0;
  const abs = Math.abs(cp);
  const rupees = Math.floor(abs / 10000);
  let frac = String(abs % 10000).padStart(4, '0');
  if (frac.endsWith('00')) frac = frac.slice(0, 2);
  else if (frac.endsWith('0')) frac = frac.slice(0, 3);
  const s = inr.format(rupees).replace(/\.00$/, '') + '.' + frac;
  return (neg ? '-' : '') + s;
}

/** Value at cost, in paise: quantity (milli) × cost (cp), rounded to the paisa. */
export function costValuePaise(qtyMilli: Milli, cp: CostCp): Paise {
  return mulDivRound(qtyMilli, cp, 1000 * CP_PER_PAISA);
}

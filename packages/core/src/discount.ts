import { formatPercent, mulDivFloor, type BasisPoints, type Paise } from './money.js';

/**
 * Max discount rules.
 *  - A product's limit is a % or ₹ per unit. If the product has none, its category default applies.
 *  - If neither is set the limit is 0% — any discount then needs the admin PIN.
 *  - A staff member may also have a cap (%). The lower of the two applies.
 */

export type DiscountLimit = { type: 'pct'; value: BasisPoints } | { type: 'amt'; value: Paise };

export function resolveProductLimit(
  product: DiscountLimit | null | undefined,
  category: DiscountLimit | null | undefined,
): DiscountLimit {
  return product ?? category ?? { type: 'pct', value: 0 };
}

/** Convert a limit to basis points of the given (pre-tax) rate. ₹ limits round down. */
export function limitToBp(limit: DiscountLimit, ratePaise: Paise): BasisPoints {
  if (limit.type === 'pct') return Math.min(limit.value, 10000);
  if (ratePaise <= 0) return 0;
  return Math.min(mulDivFloor(limit.value, 10000, ratePaise), 10000);
}

export function effectiveMaxDiscountBp(opts: {
  productLimit: DiscountLimit | null | undefined;
  categoryLimit: DiscountLimit | null | undefined;
  staffCapBp: BasisPoints | null | undefined;
  ratePaise: Paise;
}): BasisPoints {
  const productBp = limitToBp(resolveProductLimit(opts.productLimit, opts.categoryLimit), opts.ratePaise);
  return opts.staffCapBp == null ? productBp : Math.min(productBp, opts.staffCapBp);
}

export function isOverLimit(discountBp: BasisPoints, maxBp: BasisPoints): boolean {
  return discountBp > maxBp;
}

/**
 * Discreet hint shown only on the billing screen: "D8" means max 8%.
 * Never printed or shared.
 */
export function discountHintCode(maxBp: BasisPoints): string {
  return 'D' + formatPercent(maxBp);
}

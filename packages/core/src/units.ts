import type { Milli } from './money.js';

/**
 * Units. Stock is always kept in the product's base unit. Other units are a
 * whole-number ratio of it: 1 unit = num / den base units.
 *   TMT 12 mm, base "rod":  1 tonne = 94 rods      → num 94, den 1
 *   Wire, base "mtr":       1 coil  = 90 metres    → num 90, den 1
 *   TMT, base "rod":        1 kg    = 94/1000 rods → num 94, den 1000
 */
export interface UnitFactor {
  num: number;
  den: number;
}

export const BASE: UnitFactor = { num: 1, den: 1 };

/** Quantity in a unit → quantity in base units (thousandths), and whether it converted exactly. */
export function toBase(qtyMilli: Milli, f: UnitFactor): { baseMilli: Milli; exact: boolean } {
  if (!Number.isSafeInteger(f.num) || !Number.isSafeInteger(f.den) || f.num <= 0 || f.den <= 0) throw new Error('Unit factor is not valid');
  const prod = BigInt(qtyMilli) * BigInt(f.num);
  const den = BigInt(f.den);
  const q = (prod * 2n + den) / (den * 2n);
  return { baseMilli: Number(q), exact: prod % den === 0n };
}

/** Price per base unit → price for one of this unit (rounded to the paisa). */
export function unitPrice(basePricePaise: number, f: UnitFactor): number {
  const prod = BigInt(basePricePaise) * BigInt(f.num);
  const den = BigInt(f.den);
  return Number((prod * 2n + den) / (den * 2n));
}

/** "4,700 rods" shown also as "≈ 50 tonne" when a bigger unit exists. */
export function fromBase(baseMilli: Milli, f: UnitFactor): number {
  return (baseMilli * f.den) / f.num / 1000;
}

/**
 * Standard TMT rods per tonne for a 12 m rod, from the IS 1786 nominal weight (d²/162 kg per metre).
 * Only a suggestion: the shop enters its own number per product.
 */
export function standardRodsPerTonne(diameterMm: number, rodLengthM = 12): number {
  const kgPerRod = ((diameterMm * diameterMm) / 162) * rodLengthM;
  return Math.round(1000 / kgPerRod);
}

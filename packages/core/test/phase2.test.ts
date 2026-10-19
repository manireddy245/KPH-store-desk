import { describe, expect, it } from 'vitest';
import { calcBill, calcLine, convertRate, exclFromIncl, inclFromExcl, isValidGstin, roundToRupee, standardRodsPerTonne, stateFromGstin, taxSummaryByHsn, toBase, unitPrice } from '../src/index.js';

describe('prices typed including GST', () => {
  it('₹1,180 incl. 18% = ₹1,000 + ₹90 CGST + ₹90 SGST', () => {
    const r = calcLine({ qtyMilli: 1000, ratePaise: 118000, discountBp: 0, gstRateBp: 1800, mode: 'incl' });
    expect(r).toMatchObject({ taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, totalPaise: 118000, amountPaise: 118000 });
  });

  it('the invoice total is exactly what was typed, paise go to round-off', () => {
    // ₹999 incl → taxable 846.61, CGST 76.19 each → 998.99; the 1 paisa goes to round-off
    const b = calcBill([{ qtyMilli: 1000, ratePaise: 99900, discountBp: 0, gstRateBp: 1800, mode: 'incl' }]);
    expect(b.lines[0]).toMatchObject({ taxablePaise: 84661, cgstPaise: 7619, sgstPaise: 7619, amountPaise: 99900 });
    expect(b.totalPaise).toBe(99900);
    expect(b.roundOffPaise).toBe(1);
  });

  it('for any inclusive prices, total = typed amounts rounded to the rupee, and everything reconciles', () => {
    let seed = 11;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 2000; i++) {
      const lines = Array.from({ length: 1 + rnd(6) }, () => ({
        qtyMilli: 1000 * (1 + rnd(20)),
        ratePaise: 100 * (1 + rnd(20000)), // whole rupees as staff type them
        discountBp: rnd(3) === 0 ? 100 * rnd(10) : 0,
        gstRateBp: [500, 1200, 1800, 2800][rnd(4)]!,
        mode: 'incl' as const,
      }));
      const b = calcBill(lines);
      const typed = b.lines.reduce((s, l) => s + l.amountPaise, 0);
      expect(b.totalPaise).toBe(roundToRupee(typed));
      expect(b.taxablePaise + b.cgstPaise + b.sgstPaise + b.roundOffPaise).toBe(b.totalPaise);
      expect(b.cgstPaise).toBe(b.sgstPaise);
      for (const l of b.lines) expect(Math.abs(l.amountPaise - l.totalPaise)).toBeLessThanOrEqual(2);
    }
  });

  it('mixing excl and incl lines on one bill', () => {
    const b = calcBill([
      { qtyMilli: 1000, ratePaise: 100000, discountBp: 0, gstRateBp: 1800 },
      { qtyMilli: 2000, ratePaise: 59000, discountBp: 0, gstRateBp: 1800, mode: 'incl' },
    ]);
    expect(b.totalPaise).toBe(118000 + 118000);
  });

  it('IGST from an inclusive price', () => {
    const r = calcLine({ qtyMilli: 1000, ratePaise: 118000, discountBp: 0, gstRateBp: 1800, mode: 'incl' }, 'inter');
    expect(r).toMatchObject({ taxablePaise: 100000, igstPaise: 18000, cgstPaise: 0 });
  });

  it('converts rates both ways', () => {
    expect(inclFromExcl(100000, 1800)).toBe(118000);
    expect(exclFromIncl(118000, 1800)).toBe(100000);
    expect(convertRate(31500, 'excl', 'incl', 1800)).toBe(37170);
    expect(convertRate(37170, 'incl', 'excl', 1800)).toBe(31500);
    expect(convertRate(500, 'excl', 'excl', 1800)).toBe(500);
  });
});

describe('GSTIN', () => {
  it('accepts valid GSTINs and checks the check digit', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27aapfu0939f1zv')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false); // wrong check digit
    expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false); // no such state
    expect(isValidGstin('27AAPFU0939F1V')).toBe(false);
    expect(isValidGstin('')).toBe(false);
  });
  it('reads the state', () => {
    expect(stateFromGstin('37ABCDE1234F1Z5')).toBe('37');
  });
});

describe('units', () => {
  it('tonnes to rods', () => {
    expect(toBase(5000, { num: 94, den: 1 })).toEqual({ baseMilli: 470000, exact: true });
    expect(toBase(2500, { num: 94, den: 1 })).toEqual({ baseMilli: 235000, exact: true });
  });
  it('kg to rods is not always a whole number', () => {
    expect(toBase(1000, { num: 94, den: 1000 })).toEqual({ baseMilli: 94, exact: true });
    expect(toBase(1, { num: 94, den: 1000 }).exact).toBe(false);
  });
  it('price per unit from price per base unit', () => {
    expect(unitPrice(64000, { num: 94, den: 1 })).toBe(6016000); // ₹640/rod → ₹60,160/tonne
    expect(unitPrice(1450, { num: 1, den: 90 })).toBe(16);
  });
  it('suggests standard rods per tonne', () => {
    expect(standardRodsPerTonne(8)).toBe(211);
    expect(standardRodsPerTonne(12)).toBe(94);
    expect(standardRodsPerTonne(16)).toBe(53);
    expect(standardRodsPerTonne(25)).toBe(22);
  });
});

describe('HSN summary', () => {
  it('groups by HSN (4 digits) and rate', () => {
    const rows = taxSummaryByHsn([
      { hsn: '25232930', gstRateBp: 1800, qtyMilli: 1000, taxablePaise: 100, cgstPaise: 9, sgstPaise: 9, igstPaise: 0 },
      { hsn: '2523', gstRateBp: 1800, qtyMilli: 2000, taxablePaise: 200, cgstPaise: 18, sgstPaise: 18, igstPaise: 0 },
      { hsn: '3209', gstRateBp: 1800, qtyMilli: 1000, taxablePaise: 50, cgstPaise: 5, sgstPaise: 5, igstPaise: 0 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ hsn: '2523', qtyMilli: 3000, taxablePaise: 300 });
  });
});

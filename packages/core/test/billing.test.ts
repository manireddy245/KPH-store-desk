import { describe, expect, it } from 'vitest';
import { calcBill, calcLine, taxSummaryByRate, BillError } from '../src/index.js';

describe('calcLine', () => {
  it('splits 18% GST equally into CGST and SGST', () => {
    const r = calcLine({ qtyMilli: 1000, ratePaise: 100000, discountBp: 0, gstRateBp: 1800 });
    expect(r).toMatchObject({ taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118000 });
  });

  it('CGST always equals SGST even when the half-tax has an odd paisa', () => {
    // taxable 333 paise × 9% = 29.97 → 30 each
    for (let rate = 1; rate < 5000; rate += 37) {
      const r = calcLine({ qtyMilli: 1000, ratePaise: rate, discountBp: 0, gstRateBp: 1800 });
      expect(r.cgstPaise).toBe(r.sgstPaise);
      expect(r.totalPaise).toBe(r.taxablePaise + 2 * r.cgstPaise);
    }
  });

  it('applies discount before tax and rounds at each defined point', () => {
    // 3 bags × ₹385.50, 1% discount, 18%
    const r = calcLine({ qtyMilli: 3000, ratePaise: 38550, discountBp: 100, gstRateBp: 1800 });
    expect(r.grossPaise).toBe(115650);
    expect(r.discountPaise).toBe(1157); // 1156.5 → 1157
    expect(r.taxablePaise).toBe(114493);
    expect(r.cgstPaise).toBe(10304); // 10304.37
    expect(r.sgstPaise).toBe(10304);
    expect(r.totalPaise).toBe(135101);
  });

  it('handles fractional quantities (2.5 L)', () => {
    const r = calcLine({ qtyMilli: 2500, ratePaise: 33333, discountBp: 0, gstRateBp: 1800 });
    expect(r.grossPaise).toBe(83333); // 83332.5 → 83333
  });

  it('uses IGST for inter-state supply', () => {
    const r = calcLine({ qtyMilli: 1000, ratePaise: 100000, discountBp: 0, gstRateBp: 1800 }, 'inter');
    expect(r).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 18000, totalPaise: 118000 });
  });

  it('rejects bad input', () => {
    expect(() => calcLine({ qtyMilli: 0, ratePaise: 100, discountBp: 0, gstRateBp: 1800 })).toThrow(BillError);
    expect(() => calcLine({ qtyMilli: 1000, ratePaise: -1, discountBp: 0, gstRateBp: 1800 })).toThrow(BillError);
    expect(() => calcLine({ qtyMilli: 1000, ratePaise: 100, discountBp: 10001, gstRateBp: 1800 })).toThrow(BillError);
  });
});

describe('calcBill', () => {
  it('rounds the invoice to the rupee and records round-off', () => {
    const b = calcBill([
      { qtyMilli: 1000, ratePaise: 38550, discountBp: 0, gstRateBp: 1800 }, // 385.50 + 34.70 + 34.70 = 454.90
      { qtyMilli: 2000, ratePaise: 1999, discountBp: 0, gstRateBp: 1800 }, // 39.98 + 3.60 + 3.60 = 47.18
    ]);
    expect(b.rawTotalPaise).toBe(45490 + 4718);
    expect(b.totalPaise).toBe(50200);
    expect(b.roundOffPaise).toBe(-8);
    expect(b.taxablePaise + b.cgstPaise + b.sgstPaise + b.roundOffPaise).toBe(b.totalPaise);
  });

  it('totals always reconcile: taxable + taxes + round off = total', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 300; i++) {
      const lines = Array.from({ length: 1 + rnd(8) }, () => ({
        qtyMilli: 1 + rnd(50000),
        ratePaise: rnd(5_000_000),
        discountBp: rnd(1500),
        gstRateBp: [0, 500, 1200, 1800, 2800][rnd(5)]!,
      }));
      const b = calcBill(lines);
      expect(b.taxablePaise + b.cgstPaise + b.sgstPaise + b.igstPaise + b.roundOffPaise).toBe(b.totalPaise);
      expect(b.totalPaise % 100).toBe(0);
      expect(Math.abs(b.roundOffPaise)).toBeLessThanOrEqual(50);
      expect(b.cgstPaise).toBe(b.sgstPaise);
    }
  });

  it('empty bill is zero', () => {
    expect(calcBill([]).totalPaise).toBe(0);
  });

  it('summarises tax by rate', () => {
    const inputs = [
      { qtyMilli: 1000, ratePaise: 10000, discountBp: 0, gstRateBp: 1800 },
      { qtyMilli: 1000, ratePaise: 20000, discountBp: 0, gstRateBp: 1800 },
      { qtyMilli: 1000, ratePaise: 10000, discountBp: 0, gstRateBp: 500 },
    ];
    const b = calcBill(inputs);
    const rows = taxSummaryByRate(inputs.map((l, i) => ({ ...l, ...b.lines[i]! })));
    expect(rows).toEqual([
      { gstRateBp: 500, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250, igstPaise: 0 },
      { gstRateBp: 1800, taxablePaise: 30000, cgstPaise: 2700, sgstPaise: 2700, igstPaise: 0 },
    ]);
  });
});

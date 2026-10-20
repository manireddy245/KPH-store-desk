import { describe, expect, it } from 'vitest';
import {
  formatPaise,
  formatPercent,
  formatQty,
  formatRupees,
  mulDivFloor,
  mulDivRound,
  parsePercent,
  parseQty,
  parseRupees,
  roundToRupee,
} from '../src/index.js';

describe('mulDivRound', () => {
  it('rounds half away from zero', () => {
    expect(mulDivRound(5, 1, 10)).toBe(1); // 0.5 → 1
    expect(mulDivRound(4, 1, 10)).toBe(0); // 0.4 → 0
    expect(mulDivRound(15, 1, 10)).toBe(2); // 1.5 → 2
    expect(mulDivRound(-5, 1, 10)).toBe(-1); // -0.5 → -1
    expect(mulDivRound(-4, 1, 10)).toBe(0);
    expect(mulDivRound(5, 1, -10)).toBe(-1);
  });
  it('is exact for products beyond 2^53', () => {
    // ₹1 crore rate × 1,000,000 units (in milli) — product overflows Number precision
    expect(mulDivRound(1_000_000_000, 1_000_000_000, 1000)).toBe(1_000_000_000_000_000);
    expect(mulDivRound(9_007_199_254_740, 999, 1000)).toBe(8_998_192_055_485);
  });
  it('rejects non-integers and zero divisor', () => {
    expect(() => mulDivRound(1.5, 1, 1)).toThrow();
    expect(() => mulDivRound(1, 1, 0)).toThrow();
  });
  it('mulDivFloor floors', () => {
    expect(mulDivFloor(999, 1, 100)).toBe(9);
  });
});

describe('roundToRupee', () => {
  it('rounds to nearest rupee, 50 paise up', () => {
    expect(roundToRupee(118049)).toBe(118000);
    expect(roundToRupee(118050)).toBe(118100);
    expect(roundToRupee(118000)).toBe(118000);
    expect(roundToRupee(0)).toBe(0);
  });
});

describe('parsing', () => {
  it('parses rupees typed by staff', () => {
    expect(parseRupees('1,180')).toBe(118000);
    expect(parseRupees('1180.5')).toBe(118050);
    expect(parseRupees('₹ 99.99')).toBe(9999);
    expect(parseRupees('.5')).toBe(50);
    expect(parseRupees('10.')).toBe(1000);
    expect(parseRupees(250)).toBe(25000);
    expect(parseRupees('1.234')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
    expect(parseRupees('')).toBeNull();
  });
  it('parses quantities to milli', () => {
    expect(parseQty('2.5')).toBe(2500);
    expect(parseQty('10')).toBe(10000);
    expect(parseQty('0.375')).toBe(375);
    expect(parseQty('1.2345')).toBeNull();
    expect(parseQty('-1')).toBeNull();
    expect(parseQty('')).toBeNull();
  });
  it('parses percent to basis points', () => {
    expect(parsePercent('8')).toBe(800);
    expect(parsePercent('7.5')).toBe(750);
    expect(parsePercent('18%')).toBe(1800);
    expect(parsePercent('x')).toBeNull();
  });
});

describe('formatting', () => {
  it('uses Indian grouping', () => {
    expect(formatPaise(12345678)).toBe('1,23,456.78');
    expect(formatPaise(118000)).toBe('1,180.00');
    expect(formatPaise(5)).toBe('0.05');
    expect(formatRupees(-150)).toBe('-₹1.50');
    expect(formatPaise(1234567890)).toBe('1,23,45,678.90');
  });
  it('formats qty and percent', () => {
    expect(formatQty(2500)).toBe('2.5');
    expect(formatQty(10000)).toBe('10');
    expect(formatQty(375)).toBe('0.375');
    expect(formatPercent(750)).toBe('7.5');
    expect(formatPercent(1800)).toBe('18');
    expect(formatPercent(1)).toBe('0.01');
  });
});

describe('cost with 4 decimals', () => {
  it('parses and formats exactly', async () => {
    const { parseCost, formatCost, costValuePaise } = await import('../src/money.js');
    expect(parseCost('57.2034')).toBe(572034);
    expect(parseCost('₹1,200.5')).toBe(12005000);
    expect(parseCost('300')).toBe(3000000);
    expect(parseCost('1.23456')).toBeNull();
    expect(parseCost('-5')).toBeNull();
    expect(formatCost(572034)).toBe('57.2034');
    expect(formatCost(572030)).toBe('57.203');
    expect(formatCost(3000000)).toBe('300.00');
    expect(formatCost(123456789000)).toBe('1,23,45,678.90');
    // 1.525 ton at ₹57,203.39 per ton = ₹87,235.17 (exactly what the supplier bill says)
    expect(costValuePaise(1525, 572033900)).toBe(8723517);
  });
});

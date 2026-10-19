import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLES,
  amountInWords,
  discountHintCode,
  effectiveMaxDiscountBp,
  formatDocNumber,
  fyLabel,
  fyStartYear,
  hasPermission,
  istDate,
  isOverLimit,
  limitToBp,
  numberToWordsIndian,
} from '../src/index.js';

describe('max discount', () => {
  it('uses product limit over category default', () => {
    expect(
      effectiveMaxDiscountBp({ productLimit: { type: 'pct', value: 800 }, categoryLimit: { type: 'pct', value: 500 }, staffCapBp: null, ratePaise: 10000 }),
    ).toBe(800);
  });
  it('falls back to category default, then 0%', () => {
    expect(effectiveMaxDiscountBp({ productLimit: null, categoryLimit: { type: 'pct', value: 500 }, staffCapBp: null, ratePaise: 10000 })).toBe(500);
    expect(effectiveMaxDiscountBp({ productLimit: null, categoryLimit: null, staffCapBp: null, ratePaise: 10000 })).toBe(0);
  });
  it('applies the lower of product limit and staff cap', () => {
    expect(effectiveMaxDiscountBp({ productLimit: { type: 'pct', value: 800 }, categoryLimit: null, staffCapBp: 300, ratePaise: 10000 })).toBe(300);
    expect(effectiveMaxDiscountBp({ productLimit: { type: 'pct', value: 100 }, categoryLimit: null, staffCapBp: 300, ratePaise: 10000 })).toBe(100);
  });
  it('converts ₹ per unit limits to %, rounding down', () => {
    // ₹5 off a ₹385 bag = 1.298…% → 129 bp
    expect(limitToBp({ type: 'amt', value: 500 }, 38500)).toBe(129);
    expect(limitToBp({ type: 'amt', value: 500 }, 0)).toBe(0);
    expect(limitToBp({ type: 'amt', value: 99999 }, 100)).toBe(10000);
  });
  it('flags anything above the limit', () => {
    expect(isOverLimit(800, 800)).toBe(false);
    expect(isOverLimit(801, 800)).toBe(true);
  });
  it('hint code is short and discreet', () => {
    expect(discountHintCode(800)).toBe('D8');
    expect(discountHintCode(750)).toBe('D7.5');
    expect(discountHintCode(0)).toBe('D0');
  });
});

describe('financial year (IST)', () => {
  it('April starts a new year, in India time', () => {
    expect(fyStartYear(new Date('2026-10-19T10:00:00Z'))).toBe(2026);
    expect(fyStartYear(new Date('2027-03-31T18:29:59Z'))).toBe(2026); // 23:59:59 IST 31 Mar
    expect(fyStartYear(new Date('2027-03-31T18:30:00Z'))).toBe(2027); // 00:00 IST 1 Apr
  });
  it('istDate uses India time', () => {
    expect(istDate(new Date('2026-10-19T19:00:00Z'))).toBe('2026-10-20');
  });
  it('formats invoice numbers within 16 characters', () => {
    expect(fyLabel(2026)).toBe('26-27');
    expect(fyLabel(2099)).toBe('99-00');
    expect(formatDocNumber('KPH', 2026, 123)).toBe('KPH/26-27/000123');
    expect(formatDocNumber('KPH', 2026, 123).length).toBe(16);
    expect(() => formatDocNumber('KPHW', 2026, 1)).toThrow(/16 characters/);
  });
});

describe('amount in words', () => {
  it('uses lakh and crore', () => {
    expect(numberToWordsIndian(0)).toBe('Zero');
    expect(numberToWordsIndian(1180)).toBe('One Thousand One Hundred Eighty');
    expect(numberToWordsIndian(12345678)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
    expect(numberToWordsIndian(100000)).toBe('One Lakh');
  });
  it('includes paise', () => {
    expect(amountInWords(118050)).toBe('Rupees One Thousand One Hundred Eighty and Fifty Paise Only');
    expect(amountInWords(50000)).toBe('Rupees Five Hundred Only');
  });
});

describe('default roles', () => {
  const can = (role: keyof typeof DEFAULT_ROLES, p: Parameters<typeof hasPermission>[1]) =>
    hasPermission(DEFAULT_ROLES[role].permissions, p);
  it('match the brief', () => {
    expect(can('admin', 'settings.manage')).toBe(true);
    expect(can('counter', 'billing.create')).toBe(true);
    expect(can('counter', 'billing.cancel')).toBe(false);
    expect(can('counter', 'billing.discount_over_limit')).toBe(false);
    expect(can('counter', 'products.edit_price')).toBe(false);
    expect(can('counter', 'products.view_cost')).toBe(false);
    expect(can('counter', 'stock.adjust')).toBe(false);
    expect(can('stock', 'stock.adjust')).toBe(true);
    expect(can('stock', 'billing.create')).toBe(false);
    expect(can('stock', 'reports.view')).toBe(false);
  });
});

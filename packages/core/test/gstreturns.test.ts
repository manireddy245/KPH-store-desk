import { describe, expect, it } from 'vitest';
import { ewayNeeded, ewbDate, gstDate, gstr1Section, isValidVehicleNo, normalizeVehicleNo, periodRange, uqcFor } from '../src/index.js';

describe('GSTR-1 sections', () => {
  it('registered buyer → B2B, whatever the amount', () => {
    expect(gstr1Section({ customerGstin: '37AABCL1234F1ZX', supplyType: 'intra', totalPaise: 100 })).toBe('b2b');
  });
  it('inter-state unregistered above ₹1 lakh → B2CL; at or below → B2CS', () => {
    expect(gstr1Section({ customerGstin: null, supplyType: 'inter', totalPaise: 10_000_001 })).toBe('b2cl');
    expect(gstr1Section({ customerGstin: null, supplyType: 'inter', totalPaise: 10_000_000 })).toBe('b2cs');
  });
  it('intra-state unregistered → B2CS even when large', () => {
    expect(gstr1Section({ customerGstin: '', supplyType: 'intra', totalPaise: 900_000_000 })).toBe('b2cs');
  });
});

describe('e-way bill', () => {
  it('is needed only above ₹50,000 of goods value (round-off not counted)', () => {
    expect(ewayNeeded({ taxablePaise: 4_237_288, cgstPaise: 381_356, sgstPaise: 381_356, igstPaise: 0 })).toBe(false); // 50,000.00
    expect(ewayNeeded({ taxablePaise: 4_237_289, cgstPaise: 381_356, sgstPaise: 381_356, igstPaise: 0 })).toBe(true);
  });
  it('vehicle numbers', () => {
    expect(normalizeVehicleNo('ap 39 ab-1234')).toBe('AP39AB1234');
    expect(isValidVehicleNo('AP 39 AB 1234')).toBe(true);
    expect(isValidVehicleNo('AP39T1234')).toBe(true);
    expect(isValidVehicleNo('1234')).toBe(false);
  });
});

describe('formats', () => {
  it('dates', () => {
    expect(gstDate('2026-10-05')).toBe('05-Oct-2026');
    expect(ewbDate('2026-10-05')).toBe('05/10/2026');
  });
  it('unit codes', () => {
    expect(uqcFor('bag')).toBe('BAG');
    expect(uqcFor('rod')).toBe('NOS');
    expect(uqcFor('tonne')).toBe('MTS');
    expect(uqcFor('Ltr')).toBe('LTR');
    expect(uqcFor('bucket')).toBe('OTH');
  });
  it('periods: months and financial-year quarters', () => {
    expect(periodRange('2026-02')).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('2028-02')).toMatchObject({ to: '2028-02-29' });
    expect(periodRange('2026-Q3')).toMatchObject({ from: '2026-10-01', to: '2026-12-31' });
    expect(periodRange('2026-Q4')).toMatchObject({ from: '2027-01-01', to: '2027-03-31' });
    expect(periodRange('2026-Q1')).toMatchObject({ from: '2026-04-01', to: '2026-06-30' });
    expect(() => periodRange('2026-13')).toThrow();
  });
});

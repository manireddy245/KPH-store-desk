import { describe, expect, it } from 'vitest';
import { matchProduct, matchSupplier, normalizeText, similarity } from '../src/services/matching.js';

const products = [
  { id: 1, sku: 'SMP-UT-PPC-50', name: 'UltraTech PPC Cement 50kg', brand_name: 'UltraTech' },
  { id: 2, sku: 'SMP-UT-OPC-53', name: 'UltraTech OPC 53 Grade Cement 50kg', brand_name: 'UltraTech' },
  { id: 3, sku: 'SMP-BO-EMU-20', name: 'Birla Opus One Pure Elegance Emulsion 20L', brand_name: 'Birla Opus' },
  { id: 4, sku: 'SMP-BO-EMU-10', name: 'Birla Opus One Pure Elegance Emulsion 10L', brand_name: 'Birla Opus' },
  { id: 5, sku: 'SMP-JSW-12', name: 'JSW Neosteel TMT 12mm', brand_name: 'JSW' },
  { id: 6, sku: 'SMP-JSW-16', name: 'JSW Neosteel TMT 16mm', brand_name: 'JSW' },
];

describe('normalizeText', () => {
  it('joins sizes to their numbers and drops punctuation', () => {
    expect(normalizeText('ULTRATECH  P.P.C. 50 KG')).toBe('ultratech ppc 50kg');
    expect(normalizeText('Emulsion 20 Ltr')).toBe('emulsion 20l');
    expect(normalizeText('TMT 12 MM')).toBe('tmt 12mm');
  });
});

describe('matchProduct', () => {
  it('uses a remembered match first', () => {
    const aliases = new Map([['opc 53 bag', 2]]);
    expect(matchProduct({ description: 'OPC 53 bag' }, products, aliases)).toMatchObject({ kind: 'remembered', productId: 2 });
  });

  it('matches the item code to our SKU', () => {
    expect(matchProduct({ description: 'whatever', itemCode: 'smp-ut-ppc-50' }, products, new Map())).toMatchObject({ kind: 'sku', productId: 1 });
  });

  it('matches by name and respects sizes', () => {
    expect(matchProduct({ description: 'ULTRATECH PPC 50 KG' }, products, new Map())).toMatchObject({ kind: 'name', productId: 1 });
    expect(matchProduct({ description: 'Birla Opus One Pure Elegance 20 Ltr' }, products, new Map())).toMatchObject({ kind: 'name', productId: 3 });
    expect(matchProduct({ description: 'JSW NEOSTEEL 16 MM TMT' }, products, new Map())).toMatchObject({ kind: 'name', productId: 6 });
  });

  it('never matches a different size', () => {
    expect(similarity('Birla Opus One Pure Elegance 4 Ltr', 'Birla Opus One Pure Elegance Emulsion 20L')).toBe(0);
    const r = matchProduct({ description: 'JSW NEOSTEEL 25 MM' }, products, new Map());
    expect(r.kind).toBe('none');
  });

  it('says none for an unknown product', () => {
    expect(matchProduct({ description: 'UltraTech Weather Plus 50 kg' }, products, new Map()).kind).not.toBe('remembered');
    expect(matchProduct({ description: 'Asian Paints Apex 20L' }, products, new Map()).kind).toBe('none');
  });
});

describe('matchSupplier', () => {
  const suppliers = [
    { id: 1, name: 'UltraTech Cement — Nellore dealer', gstin: '37AABCU9603R1ZM' },
    { id: 2, name: 'Astral Pipes — Vijayawada', gstin: null },
  ];
  it('prefers GSTIN', () => {
    expect(matchSupplier({ name: 'Something else', gstin: '37aabcu9603r1zm' }, suppliers)).toEqual({ supplierId: 1, by: 'gstin' });
  });
  it('falls back to name', () => {
    expect(matchSupplier({ name: 'ASTRAL PIPES VIJAYAWADA' }, suppliers)).toEqual({ supplierId: 2, by: 'name' });
    expect(matchSupplier({ name: 'Unknown Traders' }, suppliers)).toEqual({ supplierId: null, by: 'none' });
  });
});

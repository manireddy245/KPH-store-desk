/**
 * Matching what is printed on a supplier's bill to our own products.
 * Order of trust:
 *   1. remembered — we saved this exact text for this supplier before
 *   2. sku        — the bill's item code equals our SKU
 *   3. name       — words overlap well AND every size/number on the bill (50kg, 20L, 12mm) is in our name
 *   4. none       — probably a new product
 * Only "remembered" and "sku" are treated as sure; "name" is shown for a person to confirm.
 */

export type MatchKind = 'remembered' | 'sku' | 'name' | 'none';

export interface MatchCandidate {
  id: number;
  sku: string;
  name: string;
  brand_name?: string | null;
}

export interface MatchResult {
  kind: MatchKind;
  productId: number | null;
  score: number;
  alternatives: { productId: number; score: number }[];
}

const STOP = new Set(['the', 'and', 'of', 'for', 'with', 'no', 'nos', 'pcs', 'pc', 'bag', 'bags', 'grade', 'gr', 'type', 'new', 'kgs']);

/** "ULTRATECH  P.P.C. 50 KG" → "ultratech ppc 50kg" */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d)\s*(kg|kgs|ltr|lt|l|ml|mm|m|mtr|ft|inch|in|g|gm|sqmm|sq\.?mm)\b/g, '$1$2')
    .replace(/\b(kgs)\b/g, 'kg')
    .replace(/(\d)(ltr|lt)\b/g, '$1l')
    .replace(/(\d)(kgs)\b/g, '$1kg')
    .replace(/(\d)\s*["”]/g, '$1in')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
    .replace(/[.]/g, '')
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter((t) => t && !STOP.has(t));
}

/** Tokens that carry a size or number: they must agree, or it's a different product. */
function numberTokens(ts: string[]): string[] {
  return ts.filter((t) => /\d/.test(t));
}

export function similarity(billText: string, productName: string): number {
  const a = tokens(billText);
  const b = tokens(productName);
  if (!a.length || !b.length) return 0;
  const bset = new Set(b);
  // every number/size on the bill must be present in our name
  const nums = numberTokens(a);
  if (nums.some((n) => !bset.has(n) && !b.some((x) => x.startsWith(n) || n.startsWith(x)))) return 0;
  let shared = 0;
  for (const t of new Set(a)) {
    if (bset.has(t) || b.some((x) => (x.length >= 4 && t.length >= 4 && (x.startsWith(t) || t.startsWith(x))))) shared++;
  }
  return (2 * shared) / (new Set(a).size + bset.size);
}

export function matchProduct(
  line: { description: string; itemCode?: string | null },
  products: MatchCandidate[],
  aliases: Map<string, number>,
): MatchResult {
  const norm = normalizeText(line.description);
  const remembered = aliases.get(norm);
  if (remembered && products.some((p) => p.id === remembered)) return { kind: 'remembered', productId: remembered, score: 1, alternatives: [] };

  const code = line.itemCode?.trim().toLowerCase();
  if (code) {
    const bySku = products.find((p) => p.sku.toLowerCase() === code);
    if (bySku) return { kind: 'sku', productId: bySku.id, score: 1, alternatives: [] };
  }

  const scored = products
    .map((p) => ({ productId: p.id, score: Math.max(similarity(line.description, p.name), similarity(line.description, `${p.brand_name ?? ''} ${p.name}`)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best && best.score >= 0.5) return { kind: 'name', productId: best.productId, score: best.score, alternatives: scored.slice(1, 4) };
  return { kind: 'none', productId: null, score: best?.score ?? 0, alternatives: scored.slice(0, 3) };
}

/** Supplier on the bill → our supplier: GSTIN first (exact), then name. */
export function matchSupplier(
  bill: { name?: string | null; gstin?: string | null },
  suppliers: { id: number; name: string; gstin: string | null }[],
): { supplierId: number | null; by: 'gstin' | 'name' | 'none' } {
  const g = bill.gstin?.replace(/\s/g, '').toUpperCase();
  if (g) {
    const s = suppliers.find((x) => x.gstin?.toUpperCase() === g);
    if (s) return { supplierId: s.id, by: 'gstin' };
  }
  if (bill.name) {
    const best = suppliers.map((s) => ({ s, score: similarity(bill.name!, s.name) })).sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 0.5) return { supplierId: best.s.id, by: 'name' };
  }
  return { supplierId: null, by: 'none' };
}

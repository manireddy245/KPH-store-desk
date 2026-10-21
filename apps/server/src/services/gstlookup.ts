import { decodeGstin } from '@kph/core';
import type { Q } from '../db/connect.js';
import { AppError, requirePerm, type Ctx } from './common.js';
import { getSettings } from './settings.js';

/**
 * GST number lookup. Offline, a GSTIN already tells its state, PAN and kind of business (decodeGstin).
 * The rest — legal name, trade name, Regular / Composition, status, address — comes from a GST lookup
 * service set up in Settings (its address with {gstin} and {key}). Such services pass on the GST portal's
 * own taxpayer record (fields lgnm, tradeNam, dty, sts, ctb, pradr), sometimes wrapped in data / result.
 */

export interface GstDetails {
  legalName: string | null;
  tradeName: string | null;
  /** "Regular", "Composition", … */
  type: string | null;
  /** "Active", "Cancelled", … */
  status: string | null;
  constitution: string | null;
  address: string | null;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function lookupGstin(q: Q, ctx: Ctx, gstin: string, fetcher: FetchLike = fetch) {
  requirePerm(ctx, 'customers.manage');
  const decoded = decodeGstin(gstin);
  if (!decoded) throw new AppError(400, 'BAD_GSTIN', 'This GSTIN is not valid — check for a typo (15 characters).');
  const s = await getSettings(q);
  if (!s.gstLookupUrl) return { decoded, details: null, lookup: 'off' as const };
  const url = s.gstLookupUrl.replace('{gstin}', decoded.gstin).replace('{key}', encodeURIComponent(s.gstLookupKey));
  let text: string;
  try {
    const res = await fetcher(url, { headers: s.gstLookupKey ? { 'x-api-key': s.gstLookupKey, accept: 'application/json' } : { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    text = await res.text();
    if (!res.ok) throw new AppError(502, 'GST_LOOKUP', `The GST lookup service said ${res.status}. Check its address and key in Settings.`);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(503, 'GST_LOOKUP', "Can't reach the GST lookup service. Check the internet connection, or type the details.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError(502, 'GST_LOOKUP', 'The GST lookup service gave an unreadable answer.');
  }
  const details = parseTaxpayer(json);
  if (!details) throw new AppError(404, 'GST_NOT_FOUND', 'No details came back for this GSTIN. Check the number, or type the details.');
  return { decoded, details, lookup: 'done' as const };
}

/** Find the GST portal's taxpayer record (the object with "lgnm") anywhere in the answer. */
export function parseTaxpayer(json: unknown): GstDetails | null {
  const rec = findWith(json, 'lgnm', 0);
  if (!rec) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const addr = (rec.pradr as { addr?: Record<string, unknown>; adr?: string } | undefined) ?? undefined;
  const a = addr?.addr;
  const address =
    str(addr?.adr) ??
    (a ? [a.bno, a.flno, a.bnm, a.st, a.loc, a.dst, a.stcd, a.pncd].map(str).filter(Boolean).join(', ') || null : null);
  return { legalName: str(rec.lgnm), tradeName: str(rec.tradeNam), type: str(rec.dty), status: str(rec.sts), constitution: str(rec.ctb), address };
}

function findWith(v: unknown, key: string, depth: number): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || depth > 4) return null;
  if (!Array.isArray(v) && key in v) return v as Record<string, unknown>;
  for (const x of Object.values(v)) {
    const r = findWith(x, key, depth + 1);
    if (r) return r;
  }
  return null;
}

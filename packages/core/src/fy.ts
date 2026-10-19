/**
 * Financial year (April–March) and dates in Asia/Kolkata, regardless of the
 * computer's own timezone setting.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Calendar date in India for an instant: "2026-10-19". */
export function istDate(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start year of the financial year: 19 Oct 2026 → 2026; 15 Feb 2027 → 2026. */
export function fyStartYear(at: Date = new Date()): number {
  const d = istDate(at);
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return m >= 4 ? y : y - 1;
}

/** 2026 → "26-27" */
export function fyLabel(startYear: number): string {
  return `${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Invoice number, e.g. "KPH/26-27/000123". GST allows at most 16 characters,
 * so the number is checked here.
 */
export function formatDocNumber(prefix: string, startYear: number, seq: number, digits = 6): string {
  const n = `${prefix}/${fyLabel(startYear)}/${String(seq).padStart(digits, '0')}`;
  if (n.length > 16) throw new Error(`Document number "${n}" is longer than the 16 characters GST allows`);
  return n;
}

/** Start/end instants of an IST calendar day. */
export function istDayRange(date: string): { from: Date; to: Date } {
  const from = new Date(new Date(`${date}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

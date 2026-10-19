/**
 * Rules for GST returns and e-way bills that don't need the database.
 * Figures here should be confirmed with the CA when the law changes.
 */

/** Inter-state bill to an unregistered buyer above this goes to GSTR-1 table 5 (B2CL). ₹1,00,000 from 1 Aug 2024. */
export const B2CL_THRESHOLD_PAISE = 10_000_000;

/** An e-way bill is needed when the goods value (taxable + GST) of a consignment is more than ₹50,000. */
export const EWAY_THRESHOLD_PAISE = 5_000_000;

export type Gstr1Section = 'b2b' | 'b2cl' | 'b2cs';

/** Where a sales bill goes in GSTR-1. */
export function gstr1Section(inv: { customerGstin: string | null | undefined; supplyType: 'intra' | 'inter'; totalPaise: number }): Gstr1Section {
  if (inv.customerGstin && inv.customerGstin.trim()) return 'b2b';
  if (inv.supplyType === 'inter' && inv.totalPaise > B2CL_THRESHOLD_PAISE) return 'b2cl';
  return 'b2cs';
}

/** Goods value for the e-way bill: taxable value plus GST (round-off left out). */
export const ewayValuePaise = (inv: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }) =>
  inv.taxablePaise + inv.cgstPaise + inv.sgstPaise + inv.igstPaise;

export const ewayNeeded = (inv: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }) => ewayValuePaise(inv) > EWAY_THRESHOLD_PAISE;

/** GST "Unit Quantity Code" for our units. Unknown units are reported as OTH (others). */
const UQC: Record<string, string> = {
  bag: 'BAG', bags: 'BAG', nos: 'NOS', no: 'NOS', pcs: 'PCS', pc: 'PCS', piece: 'PCS', rod: 'NOS', length: 'NOS',
  kg: 'KGS', kgs: 'KGS', g: 'GMS', gm: 'GMS', ltr: 'LTR', l: 'LTR', litre: 'LTR', ml: 'MLT', mtr: 'MTR', m: 'MTR',
  tonne: 'MTS', ton: 'MTS', mt: 'MTS', quintal: 'QTL', box: 'BOX', set: 'SET', pair: 'PRS', coil: 'ROL', roll: 'ROL',
  bundle: 'BDL', tin: 'CAN', can: 'CAN', drum: 'DRM', bottle: 'BTL', packet: 'PAC', pkt: 'PAC', dozen: 'DOZ',
  sqft: 'SQF', sqm: 'SQM', carton: 'CTN', tube: 'TBS', unit: 'UNT',
};
export function uqcFor(unit: string | null | undefined): string {
  return (unit && UQC[unit.toLowerCase().trim()]) || 'OTH';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-05 → 05-Oct-2026 (the GST offline tool's date style). */
export function gstDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

/** 2026-10-05 → 05/10/2026 (the e-way bill portal's date style). */
export function ewbDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Vehicle numbers as the portal wants them: AP39AB1234. */
export const normalizeVehicleNo = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isValidVehicleNo = (v: string) => /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(normalizeVehicleNo(v)) || /^TM[A-Z0-9]{6,}$/.test(normalizeVehicleNo(v));

/** First and last day of a month ("2026-10") or a quarter ("2026-Q3" = Oct–Dec, India's financial-year quarters). */
export function periodRange(period: string): { from: string; to: string; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  const lastDay = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) throw new Error('Bad month');
    return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(lastDay(y, mo)).padStart(2, '0')}`, label: `${MONTHS[mo - 1]} ${y}` };
  }
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) {
    // FY quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec (same calendar year), Q4 Jan–Mar (next calendar year)
    const fy = Number(q[1]);
    const n = Number(q[2]);
    const startMonth = [4, 7, 10, 1][n - 1]!;
    const y = n === 4 ? fy + 1 : fy;
    const endMonth = startMonth + 2;
    const pad = (x: number) => String(x).padStart(2, '0');
    return {
      from: `${y}-${pad(startMonth)}-01`,
      to: `${y}-${pad(endMonth)}-${pad(lastDay(y, endMonth))}`,
      label: `Q${n} ${fy}-${String((fy + 1) % 100).padStart(2, '0')} (${MONTHS[startMonth - 1]}–${MONTHS[endMonth - 1]} ${y})`,
    };
  }
  throw new Error('Period must be a month (2026-10) or a quarter (2026-Q3)');
}

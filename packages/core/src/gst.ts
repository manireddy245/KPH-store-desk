/** GST state codes (first two digits of a GSTIN; also "place of supply"). */
export const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

export const stateName = (code: string | null | undefined) => (code ? (STATES[code] ?? code) : '');

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN format AND check digit (the 15th character), as computed by the GST portal. */
export function isValidGstin(input: string | null | undefined): boolean {
  if (!input) return false;
  const g = input.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  if (!STATES[g.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(g[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === g[14];
}

export const stateFromGstin = (g: string | null | undefined) => (g && /^\d{2}/.test(g) ? g.slice(0, 2) : null);

/** GST requires the recipient's name, address and state on B2C bills of ₹50,000 or more. */
export const B2C_DETAILS_THRESHOLD_PAISE = 5_000_000;

/** Kind of taxpayer, from the 4th letter of the PAN inside a GSTIN. */
const PAN_HOLDER: Record<string, string> = {
  P: 'Individual / proprietor',
  C: 'Company',
  F: 'Firm / LLP',
  H: 'HUF',
  A: 'Association of persons',
  B: 'Body of individuals',
  T: 'Trust',
  L: 'Local authority',
  J: 'Artificial juridical person',
  G: 'Government',
};

/**
 * What a GSTIN itself tells us, without going online: state, PAN and kind of business.
 * (Legal name, trade name, Regular / Composition and status need the GST lookup.)
 */
export function decodeGstin(input: string | null | undefined) {
  const g = (input ?? '').trim().toUpperCase();
  if (!isValidGstin(g)) return null;
  const pan = g.slice(2, 12);
  return { gstin: g, stateCode: g.slice(0, 2), stateName: stateName(g.slice(0, 2)), pan, holderType: PAN_HOLDER[pan[3]!] ?? 'Other', entityNo: g[12]! };
}

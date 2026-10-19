import type { Paise } from './money.js';

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n]!;
  return TENS[Math.floor(n / 10)]! + (n % 10 ? ' ' + ONES[n % 10] : '');
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}

/** Indian system: 1,23,45,678 → "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight" */
export function numberToWordsIndian(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Expected a non-negative integer');
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(numberToWordsIndian(crore) + ' Crore');
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
  if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
  if (n) parts.push(threeDigits(n));
  return parts.join(' ');
}

/** 118050 → "Rupees One Thousand One Hundred Eighty and Fifty Paise Only" */
export function amountInWords(paise: Paise): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const p = Math.abs(paise) % 100;
  let s = 'Rupees ' + numberToWordsIndian(rupees);
  if (p) s += ' and ' + twoDigits(p) + ' Paise';
  return s + ' Only';
}

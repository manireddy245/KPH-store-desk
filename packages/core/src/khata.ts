/**
 * Credit (khata): ageing buckets and the WhatsApp reminder text. No database here.
 */
import { formatPaise } from './money.js';

export const AGE_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const;

/** Which ageing bucket a bill of this age (in days) falls in: 0..3. */
export function ageBucket(days: number): 0 | 1 | 2 | 3 {
  return days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
}

/** Whole days from one ISO date to another (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso.slice(0, 10)) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Indian mobile number → "91XXXXXXXXXX" for wa.me, or null if it isn't a usable mobile number. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
}

export interface ReminderInput {
  customerName: string;
  balancePaise: number;
  overduePaise: number;
  oldestBill?: { number: string; date: string; days: number } | null;
  asOf: string;
  shopName: string;
  shopPhone?: string | null;
  upiId?: string | null;
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** A polite reminder in Telugu or English. Amounts in Indian format. */
export function reminderMessage(lang: 'te' | 'en', r: ReminderInput): string {
  const bal = `₹${formatPaise(r.balancePaise)}`;
  const due = r.overduePaise > 0 && r.overduePaise < r.balancePaise ? `₹${formatPaise(r.overduePaise)}` : null;
  const upi = r.upiId ? `upi://pay?pa=${encodeURIComponent(r.upiId)}&pn=${encodeURIComponent(r.shopName)}&am=${(r.balancePaise / 100).toFixed(2)}&cu=INR` : null;
  if (lang === 'te') {
    return [
      `నమస్కారం ${r.customerName} గారు,`,
      `${r.shopName} నుండి. ${ddmmyyyy(r.asOf)} నాటికి మీ బాకీ ${bal}.`,
      due ? `అందులో గడువు దాటినది ${due}.` : null,
      r.oldestBill ? `పాత బిల్లు: ${r.oldestBill.number} (${ddmmyyyy(r.oldestBill.date)}, ${r.oldestBill.days} రోజులు).` : null,
      'దయచేసి వీలైనంత త్వరగా చెల్లించగలరు. ధన్యవాదాలు.',
      upi ? `UPI ద్వారా చెల్లించడానికి: ${upi}` : null,
      `— ${r.shopName}${r.shopPhone ? `, ${r.shopPhone}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `Namaste ${r.customerName},`,
    `This is ${r.shopName}. Your balance with us is ${bal} as on ${ddmmyyyy(r.asOf)}.`,
    due ? `Of this, ${due} is past the due date.` : null,
    r.oldestBill ? `Oldest bill: ${r.oldestBill.number} dated ${ddmmyyyy(r.oldestBill.date)} (${r.oldestBill.days} days).` : null,
    'Kindly pay at your earliest convenience. Thank you.',
    upi ? `Pay by UPI: ${upi}` : null,
    `— ${r.shopName}${r.shopPhone ? `, ${r.shopPhone}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function whatsappLink(phone: string, text: string) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/**
 * Money paid "on account" (not marked against bills) settles the oldest bills first.
 * Given what is due on each bill (oldest first) and what is actually owed in total,
 * returns what is still open on each bill.
 */
export function settleOldestFirst(dues: number[], owed: number): number[] {
  let extra = dues.reduce((t, d) => t + Math.max(d, 0), 0) - Math.max(owed, 0);
  return dues.map((d) => {
    const due = Math.max(d, 0);
    const take = Math.min(due, Math.max(extra, 0));
    extra -= take;
    return due - take;
  });
}

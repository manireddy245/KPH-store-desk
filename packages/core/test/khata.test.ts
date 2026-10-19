import { describe, expect, it } from 'vitest';
import { addDays, ageBucket, daysBetween, reminderMessage, whatsappLink, whatsappNumber } from '../src/index.js';

describe('khata helpers', () => {
  it('ageing buckets', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(ageBucket)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(daysBetween('2026-09-30', '2026-10-20')).toBe(20);
    expect(addDays('2026-10-20', 30)).toBe('2026-11-19');
  });

  it('WhatsApp numbers', () => {
    expect(whatsappNumber('98480 12345')).toBe('919848012345');
    expect(whatsappNumber('+91-98480-12345')).toBe('919848012345');
    expect(whatsappNumber('09848012345')).toBe('919848012345');
    expect(whatsappNumber('0261 2345678')).toBeNull(); // landline
    expect(whatsappNumber(null)).toBeNull();
  });

  it('reminder text in Telugu and English, with overdue part and UPI link', () => {
    const r = { customerName: 'Srinivasa Reddy', balancePaise: 4_550_000, overduePaise: 3_000_000, oldestBill: { number: 'KPH/26-27/000042', date: '2026-08-01', days: 80 }, asOf: '2026-10-20', shopName: 'Kanakapatnam Paints', shopPhone: '9848000000', upiId: 'kph@sbi' };
    const te = reminderMessage('te', r);
    expect(te).toContain('Srinivasa Reddy గారు');
    expect(te).toContain('₹45,500.00');
    expect(te).toContain('గడువు దాటినది ₹30,000.00');
    expect(te).toContain('upi://pay?pa=kph%40sbi');
    const en = reminderMessage('en', { ...r, overduePaise: r.balancePaise, upiId: null });
    expect(en).toContain('Your balance with us is ₹45,500.00 as on 20-10-2026.');
    expect(en).not.toContain('past the due date'); // whole balance overdue: no separate line
    expect(en).not.toContain('upi://');
    expect(whatsappLink('919848012345', 'a b&c')).toBe('https://wa.me/919848012345?text=a%20b%26c');
  });
});

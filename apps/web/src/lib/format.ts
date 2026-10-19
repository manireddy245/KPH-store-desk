export { formatPaise, formatRupees, formatQty, formatPercent, parseRupees, parseQty, parsePercent, amountInWords } from '@kph/core';

const dt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const d = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const t = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

export const fmtDateTime = (x: string | Date | null | undefined) => (x ? dt.format(new Date(x)) : '');
export const fmtTime = (x: string | Date | null | undefined) => (x ? t.format(new Date(x)) : '');
/** "2026-10-19" → "19 Oct 2026" without timezone shifts. */
export const fmtDate = (x: string | null | undefined) => (x ? d.format(new Date(x.length === 10 ? `${x}T12:00:00+05:30` : x)) : '');

export const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
export const daysAgoIst = (n: number) => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);

export const MODE_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', credit: 'Credit', bank: 'Bank', cheque: 'Cheque' };

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function downloadText(filename: string, text: string, type = 'text/csv') {
  const blob = new Blob(['﻿' + text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

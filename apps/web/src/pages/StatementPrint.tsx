import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatPaise } from '@kph/core';
import { get } from '../lib/api';
import { fmtDate, todayIst } from '../lib/format';
import { Button, Input, LogoMark, Spinner } from '../components/ui';

/** Printable customer statement (A4): opening balance, every bill / payment / return, closing, and bills still due. */

interface StatementData {
  customer: { id: number; name: string; phone: string | null; address: string | null; gstin: string | null; creditLimitPaise: number | null };
  from: string;
  to: string;
  openingPaise: number;
  entries: { date: string; type: string; doc: string | null; narration: string | null; debitPaise: number; creditPaise: number; balancePaise: number }[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  closingPaise: number;
  openBills: { number: string; date: string; dueDate: string; duePaise: number; days: number; overdue: boolean }[];
  overduePaise: number;
  store: { name: string; address: string; phone: string; gstin: string; upiId: string; labels: 'en' | 'te-en' };
}

const TE: Record<string, string> = {
  'STATEMENT OF ACCOUNT': 'ఖాతా వివరాలు',
  Bill: 'బిల్లు',
  'Payment received': 'చెల్లింపు',
  'Goods returned': 'సరుకు వాపసు',
  'Opening balance': 'మునుపటి బాకీ',
  'Closing balance': 'చివరి బాకీ',
};

const rs = (p: number) => formatPaise(Math.abs(p));
const bal = (p: number) => (p === 0 ? '0.00' : `${rs(p)} ${p > 0 ? 'Dr' : 'Cr'}`);
const fyStart = (d: string) => (Number(d.slice(5, 7)) >= 4 ? `${d.slice(0, 4)}-04-01` : `${Number(d.slice(0, 4)) - 1}-04-01`);

export function StatementPrint() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const to = params.get('to') ?? todayIst();
  const from = params.get('from') ?? fyStart(to);
  const q = useQuery({ queryKey: ['khata', 'statement', id, from, to], queryFn: () => get<StatementData>(`/api/customers/${id}/statement?from=${from}&to=${to}`) });
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const d = q.data;

  useEffect(() => {
    if (d) document.title = `Statement ${d.customer.name} ${from} to ${to}`;
  }, [d, from, to]);

  if (!d)
    return (
      <div className="flex items-center gap-2 p-10 text-ink-3">
        <Spinner /> Loading…
      </div>
    );
  const L = (s: string) => (d.store.labels === 'te-en' && TE[s] ? `${s} / ${TE[s]}` : s);
  const name = /^(\S+)\s+(.*)$/.exec(d.store.name);

  return (
    <div className="min-h-screen bg-concrete py-4">
      <style>{`@page { size: A4; margin: 12mm; } @media print { .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; padding: 0 !important; } }`}</style>
      <div className="no-print mx-auto flex max-w-[794px] flex-wrap items-end gap-2 px-2 pb-3">
        <label className="text-[12px] font-semibold">
          From <Input type="date" value={f} onChange={(e) => setF(e.target.value)} />
        </label>
        <label className="text-[12px] font-semibold">
          To <Input type="date" value={t} onChange={(e) => setT(e.target.value)} />
        </label>
        <Button onClick={() => setParams({ from: f, to: t })}>Show</Button>
        <Button variant="dark" className="ml-auto" onClick={() => window.print()}>
          Print / save as PDF
        </Button>
      </div>
      <div className="sheet mx-auto flex w-[794px] flex-col gap-3.5 bg-white px-11 py-10 text-[10pt] shadow-lg">
        <div className="flex items-start justify-between gap-5 border-b-[3px] border-brick pb-3.5">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <LogoMark size={54} title={d.store.name} />
              <span className="flex flex-col leading-[1.02]">
                <span className="text-[22pt] font-extrabold tracking-[.02em]" style={{ fontStretch: '75%' }}>
                  {(name?.[1] ?? d.store.name).toUpperCase()}
                </span>
                <span className="text-[7.5pt] font-semibold tracking-[.3em] text-ink-2">{(name?.[2] ?? '').toUpperCase().replace(' AND ', ' & ')}</span>
              </span>
            </div>
            <div className="text-[9pt] leading-[1.45] text-ink-2">
              {d.store.address}
              {d.store.phone && <> · Phone {d.store.phone}</>}
              {d.store.gstin && <> · GSTIN {d.store.gstin}</>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[17pt] font-extrabold tracking-[.04em]" style={{ fontStretch: '75%' }}>
              STATEMENT OF ACCOUNT
            </div>
            {d.store.labels === 'te-en' && <div className="telugu text-[10pt] font-semibold text-brick">{TE['STATEMENT OF ACCOUNT']}</div>}
            <div className="num text-[9pt] text-ink-3">
              {fmtDate(d.from)} – {fmtDate(d.to)}
            </div>
          </div>
        </div>

        <div className="flex justify-between gap-4">
          <div>
            <div className="text-[11pt] font-bold">{d.customer.name}</div>
            {d.customer.address && <div>{d.customer.address}</div>}
            {d.customer.phone && <div>Phone {d.customer.phone}</div>}
            {d.customer.gstin && <div>GSTIN {d.customer.gstin}</div>}
          </div>
          <div className="num text-right">
            <div className="text-[8pt] font-bold uppercase tracking-[.14em] text-ink-3">{L('Closing balance')}</div>
            <div className="text-[18pt] font-extrabold">₹{bal(d.closingPaise)}</div>
            {d.overduePaise > 0 && <div className="font-bold text-bad">Overdue ₹{rs(d.overduePaise)}</div>}
          </div>
        </div>

        <table className="w-full border-collapse text-[9pt] [&_td]:border-b [&_td]:border-line-3 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-b-2 [&_th]:border-ink [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left">
          <thead>
            <tr>
              <th>Date</th>
              <th>Particulars</th>
              <th>No.</th>
              <th className="!text-right">Debit (bill)</th>
              <th className="!text-right">Credit (paid / returned)</th>
              <th className="!text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="num">
            <tr>
              <td>{fmtDate(d.from)}</td>
              <td className="font-semibold">{L('Opening balance')}</td>
              <td />
              <td />
              <td />
              <td className="text-right font-semibold">{bal(d.openingPaise)}</td>
            </tr>
            {d.entries.map((e, i) => (
              <tr key={i}>
                <td className="whitespace-nowrap">{fmtDate(e.date)}</td>
                <td>{L(e.type)}</td>
                <td>{e.doc}</td>
                <td className="text-right">{e.debitPaise ? rs(e.debitPaise) : ''}</td>
                <td className="text-right">{e.creditPaise ? rs(e.creditPaise) : ''}</td>
                <td className="text-right">{bal(e.balancePaise)}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td>{fmtDate(d.to)}</td>
              <td>{L('Closing balance')}</td>
              <td />
              <td className="text-right">{rs(d.totalDebitPaise)}</td>
              <td className="text-right">{rs(d.totalCreditPaise)}</td>
              <td className="text-right">{bal(d.closingPaise)}</td>
            </tr>
          </tbody>
        </table>

        {d.openBills.length > 0 && (
          <div>
            <div className="mb-1 text-[8pt] font-bold uppercase tracking-[.14em] text-ink-3">Bills still due</div>
            <table className="w-full border-collapse text-[9pt] [&_td]:border-b [&_td]:border-line-3 [&_td]:px-1.5 [&_td]:py-0.5">
              <tbody className="num">
                {d.openBills.map((b) => (
                  <tr key={b.number + b.date}>
                    <td>{b.number}</td>
                    <td>{fmtDate(b.date)}</td>
                    <td>{b.days} day{b.days === 1 ? "" : "s"}</td>
                    <td>{b.overdue ? <b className="text-bad">overdue since {fmtDate(b.dueDate)}</b> : `due by ${fmtDate(b.dueDate)}`}</td>
                    <td className="text-right font-bold">₹{rs(b.duePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-6 flex items-end justify-between gap-6 border-t border-line pt-3 text-[9pt] text-ink-2">
          <div>
            Please check and let us know of any difference within 7 days.
            {d.store.upiId && <div className="mt-1">Pay by UPI: <b>{d.store.upiId}</b></div>}
          </div>
          <div className="text-right">
            For <b>{d.store.name}</b>
            <div className="mt-8 text-ink-3">Authorised signatory</div>
          </div>
        </div>
      </div>
    </div>
  );
}

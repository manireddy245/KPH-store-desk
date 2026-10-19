import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatPaise, parseRupees } from '@kph/core';
import { ApiError, get, post } from '../lib/api';
import { fmtDateTime, todayIst } from '../lib/format';
import { useSession } from '../lib/session';
import { Badge, Button, Empty, Field, Input, Notice, Spinner, Table, cx, useToast } from './ui';

/** Day-end closing for this counter: what it should hold, what was counted, by payment mode and by staff. */

const money = (p: number) => `₹${formatPaise(p)}`;

interface Summary {
  date: string;
  floatPaise: number;
  sales: { bills: number; total: number; cash: number; upi: number; card: number; credit: number; cancelled: number };
  collections: { n: number; total: number; cash: number; upi: number; card: number; bank: number; cheque: number };
  refunds: { cash: number; other: number };
  cashPaidOutPaise: number;
  staff: { user_name: string; bills: number; total: number; discount: number }[];
  expectedCashPaise: number;
  upiPaise: number;
  cardPaise: number;
  creditGivenPaise: number;
}

export function CounterClose() {
  const { boot, can } = useSession();
  const toast = useToast();
  const [date, setDate] = useState(todayIst());
  const [float, setFloat] = useState('');
  const floatPaise = float ? (parseRupees(float) ?? 0) : 0;
  const s = useQuery({ queryKey: ['accounts', 'counter', date, floatPaise], queryFn: () => get<Summary>(`/api/counter-close/summary?date=${date}&floatPaise=${floatPaise}`) });
  const closings = useQuery({ queryKey: ['accounts', 'counter-closings', date], queryFn: () => get<{ id: number; device_name: string | null; expected_cash_paise: number; counted_cash_paise: number; difference_paise: number; note: string | null; at: string; user_name: string }[]>(`/api/counter-closings?from=${date}&to=${date}`) });
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const countedPaise = counted ? parseRupees(counted) : null;

  const save = async () => {
    if (countedPaise == null) return;
    setBusy(true);
    try {
      const r = await post<{ differencePaise: number }>('/api/counter-close', { date, floatPaise, countedCashPaise: countedPaise, note: note || undefined });
      toast({ tone: r.differencePaise === 0 ? 'good' : 'warn', text: r.differencePaise === 0 ? 'Counter closed — cash matches' : `Counter closed — ${r.differencePaise > 0 ? 'excess' : 'short'} ${money(Math.abs(r.differencePaise))}` });
      setCounted('');
      setNote('');
      void closings.refetch();
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not close the counter' });
    } finally {
      setBusy(false);
    }
  };

  const d = s.data;
  const diff = d && countedPaise != null ? countedPaise - d.expectedCashPaise : null;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="flex flex-col gap-3 rounded-[6px] border border-line bg-white p-3 text-sm">
        <div className="flex flex-wrap items-end gap-2">
          <b className="flex-1 text-[15px]">Close this counter · {boot?.device?.name}</b>
          <Input type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} className="h-8 w-[150px]" aria-label="Date" />
        </div>
        {!d ? (
          <Spinner />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ['Bills', `${d.sales.bills}`, `${money(d.sales.total)}${d.sales.cancelled ? ` · ${d.sales.cancelled} cancelled` : ''}`],
                ['UPI', money(d.upiPaise), 'sales + collections'],
                ['Card', money(d.cardPaise), 'sales + collections'],
                ['Credit given', money(d.creditGivenPaise), `collected ${money(d.collections.total)}`],
              ].map(([k, v, sub]) => (
                <div key={k} className="rounded-[4px] bg-paper px-2.5 py-2">
                  <div className="text-[11px] font-bold uppercase tracking-[.1em] text-ink-3">{k}</div>
                  <div className="num text-[16px] font-extrabold">{v}</div>
                  <div className="text-[11px] text-ink-3">{sub}</div>
                </div>
              ))}
            </div>
            <div className="num grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 rounded-[4px] border border-line px-3 py-2">
              <span>Opening float</span>
              <span className="text-right">{money(d.floatPaise)}</span>
              <span>+ Cash bills</span>
              <span className="text-right">{money(d.sales.cash)}</span>
              <span>+ Cash collected from customers</span>
              <span className="text-right">{money(d.collections.cash)}</span>
              <span>− Cash refunds</span>
              <span className="text-right">{money(d.refunds.cash)}</span>
              <span>− Cash paid out (expenses, payments)</span>
              <span className="text-right">{money(d.cashPaidOutPaise)}</span>
              <span className="border-t border-ink pt-1 font-bold">Cash that should be in the drawer</span>
              <span className="border-t border-ink pt-1 text-right font-extrabold">{money(d.expectedCashPaise)}</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Opening float (₹)">
                <Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="0" />
              </Field>
              <Field label="Cash counted (₹)">
                <Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />
              </Field>
              <Field label="Note">
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
            {diff != null && <div className={cx('num font-bold', diff === 0 ? 'text-good' : 'text-bad')}>{diff === 0 ? 'Matches' : `${diff > 0 ? 'Excess' : 'Short'} ${money(Math.abs(diff))}`}</div>}
            <div>
              <Button variant="primary" busy={busy} disabled={countedPaise == null} onClick={() => void save()}>
                Close counter
              </Button>
            </div>
            {d.staff.length > 0 && (
              <Table minWidth={360} head={<tr><th>Staff</th><th className="text-right">Bills</th><th className="text-right">Sales</th><th className="text-right">Discount</th></tr>}>
                {d.staff.map((x) => (
                  <tr key={x.user_name}>
                    <td>{x.user_name}</td>
                    <td className="num text-right">{x.bills}</td>
                    <td className="num text-right font-bold">{money(x.total)}</td>
                    <td className="num text-right">{money(x.discount)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </section>
      <section className="rounded-[6px] border border-line bg-white p-3 text-sm">
        <b className="text-[15px]">{can('reports.view') ? 'All counters' : 'This counter'} — closings on this day</b>
        {closings.data?.length ? (
          <div className="-mx-3 mt-2">
            <Table minWidth={420} head={<tr><th>Counter</th><th>By</th><th className="text-right">Should be</th><th className="text-right">Counted</th><th className="text-right">Difference</th></tr>}>
              {closings.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.device_name ?? '—'}
                    <span className="block text-[11px] text-ink-3">{fmtDateTime(c.at)}</span>
                  </td>
                  <td>{c.user_name}</td>
                  <td className="num text-right">{money(c.expected_cash_paise)}</td>
                  <td className="num text-right">{money(c.counted_cash_paise)}</td>
                  <td className="num text-right">
                    {c.difference_paise === 0 ? <Badge tone="good">OK</Badge> : <b className="text-bad">{`${c.difference_paise > 0 ? '+' : '−'}${money(Math.abs(c.difference_paise))}`}</b>}
                    {c.note && <span className="block text-[11px] text-ink-3">{c.note}</span>}
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        ) : (
          <Empty>No counter closed yet.</Empty>
        )}
        <Notice tone="teal">The shop-wide cash count (Cash count tab) compares the whole cash book; this closing is for one counter's drawer.</Notice>
      </section>
    </div>
  );
}

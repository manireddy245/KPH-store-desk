import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AGE_BUCKETS } from '@kph/core';
import { ApiError, download, get } from '../lib/api';
import { fmtDate, todayIst } from '../lib/format';
import { useSession } from '../lib/session';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Input, Notice, PageTitle, Spinner, Table, cx, useToast } from '../components/ui';
import { money, WhatsAppButton, type CustomerDues } from '../components/KhataBits';
import { CustomerDetail, ReceivePayment } from './Customers';

/**
 * Khata: who owes the shop, since when, and what is overdue. One tap for a WhatsApp reminder,
 * a payment against bills, or the full customer page.
 */
export function Khata() {
  const { can } = useSession();
  const toast = useToast();
  const [asOf, setAsOf] = useState(todayIst());
  const q = useQuery({ queryKey: ['khata', 'ageing', asOf], queryFn: () => get<{ asOf: string; customers: CustomerDues[]; totals: { receivablePaise: number; advancesPaise: number; overduePaise: number; onHoldPaise: number; buckets: number[]; customers: number; overLimit: number } }>(`/api/khata/ageing?asOf=${asOf}`) });
  const [picked, setFilter] = useState<'all' | 'overdue' | 'limit' | 'advance' | 'hold' | null>(null);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [paying, setPaying] = useState<CustomerDues | null>(null);

  // Start on "Overdue" only when some bills have due dates and are overdue; otherwise show everyone.
  const filter = picked ?? ((q.data?.totals.overduePaise ?? 0) > 0 ? 'overdue' : 'all');
  const rows = useMemo(() => {
    const all = q.data?.customers ?? [];
    const f = all.filter((c) =>
      filter === 'overdue'
        ? c.overduePaise > 0
        : filter === 'limit'
          ? c.creditLimitPaise != null && c.balancePaise > c.creditLimitPaise
          : filter === 'advance'
            ? c.balancePaise < 0
            : filter === 'hold'
              ? c.onHold && c.balancePaise > 0
              : c.balancePaise > 0 && !c.onHold,
    );
    const s = search.trim().toLowerCase();
    return s ? f.filter((c) => c.name.toLowerCase().includes(s) || (c.phone ?? '').includes(s)) : f;
  }, [q.data, filter, search]);

  const t = q.data?.totals;
  const counts = q.data && {
    overdue: q.data.customers.filter((c) => c.overduePaise > 0).length,
    all: q.data.customers.filter((c) => c.balancePaise > 0 && !c.onHold).length,
    hold: q.data.customers.filter((c) => c.onHold && c.balancePaise > 0).length,
    limit: t!.overLimit,
    advance: q.data.customers.filter((c) => c.balancePaise < 0).length,
  };

  return (
    <Page wide>
      <PageTitle
        telugu="ఖాతా బాకీలు"
        title="Khata"
        sub="Credit customers: what they owe, what is overdue, and reminders."
        actions={
          <>
            <Input type="date" value={asOf} max={todayIst()} onChange={(e) => setAsOf(e.target.value || todayIst())} className="w-[160px]" aria-label="As on" />
            {can('reports.view') && (
              <Button onClick={() => download(`/api/khata/ageing?asOf=${asOf}&format=xlsx`, 'customer-dues.xlsx').catch((e) => toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not download' }))}>
                Download Excel
              </Button>
            )}
          </>
        }
      />
      {!t ? (
        q.error ? <Notice tone="bad">{q.error instanceof ApiError ? q.error.message : 'Could not load'}</Notice> : <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <Tile label="Customers owe" value={money(t.receivablePaise)} sub={`${t.customers} customers${t.onHoldPaise ? ` · old dues ${money(t.onHoldPaise)}` : ''}`} />
            <Tile label="Overdue" value={money(t.overduePaise)} tone={t.overduePaise > 0 ? 'bad' : undefined} />
            {AGE_BUCKETS.map((b, i) => (
              <Tile key={b} label={b} value={money(t.buckets[i] ?? 0)} tone={i === 3 && (t.buckets[3] ?? 0) > 0 ? 'bad' : undefined} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['overdue', 'Overdue'],
                ['all', 'Everyone who owes'],
                ['limit', 'Over credit limit'],
                ['advance', 'Paid in advance'],
                ['hold', 'Old dues (record only)'],
              ] as const
            ).map(([k, label]) => (
              <Button key={k} size="sm" variant={filter === k ? 'dark' : 'secondary'} onClick={() => setFilter(k)}>
                {label} <span className="num opacity-70">{counts?.[k]}</span>
              </Button>
            ))}
            <Input placeholder="Search name or phone…" value={search} onChange={(e) => setSearch(e.target.value)} className="ml-auto max-w-[260px]" />
          </div>
          <section className="overflow-hidden rounded-[6px] border border-line bg-white">
            {rows.length ? (
              <Table
                head={
                  <tr>
                    <th>Customer</th>
                    <th className="text-right">Owes</th>
                    <th className="text-right">Overdue</th>
                    <th>Oldest bill</th>
                    <th>Last paid</th>
                    <th>Last reminded</th>
                    <th />
                  </tr>
                }
              >
                {rows.map((c) => {
                  const over = c.creditLimitPaise != null && c.balancePaise > c.creditLimitPaise;
                  return (
                    <tr key={c.customerId}>
                      <td>
                        <button type="button" className="text-left font-semibold hover:underline" onClick={() => setOpenId(c.customerId)}>
                          {c.name}
                        </button>
                        <div className="text-[12px] text-ink-3">
                          {c.phone ?? 'no phone'}
                          {c.creditDays != null && <> · {c.creditDays} days credit</>}
                          {c.onHold && <> · <Badge tone="warn">old dues</Badge></>}
                          {c.creditLimitPaise != null && <> · limit {money(c.creditLimitPaise)}</>}
                        </div>
                      </td>
                      <td className={cx('num text-right font-bold', c.balancePaise < 0 && 'text-teal')}>
                        {c.balancePaise < 0 ? `${money(-c.balancePaise)} adv.` : money(c.balancePaise)}
                        {over && <div><Badge tone="bad">over limit</Badge></div>}
                      </td>
                      <td className={cx('num text-right', c.overduePaise > 0 && 'font-bold text-bad')}>{c.overduePaise ? money(c.overduePaise) : '—'}</td>
                      <td className="num">{c.oldest ? `${fmtDate(c.oldest.date)} (${c.oldest.days} d)` : '—'}</td>
                      <td className="num">{c.lastReceipt ? fmtDate(c.lastReceipt) : '—'}</td>
                      <td className="num">{c.lastReminder ? fmtDate(c.lastReminder.slice(0, 10)) : '—'}</td>
                      <td className="whitespace-nowrap text-right">
                        <span className="inline-flex gap-1.5">
                          {can('payments.receive') && c.balancePaise > 0 && !c.onHold && <WhatsAppButton customerId={c.customerId} disabled={!c.phone} />}
                          {can('payments.receive') && (
                            <Button size="sm" variant="primary" onClick={() => setPaying(c)}>
                              Receive
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <Empty>{filter === 'overdue' ? 'Nothing overdue.' : 'No customers here.'}</Empty>
            )}
          </section>
          <p className="text-[12px] text-ink-3">
            A bill counts as overdue only if credit days are set (per customer, or a shop default in Settings). Payments marked against bills settle those bills; other payments settle the oldest bills first. Old dues kept as a record only are left out of reminders and due lists.
          </p>
        </>
      )}
      <CustomerDetail id={openId} onClose={() => setOpenId(null)} onEdit={() => setOpenId(null)} />
      {paying && <ReceivePayment open customer={{ id: paying.customerId, name: paying.name, balance_paise: paying.balancePaise }} onClose={() => (setPaying(null), void q.refetch())} />}
    </Page>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className={cx('rounded-[6px] border bg-white px-3 py-2.5', tone === 'bad' ? 'border-brick' : 'border-line')}>
      <div className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">{label}</div>
      <div className={cx('num mt-0.5 text-[19px] font-extrabold', tone === 'bad' && 'text-bad')}>{value}</div>
      {sub && <div className="text-[12px] text-ink-3">{sub}</div>}
    </div>
  );
}

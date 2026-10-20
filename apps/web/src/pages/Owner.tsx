import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatPaise, whatsappNumber } from '@kph/core';
import { ApiError, get, post } from '../lib/api';
import { fmtDate, fmtDateTime, todayIst } from '../lib/format';
import { useLang } from '../lib/i18n';
import { Page } from '../components/Layout';
import { Badge, Button, Input, Notice, PageTitle, Spinner, cx, useToast } from '../components/ui';
import type { Insights } from './Stock';

/** The owner's phone screen: today at a glance, alerts, and the daily summary to share. */

const r = (p: number) => `₹${formatPaise(p).replace(/\.\d\d$/, '')}`;

interface Day {
  date: string;
  sales: { bills: number; total: number; cash: number; upi: number; card: number; credit: number; discount: number; cancelled: number };
  collections: { n: number; total: number };
  returns: { n: number; total: number };
  cashInHandPaise: number;
  expensesPaise: number;
  purchases: { n: number; total: number };
  stock: { low: number; out: number };
  deliveries: { pending: number; out: number };
  topPartners: { name: string; bills: number; total: number }[];
  topItems: { name: string; qty: number; unit: string; amount: number }[];
  alerts: Record<string, number>;
  counterCashDifferencePaise: number;
}

const ALERTS: [string, string][] = [
  ['invoice.cancelled', 'bills cancelled'],
  ['discount.over_limit', 'discounts above limit'],
  ['override.approved', 'admin PIN approvals'],
  ['credit.over_limit', 'credit bills over limit'],
  ['receipt.cancelled', 'receipts cancelled'],
  ['stock.adjusted', 'stock corrections'],
];

export function Owner() {
  const toast = useToast();
  const lang = useLang();
  const [date, setDate] = useState(todayIst());
  const day = useQuery({ queryKey: ['owner', 'day', date], queryFn: () => get<Day>(`/api/owner/today?date=${date}`), refetchInterval: 60_000 });
  const due = useQuery({ queryKey: ['khata', 'due'], queryFn: () => get<{ overduePaise: number; count: number; owingPaise: number }>('/api/khata/due') });
  const ins = useQuery({ queryKey: ['stock', 'insights'], queryFn: () => get<Insights>('/api/insights/stock') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<{ ownerPhone: string; ownerEmail: string }>('/api/settings'), retry: false });
  const [sumLang, setSumLang] = useState<'te' | 'en'>(lang);
  const [busy, setBusy] = useState(false);

  const summary = async (mode: 'whatsapp' | 'email' | 'copy') => {
    const w = mode === 'whatsapp' ? window.open('', '_blank') : null;
    setBusy(true);
    try {
      const s = await post<{ en: string; te: string }>('/api/owner/summary', { date });
      const text = sumLang === 'te' ? s.te : s.en;
      if (mode === 'whatsapp') {
        const phone = whatsappNumber(settings.data?.ownerPhone ?? '');
        const url = `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`;
        if (w) w.location.href = url;
      } else if (mode === 'email') {
        window.location.href = `mailto:${settings.data?.ownerEmail ?? ''}?subject=${encodeURIComponent(`Store Desk — ${fmtDate(date)}`)}&body=${encodeURIComponent(text)}`;
      } else {
        await navigator.clipboard.writeText(text);
        toast({ tone: 'good', text: 'Summary copied' });
      }
    } catch (e) {
      w?.close();
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not make the summary' });
    } finally {
      setBusy(false);
    }
  };

  const d = day.data;
  return (
    <Page>
      <PageTitle telugu="యజమాని" title="Owner" actions={<Input type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value || todayIst())} className="w-[160px]" aria-label="Day" />} />
      {!d ? (
        day.error ? <Notice tone="bad">{day.error instanceof ApiError ? day.error.message : 'Could not load'}</Notice> : <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Big label="Sales" value={r(d.sales.total)} sub={`${d.sales.bills} bills`} strong />
            <Big label="Collected" value={r(d.collections.total)} sub={`${d.collections.n} payments`} />
            <Big label="New credit given" value={r(d.sales.credit)} sub={due.data ? `overdue ${r(due.data.overduePaise)}` : ''} />
            <Big label="Cash in hand" value={r(d.cashInHandPaise)} sub={d.counterCashDifferencePaise ? `counter difference ${r(d.counterCashDifferencePaise)}` : 'per the cash book'} />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Small label="Cash · UPI · Card" value={`${r(d.sales.cash)} · ${r(d.sales.upi)} · ${r(d.sales.card)}`} />
            <Small label="Expenses" value={r(d.expensesPaise)} />
            <Small label="Purchases entered" value={`${r(d.purchases.total)} (${d.purchases.n})`} />
            <Small label="Discount given" value={r(d.sales.discount)} />
          </div>

          <section className="flex flex-col gap-2 rounded-[6px] border border-line bg-white p-3 text-sm">
            <b className="text-[15px]">Alerts</b>
            {ALERTS.filter(([k]) => d.alerts[k]).length || d.counterCashDifferencePaise ? (
              <div className="flex flex-wrap gap-2">
                {ALERTS.filter(([k]) => d.alerts[k]).map(([k, label]) => (
                  <Link key={k} to="/activity">
                    <Badge tone={k === 'invoice.cancelled' || k === 'credit.over_limit' ? 'bad' : 'warn'}>
                      {d.alerts[k]} {label}
                    </Badge>
                  </Link>
                ))}
                {d.counterCashDifferencePaise !== 0 && <Badge tone="bad">cash difference {r(d.counterCashDifferencePaise)}</Badge>}
              </div>
            ) : (
              <span className="text-ink-3">Nothing unusual today.</span>
            )}
          </section>

          <div className="grid gap-3 md:grid-cols-3">
            <List title="Top items" to="/reports?tab=profit" rows={d.topItems.map((i) => [i.name, r(i.amount)])} empty="No sales yet." />
            <List title="Top partners" to="/partners?tab=top" rows={d.topPartners.map((p) => [p.name, `${r(p.total)} · ${p.bills}`])} empty="No partner bills today." />
            <section className="flex flex-col gap-1 rounded-[6px] border border-line bg-white p-3 text-sm">
              <div className="flex items-center">
                <b className="flex-1 text-[15px]">Stock & deliveries</b>
                <Link to="/stock" className="text-[13px] underline">Stock</Link>
              </div>
              <Line k="Out of stock" v={String(d.stock.out)} bad={d.stock.out > 0} />
              <Line k="Low stock" v={String(d.stock.low)} />
              {ins.data && <Line k="Run out in 3 days" v={ins.data.daily.runOut3.map((x) => x.name).slice(0, 3).join(', ') || '—'} bad={ins.data.daily.runOut3.length > 0} />}
              <Line k="Deliveries not done" v={`${d.deliveries.pending + d.deliveries.out}`} bad={d.deliveries.pending + d.deliveries.out > 0} />
              {ins.data?.weekly.slowDeadValuePaise != null && <Line k="In slow / dead stock" v={r(ins.data.weekly.slowDeadValuePaise)} />}
            </section>
          </div>

          <section className="flex flex-col gap-2 rounded-[6px] border border-brick bg-white p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <b className="flex-1 text-[15px]">Daily summary</b>
              <span className="inline-flex overflow-hidden rounded-[6px] border border-line-2">
                {(['te', 'en'] as const).map((l) => (
                  <button key={l} type="button" onClick={() => setSumLang(l)} className={cx('px-3 py-1 text-[13px]', sumLang === l ? 'bg-ink font-bold text-white' : 'bg-white')}>
                    {l === 'te' ? 'తెలుగు' : 'English'}
                  </button>
                ))}
              </span>
            </div>
            <p className="text-[13px] text-ink-3">Made automatically at closing time (Settings → shop closes at). Send it to yourself or the family.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" busy={busy} onClick={() => void summary('whatsapp')}>
                WhatsApp
              </Button>
              <Button onClick={() => void summary('email')}>E-mail</Button>
              <Button variant="ghost" onClick={() => void summary('copy')}>
                Copy
              </Button>
            </div>
            <PastSummaries />
          </section>
        </>
      )}
    </Page>
  );
}

function Big({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={cx('rounded-[6px] border bg-white px-3 py-3', strong ? 'border-brick' : 'border-line')}>
      <div className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">{label}</div>
      <div className="num mt-0.5 text-[24px] font-extrabold leading-tight">{value}</div>
      {sub && <div className="text-[12px] text-ink-3">{sub}</div>}
    </div>
  );
}

function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[6px] bg-concrete px-3 py-2">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="num text-[14px] font-bold">{value}</div>
    </div>
  );
}

function Line({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="flex justify-between gap-2 border-t border-line-3 py-1.5 first:border-t-0">
      <span className="shrink-0">{k}</span>
      <span className={cx('num min-w-0 text-right font-bold', bad && 'text-bad')}>{v}</span>
    </div>
  );
}

function List({ title, to, rows, empty }: { title: string; to: string; rows: [string, string][]; empty: string }) {
  return (
    <section className="flex flex-col gap-1 rounded-[6px] border border-line bg-white p-3 text-sm">
      <div className="flex items-center">
        <b className="flex-1 text-[15px]">{title}</b>
        <Link to={to} className="text-[13px] underline">
          More
        </Link>
      </div>
      {rows.length ? rows.map(([a, b], i) => <Line key={i} k={a} v={b} />) : <span className="text-ink-3">{empty}</span>}
    </section>
  );
}

function PastSummaries() {
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: ['owner', 'summaries'], queryFn: () => get<{ date: string; made_at: string; text_en: string }[]>('/api/owner/summaries'), enabled: open });
  return (
    <div>
      <button type="button" className="text-[13px] underline" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} past summaries
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {(list.data ?? []).map((s) => (
            <details key={s.date} className="rounded-[4px] bg-paper px-3 py-2">
              <summary className="cursor-pointer font-semibold">
                {fmtDate(s.date)} <span className="font-normal text-ink-3">· made {fmtDateTime(s.made_at)}</span>
              </summary>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-[13px]">{s.text_en}</pre>
            </details>
          ))}
          {list.data?.length === 0 && <span className="text-ink-3">None yet.</span>}
        </div>
      )}
    </div>
  );
}

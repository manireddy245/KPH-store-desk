import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatPaise, formatPercent, formatQty } from '@kph/core';
import { get } from '../lib/api';
import { MODE_LABEL, fmtDate, fmtDateTime, fmtTime } from '../lib/format';
import { useSession } from '../lib/session';
import { Page } from '../components/Layout';
import { Badge, Card, Empty, Notice, PageTitle, Spinner, cx } from '../components/ui';

interface Dash {
  today: {
    date: string;
    bills: number;
    total_paise: number;
    cash_paise: number;
    upi_paise: number;
    card_paise: number;
    credit_paise: number;
    discount_paise: number;
    cancelled: number;
    collections: { total_paise: number; n: number };
  };
  fy: { bills: number; total_paise: number };
  stock: { products: number; out_of_stock: number; low_stock: number; value_at_cost_paise?: number };
  lowItems: { id: number; name: string; unit_code: string; qty_milli: number; reorder_milli: number }[];
  daily: { date: string; total_paise: number; bills: number }[];
  recent: { id: number; number: string; at: string; customer_name: string | null; payment_mode: string; total_paise: number; status: string; user_name: string; device_name: string | null }[];
  alerts: { id: number; at: string; action: string; details: Record<string, any>; reason: string | null; user_name: string | null; device_name: string | null; approved_by_name: string | null }[];
  lastBackup: { at: string; ok: boolean; kind: string; error: string | null } | null;
  stockMismatchCount: number;
}

const rupees = (p: number) => '₹' + formatPaise(p).replace(/\.\d\d$/, '');

export function Dashboard() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<Dash>('/api/dashboard'), refetchInterval: 60_000 });
  const d = q.data;
  const today = new Date(Date.now() + 5.5 * 3600000);
  const heading = today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  return (
    <Page>
      <PageTitle telugu="ఈ రోజు" title={`Today, ${heading}`} actions={<span className="text-[13px] text-ink-3">Live — updates as counters bill</span>} />
      {!d ? (
        <div className="flex items-center gap-2 p-8 text-ink-3">
          <Spinner /> Loading…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            <Tile label="Sales today" value={rupees(d.today.total_paise)} sub={`${d.today.bills} bills${d.today.cancelled ? ` · ${d.today.cancelled} cancelled` : ''}`} />
            <div className="rounded-[6px] border border-line bg-white p-4">
              <div className="eyebrow">By payment</div>
              <div className="num mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                {(['cash', 'upi', 'card', 'credit'] as const).map((m) => (
                  <Pair key={m} k={MODE_LABEL[m]!} v={rupees(d.today[`${m}_paise`])} />
                ))}
              </div>
            </div>
            <Tile label="Collections today" value={rupees(d.today.collections.total_paise)} sub={`${d.today.collections.n} payment${d.today.collections.n === 1 ? '' : 's'} received`} />
            <div className="rounded-[6px] border border-line bg-white p-4">
              <div className="eyebrow">Stock</div>
              <div className="mt-2 flex items-baseline gap-4">
                <Big n={d.stock.products} label="products" />
                <Link to="/inventory?stock=low">
                  <Big n={d.stock.low_stock} label="low" cls="text-warn" />
                </Link>
                <Link to="/inventory?stock=out">
                  <Big n={d.stock.out_of_stock} label="out" cls="text-bad" />
                </Link>
              </div>
              {d.stock.value_at_cost_paise != null && <div className="num mt-1 text-[13px] text-ink-3">Value at cost {rupees(d.stock.value_at_cost_paise)}</div>}
            </div>
          </div>

          <div className="flex flex-wrap items-start gap-4">
            <Card title="Sales, last 30 days" className="min-w-0 flex-[999_1_560px]" actions={<span className="num text-[13px] text-ink-3">This financial year: {rupees(d.fy.total_paise)} · {d.fy.bills} bills</span>}>
              <SalesChart days={d.daily} />
            </Card>
            {(can('activity.view') || can('settings.manage') || d.stockMismatchCount > 0) && (
            <Card title="Needs your attention" className="flex-[1_1_380px]">
              <div className="flex flex-col gap-2.5">
                {d.stockMismatchCount > 0 && <Notice tone="bad">Stock check found {d.stockMismatchCount} product(s) whose balance doesn’t match the stock ledger. Tell the developer.</Notice>}
                {can('settings.manage') &&
                  (d.lastBackup ? (
                    d.lastBackup.ok ? (
                      <Notice tone="good">
                        <b>Backup OK</b> — {fmtDateTime(d.lastBackup.at)} ({d.lastBackup.kind})
                      </Notice>
                    ) : (
                      <Notice tone="bad">
                        <b>Last backup failed</b> — {fmtDateTime(d.lastBackup.at)}: {d.lastBackup.error}
                      </Notice>
                    )
                  ) : (
                    <Notice tone="warn">No backup has been made yet. Go to Settings → Data &amp; backups.</Notice>
                  ))}
                {d.alerts.map((a) => (
                  <Alert key={a.id} a={a} />
                ))}
                {can('activity.view') && d.alerts.length === 0 && <div className="text-sm text-ink-3">No discounts above limit, cancellations or overrides today.</div>}
              </div>
            </Card>
            )}
          </div>

          <div className="flex flex-wrap items-start gap-4">
            <Card title="Low and out of stock" className="flex-[1_1_380px]">
              {d.lowItems.length === 0 ? (
                <Empty>Everything is above its reorder level.</Empty>
              ) : (
                d.lowItems.map((i) => (
                  <div key={i.id} className="flex justify-between gap-2 border-t border-line-3 py-2.5 text-sm first:border-t-0">
                    <span>{i.name}</span>
                    <span className={cx('num whitespace-nowrap font-bold', i.qty_milli <= 0 ? 'text-bad' : 'text-warn')}>
                      {i.qty_milli <= 0 ? `Out · 0 ${i.unit_code}` : `${formatQty(i.qty_milli)} of ${formatQty(i.reorder_milli)} ${i.unit_code}`}
                    </span>
                  </div>
                ))
              )}
            </Card>
            <Card title="Recent bills" className="min-w-0 flex-[999_1_560px]" actions={<Link to="/sales" className="text-sm font-semibold underline">All sales</Link>}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-sm">
                  <tbody className="[&_td]:border-t [&_td]:border-line-3 [&_td]:py-2.5 [&_td]:pr-2">
                    {d.recent.map((b) => (
                      <tr key={b.id}>
                        <td className="num text-ink-3">{fmtTime(b.at)}</td>
                        <td className="num">
                          <Link to={`/sales?open=${b.id}`} className="font-semibold">
                            {b.number}
                          </Link>
                        </td>
                        <td>{b.customer_name ?? 'Walk-in'}</td>
                        <td className="text-ink-3">{MODE_LABEL[b.payment_mode]}</td>
                        <td className="text-ink-3">
                          {b.user_name} · {b.device_name ?? '—'}
                        </td>
                        <td className="num text-right font-bold">{b.status === 'cancelled' ? <Badge tone="bad">Cancelled</Badge> : rupees(b.total_paise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.recent.length === 0 && <Empty>No bills yet.</Empty>}
              </div>
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-[6px] border border-line bg-white p-4">
      <div className="eyebrow">{label}</div>
      <div className="num mt-1 text-[34px] font-extrabold" style={{ fontStretch: '80%' }}>
        {value}
      </div>
      <div className="text-[13px] text-ink-3">{sub}</div>
    </div>
  );
}
const Pair = ({ k, v }: { k: string; v: string }) => (
  <>
    <span className="text-ink-3">{k}</span>
    <span className="text-right">{v}</span>
  </>
);
const Big = ({ n, label, cls }: { n: number; label: string; cls?: string }) => (
  <div className={cls}>
    <div className="num text-[28px] font-extrabold" style={{ fontStretch: '80%' }}>
      {n}
    </div>
    <div className="text-xs">{label}</div>
  </div>
);

function Alert({ a }: { a: Dash['alerts'][number] }) {
  const who = [a.user_name, a.device_name].filter(Boolean).join(' · ');
  const time = fmtTime(a.at);
  const map: Record<string, { tone: 'warn' | 'bad' | 'neutral'; title: string; text: string }> = {
    'discount.over_limit': { tone: 'warn', title: 'Discount above limit', text: `${a.details.product} at ${formatPercent(a.details.discountBp ?? 0)}% (max ${formatPercent(a.details.maxBp ?? 0)}%) on ${a.details.number}${a.approved_by_name ? `. Approved by ${a.approved_by_name}` : ''}` },
    'invoice.cancelled': { tone: 'bad', title: 'Bill cancelled', text: `${a.details.number}, ${rupees(a.details.totalPaise ?? 0)}. “${a.reason}”${a.approved_by_name ? ` Approved by ${a.approved_by_name}.` : ''}` },
    'receipt.cancelled': { tone: 'bad', title: 'Receipt cancelled', text: `${a.details.number}. “${a.reason}”` },
    'override.approved': { tone: 'neutral', title: 'Admin PIN used', text: `${a.details.permission}${a.approved_by_name ? ` — by ${a.approved_by_name}` : ''}` },
    'stock.adjusted': { tone: 'neutral', title: 'Stock adjusted', text: `${a.details.name} ${a.details.deltaMilli > 0 ? '+' : ''}${formatQty(a.details.deltaMilli ?? 0)}. “${a.reason}”` },
    'product.price_changed': { tone: 'neutral', title: 'Price changed', text: `${a.details.name}` },
    'auth.locked_out': { tone: 'warn', title: 'Too many wrong PINs', text: 'A user was locked out for 5 minutes' },
  };
  const m = map[a.action] ?? { tone: 'neutral' as const, title: a.action, text: '' };
  return (
    <div className={cx('rounded-[4px] p-2.5 text-[13px]', m.tone === 'warn' ? 'bg-warn-soft' : m.tone === 'bad' ? 'bg-bad-soft' : 'bg-concrete')}>
      <b>{m.title}</b> — {m.text}
      <span className="text-ink-3">
        {' '}
        · {who} · {time}
      </span>
    </div>
  );
}

/** 30-day bar chart: one series, Brick Orange bars, hover for the exact day. */
function SalesChart({ days }: { days: Dash['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.total_paise));
  const step = niceStep(max / 100 / 4);
  const top = Math.ceil(max / 100 / step) * step * 100;
  const h = (p: number) => `${(p / top) * 100}%`;
  const label = (paise: number) => (paise >= 10000000 ? `₹${+(paise / 10000000).toFixed(1)}L` : paise >= 100000 ? `₹${+(paise / 100000).toFixed(1)}k` : `₹${Math.round(paise / 100)}`);
  const total = days.reduce((s, d) => s + d.total_paise, 0);
  return (
    <div>
      <div className="mt-2 flex gap-2">
        <div className="num flex h-[200px] w-11 flex-col justify-between text-right text-[11px] text-ink-3">
          <span>{label(top)}</span>
          <span>{label(top / 2)}</span>
          <span>₹0</span>
        </div>
        <div className="relative h-[200px] flex-1 border-b border-line-2" role="img" aria-label={`Daily sales for the last 30 days, total ${rupees(total)}`}>
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-line-3" />
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-line-3" />
          <div className="absolute inset-0 flex items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
            {days.map((d, i) => (
              <div key={d.date} className="relative flex h-full min-w-[6px] flex-1 items-end" onMouseEnter={() => setHover(i)}>
                <div className={cx('w-full rounded-t-[4px]', hover === i ? 'bg-brick-dark' : 'bg-brick')} style={{ height: d.total_paise ? h(d.total_paise) : 0, minHeight: d.total_paise ? 2 : 0 }} />
              </div>
            ))}
          </div>
          {hover != null && days[hover] && (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[4px] bg-ink px-2.5 py-1.5 text-xs text-white shadow-lg"
              style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
            >
              <div className="font-bold">{fmtDate(days[hover].date)}</div>
              <div className="num">
                {rupees(days[hover].total_paise)} · {days[hover].bills} bills
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="ml-[52px] mt-1.5 flex justify-between text-[11px] text-ink-3">
        <span>{fmtDate(days[0]?.date)}</span>
        <span>{fmtDate(days[15]?.date)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function niceStep(x: number) {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1))));
  const n = x / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, formatQty, parseQty } from '@kph/core';
import { ApiError, download, get, patch, post } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, cx, useToast } from '../components/ui';

/**
 * Stock (Phase 6B): smart insights (fast / slow / dead, days left, reorder), purchase orders,
 * and physical stock counts. Nothing is ordered without the owner.
 */

const money = (p: number | null | undefined) => (p == null ? '—' : `₹${formatPaise(p)}`);
const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

export interface InsightRow {
  productId: number;
  name: string;
  sku: string;
  unit: string;
  category: string | null;
  brand: string | null;
  stockMilli: number;
  valuePaise: number | null;
  soldMilli: number;
  soldPaise: number;
  prevSoldMilli: number;
  lastSale: string | null;
  daysSinceSale: number | null;
  movement: 'fast' | 'normal' | 'slow' | 'dead' | 'new';
  dailyMilli: number;
  seasonal: boolean;
  daysLeft: number | null;
  onOrderMilli: number;
  leadDays: number;
  targetDays: number;
  supplierId: number | null;
  supplierName: string | null;
  orderNow: boolean;
  suggestMilli: number;
  why: string;
  usualMaxMilli: number;
  decision: { action: string; note: string | null; at: string } | null;
}

export interface Insights {
  asOf: string;
  periodDays: number;
  deadDays: number;
  seasonal: boolean;
  rows: InsightRow[];
  daily: { runOut3: InsightRow[]; runOut7: InsightRow[]; fastBelowTarget: InsightRow[]; topSlowByValue: InsightRow[]; newlyDead: InsightRow[] };
  weekly: { spedUp: (InsightRow & { ratio: number })[]; slowedDown: (InsightRow & { ratio: number })[]; slowDeadValuePaise: number | null; slowDeadItems: number };
}

const MOVE: Record<string, { label: string; tone: 'good' | 'neutral' | 'warn' | 'bad' | 'teal' }> = {
  fast: { label: 'Fast', tone: 'good' },
  normal: { label: 'Normal', tone: 'neutral' },
  slow: { label: 'Slow', tone: 'warn' },
  dead: { label: 'Dead', tone: 'bad' },
  new: { label: 'New', tone: 'teal' },
};
const ACTIONS: Record<string, string> = { dont_reorder: "Don't reorder", offer: 'Run an offer', tell_partners: 'Tell painters / masons', return_to_supplier: 'Return to supplier', keep: 'Keep as is' };

type Tab = 'reorder' | 'slow' | 'all' | 'orders' | 'count';

export function Stock() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'reorder';
  const ins = useQuery({ queryKey: ['stock', 'insights'], queryFn: () => get<Insights>('/api/insights/stock'), enabled: tab !== 'count' && tab !== 'orders' });
  const TABS: [Tab, string][] = [
    ['reorder', 'Reorder'],
    ['slow', 'Slow & dead'],
    ['all', 'All items'],
    ['orders', 'Purchase orders'],
    ['count', 'Stock count'],
  ];
  return (
    <Page wide>
      <PageTitle telugu="సరుకు నిర్వహణ" title="Stock" sub="How fast things sell, what to reorder, money stuck in slow stock, purchase orders and stock counts." />
      <nav aria-label="Stock" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setParams({ tab: id })} className={cx('h-11 px-3 text-sm', tab === id ? 'font-bold text-ink shadow-[inset_0_-3px_0_#c2491a]' : 'text-ink-3 hover:text-ink')}>
            {label}
          </button>
        ))}
      </nav>
      {(tab === 'reorder' || tab === 'slow' || tab === 'all') && (!ins.data ? ins.error ? <Notice tone="bad">{errText(ins.error)}</Notice> : <Spinner /> : tab === 'reorder' ? <Reorder d={ins.data} /> : tab === 'slow' ? <Slow d={ins.data} /> : <AllItems d={ins.data} />)}
      {tab === 'orders' && <Orders />}
      {tab === 'count' && <Counts />}
    </Page>
  );
}

const Why = ({ r }: { r: InsightRow }) => <div className="text-[12px] text-ink-3">{r.why}</div>;

// ------------------------------------------------------------------ reorder

function Reorder({ d }: { d: Insights }) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const list = useMemo(() => d.rows.filter((r) => r.suggestMilli > 0).sort((a, b) => Number(b.orderNow) - Number(a.orderNow) || (a.daysLeft ?? 999) - (b.daysLeft ?? 999)), [d]);
  const suppliers = useQuery({ queryKey: ['suppliers', 'all'], queryFn: () => get<{ id: number; name: string; active: boolean }[]>('/api/suppliers') });
  const [pick, setPick] = useState<Record<number, { on: boolean; qty: string; supplierId: number | '' }>>({});
  useEffect(() => {
    setPick(Object.fromEntries(list.map((r) => [r.productId, { on: r.orderNow, qty: String(r.suggestMilli / 1000), supplierId: r.supplierId ?? '' }])));
  }, [list]);
  const [busy, setBusy] = useState(false);
  const chosen = list.filter((r) => pick[r.productId]?.on);

  const make = async () => {
    const items = chosen.map((r) => ({ productId: r.productId, qtyMilli: parseQty(pick[r.productId]!.qty) ?? 0, supplierId: Number(pick[r.productId]!.supplierId) }));
    if (items.some((i) => !i.supplierId)) return toast({ tone: 'bad', text: 'Choose a supplier for every ticked item' });
    setBusy(true);
    try {
      const made = await post<{ number: string }[]>('/api/purchase-orders', { items });
      toast({ tone: 'good', text: `Draft orders made: ${made.map((m) => m.number).join(', ')}. Check and send them.` });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      setParams({ tab: 'orders' });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Summary d={d} />
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          <h2 className="flex-1 text-[15px] font-bold">Suggested to reorder ({list.length})</h2>
          {can('stock.adjust') && (
            <Button variant="primary" busy={busy} disabled={!chosen.length} onClick={() => void make()}>
              Make draft orders ({chosen.length})
            </Button>
          )}
        </div>
        {list.length ? (
          <Table head={<tr><th /><th>Item</th><th className="text-right">Days left</th><th className="text-right">Order</th><th>Supplier</th></tr>}>
            {list.map((r) => {
              const p = pick[r.productId] ?? { on: false, qty: '', supplierId: '' };
              return (
                <tr key={r.productId}>
                  <td>
                    <input type="checkbox" aria-label={`Order ${r.name}`} checked={p.on} onChange={(e) => setPick((x) => ({ ...x, [r.productId]: { ...p, on: e.target.checked } }))} />
                  </td>
                  <td>
                    <b>{r.name}</b> <Badge tone={MOVE[r.movement]!.tone}>{MOVE[r.movement]!.label}</Badge> {r.orderNow && <Badge tone="bad">order now</Badge>}
                    <Why r={r} />
                  </td>
                  <td className={cx('num text-right font-bold', r.orderNow && 'text-bad')}>{r.daysLeft ?? '—'}</td>
                  <td className="text-right">
                    <span className="inline-flex items-center gap-1">
                      <Input aria-label={`Quantity of ${r.name}`} inputMode="decimal" className="num w-[90px] text-right" value={p.qty} onChange={(e) => setPick((x) => ({ ...x, [r.productId]: { ...p, qty: e.target.value } }))} />
                      <span className="text-[12px] text-ink-3">{r.unit}</span>
                    </span>
                  </td>
                  <td>
                    <Select aria-label={`Supplier for ${r.name}`} value={p.supplierId} onChange={(e) => setPick((x) => ({ ...x, [r.productId]: { ...p, supplierId: e.target.value ? Number(e.target.value) : '' } }))}>
                      <option value="">Choose…</option>
                      {(suppliers.data ?? []).filter((s) => s.active).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty>Nothing needs reordering right now.</Empty>
        )}
      </section>
      <p className="text-[12px] text-ink-3">
        Based on the last {d.periodDays} days of sales{d.seasonal ? ', adjusted by the same season last year' : ''}. Each suggestion covers the supplier's delivery days plus the category's target days of stock (set per category; default 15), less what is in stock and already on order. Nothing is ordered until you send a purchase order.
      </p>
    </div>
  );
}

function Summary({ d }: { d: Insights }) {
  const Tile = ({ label, items, tone }: { label: string; items: InsightRow[]; tone?: 'bad' | 'warn' }) => (
    <div className={cx('rounded-[6px] border bg-white px-3 py-2.5', tone === 'bad' && items.length ? 'border-brick' : 'border-line')}>
      <div className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">{label}</div>
      <div className={cx('num text-[20px] font-extrabold', tone === 'bad' && items.length > 0 && 'text-bad')}>{items.length}</div>
      <div className="truncate text-[12px] text-ink-3">{items.slice(0, 3).map((r) => r.name).join(', ')}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <Tile label="Run out in 3 days" items={d.daily.runOut3} tone="bad" />
      <Tile label="Run out in 7 days" items={d.daily.runOut7} tone="warn" />
      <Tile label="Fast movers below target" items={d.daily.fastBelowTarget} />
      <Tile label="Newly dead" items={d.daily.newlyDead} />
      <div className="rounded-[6px] border border-line bg-white px-3 py-2.5">
        <div className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">Money in slow & dead stock</div>
        <div className="num text-[20px] font-extrabold">{money(d.weekly.slowDeadValuePaise)}</div>
        <div className="text-[12px] text-ink-3">{d.weekly.slowDeadItems} items</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ slow & dead

function Slow({ d }: { d: Insights }) {
  const toast = useToast();
  const qc = useQueryClient();
  const rows = d.rows.filter((r) => r.movement === 'slow' || r.movement === 'dead').sort((a, b) => (b.valuePaise ?? 0) - (a.valuePaise ?? 0));
  const decide = async (productId: number, action: string) => {
    try {
      await post('/api/insights/decisions', { productId, action });
      void qc.invalidateQueries({ queryKey: ['stock', 'insights'] });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="teal">
        Slow = selling well below similar items; dead = no sale for {d.deadDays} days. The value is money stuck at cost. Choose what to do — the choice is remembered, and "Don't reorder" removes the item from reorder suggestions.
      </Notice>
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">
        {rows.length ? (
          <Table head={<tr><th>Item</th><th className="text-right">In stock</th><th className="text-right">Value at cost</th><th>Last sale</th><th>What to do</th></tr>}>
            {rows.map((r) => (
              <tr key={r.productId}>
                <td>
                  <b>{r.name}</b> <Badge tone={MOVE[r.movement]!.tone}>{MOVE[r.movement]!.label}</Badge>
                  <Why r={r} />
                </td>
                <td className="num text-right">
                  {formatQty(r.stockMilli)} {r.unit}
                </td>
                <td className="num text-right font-bold">{money(r.valuePaise)}</td>
                <td className="num">{r.lastSale ? `${fmtDate(r.lastSale)} (${r.daysSinceSale} d)` : 'never'}</td>
                <td>
                  <Select aria-label={`What to do with ${r.name}`} value={r.decision?.action ?? ''} onChange={(e) => e.target.value && void decide(r.productId, e.target.value)}>
                    <option value="">Choose…</option>
                    {Object.entries(ACTIONS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                  {r.decision && <div className="text-[11px] text-ink-3">decided {fmtDate(r.decision.at.slice(0, 10))}</div>}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No slow or dead stock.</Empty>
        )}
      </section>
      {(d.weekly.spedUp.length > 0 || d.weekly.slowedDown.length > 0) && (
        <section className="rounded-[6px] border border-line bg-white p-3 text-sm">
          <b>Movement changes vs the {d.periodDays} days before</b>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <div>
              <div className="text-[12px] font-bold uppercase tracking-[.1em] text-good">Sped up</div>
              {d.weekly.spedUp.map((r) => (
                <div key={r.productId}>
                  {r.name} <span className="num text-ink-3">× {r.ratio >= 9 ? 'new' : r.ratio.toFixed(1)}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[12px] font-bold uppercase tracking-[.1em] text-bad">Slowed down</div>
              {d.weekly.slowedDown.map((r) => (
                <div key={r.productId}>
                  {r.name} <span className="num text-ink-3">× {r.ratio.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ all items

function AllItems({ d }: { d: Insights }) {
  const toast = useToast();
  const [move, setMove] = useState<string>('');
  const [q, setQ] = useState('');
  const rows = d.rows.filter((r) => (!move || r.movement === move) && (!q || r.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-[260px]" />
        <Select value={move} onChange={(e) => setMove(e.target.value)} className="max-w-[180px]">
          <option value="">All movements</option>
          {Object.entries(MOVE).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        <Button className="ml-auto" onClick={() => download('/api/insights/stock?format=xlsx', 'stock-movement.xlsx').catch((e) => toast({ tone: 'bad', text: errText(e) }))}>
          Download Excel
        </Button>
      </div>
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">
        <Table head={<tr><th>Item</th><th>Movement</th><th className="text-right">In stock</th><th className="text-right">Sold ({d.periodDays} d)</th><th className="text-right">Per day</th><th className="text-right">Days left</th><th className="text-right">Value</th></tr>}>
          {rows.map((r) => (
            <tr key={r.productId}>
              <td>
                {r.name}
                <span className="block text-[12px] text-ink-3">{[r.category, r.brand].filter(Boolean).join(' · ')}</span>
              </td>
              <td>
                <Badge tone={MOVE[r.movement]!.tone}>{MOVE[r.movement]!.label}</Badge>
              </td>
              <td className="num text-right">
                {formatQty(r.stockMilli)} {r.unit}
              </td>
              <td className="num text-right">{formatQty(r.soldMilli)}</td>
              <td className="num text-right">{formatQty(r.dailyMilli)}</td>
              <td className={cx('num text-right', r.daysLeft != null && r.daysLeft <= r.leadDays + 2 && 'font-bold text-bad')}>{r.daysLeft ?? '—'}</td>
              <td className="num text-right">{money(r.valuePaise)}</td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ purchase orders

interface PO {
  id: number;
  number: string;
  status: 'draft' | 'sent' | 'received' | 'cancelled';
  created_at: string;
  sent_at: string | null;
  supplier_name: string;
  supplier_phone: string | null;
  items: number;
}

function Orders() {
  const toast = useToast();
  const [status, setStatus] = useState<string>('');
  const list = useQuery({ queryKey: ['stock', 'pos', status], queryFn: () => get<PO[]>(`/api/purchase-orders${status ? `?status=${status}` : ''}`) });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[200px]">
          <option value="">All orders</option>
          <option value="draft">Drafts</option>
          <option value="sent">Sent</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
        </Select>
      </div>
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">
        {(list.data ?? []).length ? (
          <Table head={<tr><th>Order</th><th>Supplier</th><th className="text-right">Items</th><th>Status</th><th>Made</th></tr>}>
            {list.data!.map((p) => (
              <tr key={p.id} className="cursor-pointer hover:bg-paper" onClick={() => setOpen(p.id)}>
                <td className="num font-semibold">{p.number}</td>
                <td>{p.supplier_name}</td>
                <td className="num text-right">{p.items}</td>
                <td>
                  <Badge tone={p.status === 'draft' ? 'warn' : p.status === 'sent' ? 'teal' : p.status === 'received' ? 'good' : 'neutral'}>{p.status}</Badge>
                </td>
                <td className="num">{fmtDateTime(p.created_at)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No purchase orders. Make them from the Reorder tab.</Empty>
        )}
      </section>
      {open != null && <OrderModal id={open} onClose={() => (setOpen(null), void list.refetch())} toast={toast} />}
    </div>
  );
}

function OrderModal({ id, onClose, toast }: { id: number; onClose: () => void; toast: ReturnType<typeof useToast> }) {
  const q = useQuery({ queryKey: ['stock', 'po', id], queryFn: () => get<PO & { lines: { product_id: number; name: string; unit_code: string; qty_milli: number; stock_milli: number }[] }>(`/api/purchase-orders/${id}`) });
  const [qty, setQty] = useState<Record<number, string>>({});
  useEffect(() => {
    if (q.data) setQty(Object.fromEntries(q.data.lines.map((l) => [l.product_id, String(l.qty_milli / 1000)])));
  }, [q.data]);
  const d = q.data;
  const act = async (body: Record<string, unknown>) => {
    try {
      await patch(`/api/purchase-orders/${id}`, body);
      void q.refetch();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  const send = async () => {
    const w = window.open('', '_blank');
    try {
      const m = await get<{ text: string }>(`/api/purchase-orders/${id}/message`);
      const phone = (d?.supplier_phone ?? '').replace(/\D/g, '').slice(-10);
      const url = `https://wa.me/${phone.length === 10 ? `91${phone}` : ''}?text=${encodeURIComponent(m.text)}`;
      if (w) w.location.href = url;
      await act({ status: 'sent' });
    } catch (e) {
      w?.close();
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  return (
    <Modal open onClose={onClose} title={d ? `${d.number} · ${d.supplier_name}` : 'Purchase order'} width={720} footer={d && <>
      <Button variant="ghost" onClick={() => window.open(`/print/po/${id}`, '_blank')}>Print</Button>
      {d.status === 'draft' && <Button onClick={() => void act({ lines: d.lines.map((l) => ({ productId: l.product_id, qtyMilli: parseQty(qty[l.product_id] ?? '') ?? 0 })) })}>Save changes</Button>}
      {(d.status === 'draft' || d.status === 'sent') && <Button variant="ghost" onClick={() => void act({ status: 'cancelled' })}>Cancel order</Button>}
      {d.status === 'sent' && <Button variant="dark" onClick={() => void act({ status: 'received' })}>Mark received</Button>}
      {d.status === 'draft' && <Button variant="primary" onClick={() => void send()}>Send on WhatsApp</Button>}
    </>}>
      {!d ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <Badge tone={d.status === 'draft' ? 'warn' : 'teal'}>{d.status}</Badge>
          <Table minWidth={480} head={<tr><th>Item</th><th className="text-right">In stock</th><th className="text-right">Order</th></tr>}>
            {d.lines.map((l) => (
              <tr key={l.product_id}>
                <td>{l.name}</td>
                <td className="num text-right">{formatQty(l.stock_milli)}</td>
                <td className="text-right">
                  {d.status === 'draft' ? (
                    <Input aria-label={`Order ${l.name}`} inputMode="decimal" className="num ml-auto w-[100px] text-right" value={qty[l.product_id] ?? ''} onChange={(e) => setQty((x) => ({ ...x, [l.product_id]: e.target.value }))} />
                  ) : (
                    <span className="num font-bold">
                      {formatQty(l.qty_milli)} {l.unit_code}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <p className="text-[12px] text-ink-3">When the goods arrive, enter the supplier's bill in Purchases as usual, then mark this order received.</p>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ stock count

interface AuditView {
  id: number;
  number: string;
  title: string | null;
  category: string | null;
  status: string;
  started_at: string;
  items: { product_id: number; name: string; sku: string; unit_code: string; category: string | null; book_milli: number; line_id: number | null; system_milli: number | null; counted_milli: number | null; reason: string | null; note: string | null; diff_milli: number | null; counted_by: string | null }[];
  summary: { products: number; counted: number; differences: number; shortValuePaise: number | null; excessValuePaise: number | null };
}

function Counts() {
  const { can } = useSession();
  const toast = useToast();
  const list = useQuery({ queryKey: ['stock', 'audits'], queryFn: () => get<{ id: number; number: string; title: string | null; category: string | null; status: string; started_at: string; counted: number; differences: number; user_name: string }[]>('/api/stock-audits') });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => get<{ id: number; name: string }[]>('/api/categories') });
  const [open, setOpen] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [cat, setCat] = useState('');
  const start = async () => {
    try {
      const r = await post<{ id: number }>('/api/stock-audits', { title: title || undefined, categoryId: cat ? Number(cat) : null });
      setTitle('');
      void list.refetch();
      setOpen(r.id);
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {can('stock.adjust') && (
        <div className="flex flex-wrap items-end gap-2 rounded-[6px] border border-line bg-white p-3">
          <Field label="New stock count">
            <Input placeholder="e.g. Godown, October" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Only one category (optional)">
            <Select value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">All items</option>
              {(cats.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" onClick={() => void start()}>
            Start counting
          </Button>
        </div>
      )}
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">
        {(list.data ?? []).length ? (
          <Table head={<tr><th>Count</th><th>What</th><th className="text-right">Counted</th><th className="text-right">Differences</th><th>Status</th><th>Started</th></tr>}>
            {list.data!.map((a) => (
              <tr key={a.id} className="cursor-pointer hover:bg-paper" onClick={() => setOpen(a.id)}>
                <td className="num font-semibold">{a.number}</td>
                <td>{a.title ?? a.category ?? 'All items'}</td>
                <td className="num text-right">{a.counted}</td>
                <td className={cx('num text-right', a.differences > 0 && 'font-bold text-bad')}>{a.differences}</td>
                <td>
                  <Badge tone={a.status === 'open' ? 'warn' : 'good'}>{a.status}</Badge>
                </td>
                <td className="num">
                  {fmtDateTime(a.started_at)} · {a.user_name}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No stock counts yet.</Empty>
        )}
      </section>
      {open != null && <CountSheet id={open} onClose={() => (setOpen(null), void list.refetch())} />}
    </div>
  );
}

const REASONS = ['damaged', 'leakage', 'shortage', 'found', 'wrong entry', 'other'];

function CountSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock', 'audit', id], queryFn: () => get<AuditView>(`/api/stock-audits/${id}`) });
  const [search, setSearch] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [draft, setDraft] = useState<Record<number, { qty: string; reason: string }>>({});
  const d = q.data;
  const open = d?.status === 'open' && can('stock.adjust');

  const save = async (productId: number, qtyText: string, reason: string) => {
    const counted = parseQty(qtyText);
    if (counted == null) return;
    try {
      await post(`/api/stock-audits/${id}/count`, { productId, countedMilli: counted, reason: reason || null });
      void q.refetch();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  const close = async () => {
    try {
      const r = await post<{ adjusted: number }>(`/api/stock-audits/${id}/close`);
      toast({ tone: 'good', text: `Stock count closed — ${r.adjusted} adjustment${r.adjusted === 1 ? '' : 's'} posted` });
      void qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };

  const rows = (d?.items ?? []).filter((i) => (!search || i.name.toLowerCase().includes(search.toLowerCase()) || i.sku.toLowerCase().includes(search.toLowerCase())) && (!onlyDiff || (i.diff_milli ?? 0) !== 0));
  return (
    <Modal open onClose={onClose} title={d ? `${d.number} · ${d.title ?? d.category ?? 'All items'}` : 'Stock count'} width={980} footer={d && <>
      <span className="mr-auto text-sm">
        {d.summary.counted} of {d.summary.products} counted · <b className={cx(d.summary.differences > 0 && 'text-bad')}>{d.summary.differences} differences</b>
        {d.summary.shortValuePaise != null && d.summary.differences > 0 && <> · short {money(d.summary.shortValuePaise)} · excess {money(d.summary.excessValuePaise)}</>}
      </span>
      {open && <Button variant="primary" onClick={() => void close()}>Close count & adjust stock</Button>}
    </>}>
      {!d ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Search item or SKU…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[300px]" autoFocus />
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only differences
            </label>
          </div>
          <Table head={<tr><th>Item</th><th className="text-right">Books say</th><th className="text-right">Counted</th><th className="text-right">Difference</th><th>Reason</th></tr>}>
            {rows.map((i) => {
              const dr = draft[i.product_id] ?? { qty: i.counted_milli != null ? String(i.counted_milli / 1000) : '', reason: i.reason ?? '' };
              return (
                <tr key={i.product_id}>
                  <td>
                    {i.name}
                    <span className="block text-[12px] text-ink-3">{i.sku}{i.counted_by ? ` · counted by ${i.counted_by}` : ''}</span>
                  </td>
                  <td className="num text-right">
                    {formatQty(i.system_milli ?? i.book_milli)} {i.unit_code}
                  </td>
                  <td className="text-right">
                    {open ? (
                      <Input
                        aria-label={`Counted ${i.name}`}
                        inputMode="decimal"
                        className="num ml-auto w-[90px] text-right"
                        value={dr.qty}
                        onChange={(e) => setDraft((x) => ({ ...x, [i.product_id]: { ...dr, qty: e.target.value } }))}
                        onBlur={() => dr.qty !== (i.counted_milli != null ? String(i.counted_milli / 1000) : '') && void save(i.product_id, dr.qty, dr.reason)}
                      />
                    ) : (
                      <span className="num">{i.counted_milli != null ? formatQty(i.counted_milli) : '—'}</span>
                    )}
                  </td>
                  <td className={cx('num text-right font-bold', (i.diff_milli ?? 0) < 0 && 'text-bad', (i.diff_milli ?? 0) > 0 && 'text-good')}>
                    {i.diff_milli == null ? '' : i.diff_milli === 0 ? '✓' : `${i.diff_milli > 0 ? '+' : ''}${formatQty(i.diff_milli)}`}
                  </td>
                  <td>
                    {(i.diff_milli ?? 0) !== 0 &&
                      (open ? (
                        <Select aria-label={`Reason for ${i.name}`} value={dr.reason} onChange={(e) => (setDraft((x) => ({ ...x, [i.product_id]: { ...dr, reason: e.target.value } })), void save(i.product_id, dr.qty, e.target.value))} className={cx(!dr.reason && 'border-bad')}>
                          <option value="">Reason…</option>
                          {REASONS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        i.reason
                      ))}
                  </td>
                </tr>
              );
            })}
          </Table>
          <p className="text-[12px] text-ink-3">Type what is on the shelf; it saves when you leave the box. The book figure is taken at that moment, so sales during the count don't upset it. Closing posts one adjustment per difference, with its reason.</p>
        </div>
      )}
    </Modal>
  );
}

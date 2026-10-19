import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, formatQty, parseQty, parseRupees } from '@kph/core';
import { ApiError, get, post, put } from '../lib/api';
import { MODE_LABEL, fmtDate, fmtDateTime, todayIst, uuid } from '../lib/format';
import { useSession } from '../lib/session';
import type { ProductRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, cx, useToast } from '../components/ui';

/**
 * Operations (Phase 6A): today's rates, quotations / estimates, deliveries and cement stock age.
 */

const money = (p: number) => `₹${formatPaise(p)}`;
const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');
const STAGES = ['Foundation & structure', 'Plumbing & wiring', 'Tiles & walls', 'Final coat'];

type Tab = 'rates' | 'quotes' | 'deliveries' | 'age';

export function Operations() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'deliveries';
  const TABS: [Tab, string][] = [
    ['deliveries', 'Deliveries'],
    ['quotes', 'Quotations'],
    ['rates', "Today's rates"],
    ['age', 'Cement age'],
  ];
  return (
    <Page wide>
      <PageTitle telugu="రోజువారీ పనులు" title="Operations" sub="Deliveries, quotations, today's cement and steel rates, and old cement stock." />
      <nav aria-label="Operations" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setParams({ tab: id })} className={cx('h-11 px-3 text-sm', tab === id ? 'font-bold text-ink shadow-[inset_0_-3px_0_#c2491a]' : 'text-ink-3 hover:text-ink')}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'rates' && <Rates />}
      {tab === 'quotes' && <Quotes />}
      {tab === 'deliveries' && <Deliveries />}
      {tab === 'age' && <CementAge />}
    </Page>
  );
}

// ------------------------------------------------------------------ rates

interface RateRow {
  id: number;
  name: string;
  unit_code: string;
  sale_price_paise: number;
  price_includes_tax: boolean;
  gst_rate_bp: number;
  incl_paise: number;
  category: string | null;
  qty_milli: number;
  changed_at: string | null;
  previous_paise: number | null;
}

function Rates() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ['ops', 'rates'], queryFn: () => get<RateRow[]>('/api/rate-board') });
  const products = useQuery({ queryKey: ['products', 'billing'], queryFn: () => get<ProductRow[]>('/api/products'), enabled: can('products.edit_price') });
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [addId, setAddId] = useState('');
  const admin = can('products.edit_price');

  const save = async () => {
    const rates = Object.entries(edits)
      .map(([id, v]) => ({ productId: Number(id), salePricePaise: parseRupees(v) }))
      .filter((r): r is { productId: number; salePricePaise: number } => r.salePricePaise != null);
    setBusy(true);
    try {
      const r = await put<{ changed: number }>('/api/rate-board', { rates });
      toast({ tone: 'good', text: `${r.changed} price${r.changed === 1 ? '' : 's'} updated` });
      setEdits({});
      void qc.invalidateQueries({ queryKey: ['ops'] });
      void qc.invalidateQueries({ queryKey: ['products'] });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const share = async (lang: 'te' | 'en') => {
    const w = window.open('', '_blank');
    try {
      const m = await get<{ text: string }>(`/api/rate-board/message?lang=${lang}`);
      const url = `https://wa.me/?text=${encodeURIComponent(m.text)}`;
      if (w) w.location.href = url;
      else window.location.href = url;
    } catch (e) {
      w?.close();
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  const toggle = async (productId: number, on: boolean) => {
    await post('/api/rate-board/products', { productId, on }).catch((e) => toast({ tone: 'bad', text: errText(e) }));
    setAddId('');
    void qc.invalidateQueries({ queryKey: ['ops', 'rates'] });
  };

  const rows = board.data ?? [];
  const onBoard = new Set(rows.map((r) => r.id));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void share('te')}>Share rates on WhatsApp (తెలుగు)</Button>
        <Button onClick={() => void share('en')}>Share (English)</Button>
        {admin && Object.keys(edits).length > 0 && (
          <Button variant="primary" busy={busy} onClick={() => void save()} className="ml-auto">
            Save {Object.keys(edits).length} new price{Object.keys(edits).length === 1 ? '' : 's'}
          </Button>
        )}
      </div>
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">
        {board.isLoading ? (
          <div className="p-4"><Spinner /></div>
        ) : rows.length ? (
          <Table head={<tr><th>Product</th><th className="text-right">In stock</th><th className="text-right">Price {admin && '(edit)'}</th><th className="text-right">With GST</th><th>Last change</th>{admin && <th />}</tr>}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.name}</b>
                  <span className="block text-[12px] text-ink-3">{r.category}</span>
                </td>
                <td className="num text-right">{formatQty(r.qty_milli)} {r.unit_code}</td>
                <td className="text-right">
                  {admin ? (
                    <Input
                      aria-label={`Price of ${r.name}`}
                      inputMode="decimal"
                      className={cx('num ml-auto w-[120px] text-right', edits[r.id] != null && 'border-brick')}
                      value={edits[r.id] ?? (r.sale_price_paise / 100).toFixed(2)}
                      onChange={(e) => setEdits((x) => ({ ...x, [r.id]: e.target.value }))}
                    />
                  ) : (
                    <span className="num">{money(r.sale_price_paise)}</span>
                  )}
                  <span className="block text-[11px] text-ink-3">{r.price_includes_tax ? 'incl. GST' : 'excl. GST'} / {r.unit_code}</span>
                </td>
                <td className="num text-right font-bold">{money(r.incl_paise)}</td>
                <td className="num text-[12px] text-ink-3">
                  {r.changed_at ? fmtDateTime(r.changed_at) : '—'}
                  {r.previous_paise != null && <span className="block">was {money(r.previous_paise)}</span>}
                </td>
                {admin && (
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => void toggle(r.id, false)}>
                      Remove
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No products on the rate board yet.</Empty>
        )}
      </section>
      {admin && (
        <div className="flex max-w-[560px] gap-2">
          <Select value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">Add a product to the rate board…</option>
            {(products.data ?? []).filter((p) => !onBoard.has(p.id)).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button disabled={!addId} onClick={() => void toggle(Number(addId), true)}>
            Add
          </Button>
        </div>
      )}
      <p className="text-[12px] text-ink-3">Every price change is kept with who changed it. The WhatsApp message lists the rates including GST, rounded to the rupee; WhatsApp asks whom to send it to (pick your contractors or a group).</p>
    </div>
  );
}

// ------------------------------------------------------------------ quotations

interface QuoteListRow {
  id: number;
  number: string;
  quote_date: string;
  valid_until: string;
  customer_name: string | null;
  site: string | null;
  template: string | null;
  total_paise: number;
  status: string;
  expired: boolean;
  invoice_number: string | null;
  partner_name: string | null;
  items: number;
}

function Quotes() {
  const toast = useToast();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'open' | 'converted' | 'cancelled' | ''>('open');
  const list = useQuery({ queryKey: ['ops', 'quotes', status], queryFn: () => get<QuoteListRow[]>(`/api/quotes${status ? `?status=${status}` : ''}`) });
  const [editing, setEditing] = useState<number | 'new' | 'full_house' | null>(null);
  const [converting, setConverting] = useState<QuoteListRow | null>(null);

  const share = async (q: QuoteListRow) => {
    const text = `Quotation ${q.number}${q.customer_name ? ` for ${q.customer_name}` : ''}${q.site ? ` (${q.site})` : ''}: ${q.items} items, total ${money(q.total_paise)} including GST. Valid till ${fmtDate(q.valid_until)}.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  };
  const cancel = async (q: QuoteListRow) => {
    await post(`/api/quotes/${q.id}/cancel`).catch((e) => toast({ tone: 'bad', text: errText(e) }));
    void list.refetch();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setEditing('new')}>
          + New quotation
        </Button>
        <Button onClick={() => setEditing('full_house')}>+ Full House estimate</Button>
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="ml-auto max-w-[180px]">
          <option value="open">Open</option>
          <option value="converted">Turned into bills</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </Select>
      </div>
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">
        {list.isLoading ? (
          <div className="p-4"><Spinner /></div>
        ) : (list.data ?? []).length ? (
          <Table head={<tr><th>Quote</th><th>Customer / site</th><th className="text-right">Items</th><th className="text-right">Total</th><th>Valid till</th><th /></tr>}>
            {list.data!.map((q) => (
              <tr key={q.id}>
                <td className="num font-semibold">
                  {q.number}
                  {q.template === 'full_house' && <Badge tone="teal">Full House</Badge>}
                  <span className="block text-[12px] font-normal text-ink-3">{fmtDate(q.quote_date)}</span>
                </td>
                <td>
                  {q.customer_name ?? '—'}
                  {q.site && <span className="block text-[12px] text-ink-3">{q.site}</span>}
                  {q.partner_name && <span className="block text-[12px] text-ink-3">via {q.partner_name}</span>}
                </td>
                <td className="num text-right">{q.items}</td>
                <td className="num text-right font-bold">{money(q.total_paise)}</td>
                <td className="num">
                  {q.status === 'converted' ? <Badge tone="good">Bill {q.invoice_number}</Badge> : q.status === 'cancelled' ? <Badge>Cancelled</Badge> : q.expired ? <Badge tone="warn">expired {fmtDate(q.valid_until)}</Badge> : fmtDate(q.valid_until)}
                </td>
                <td className="whitespace-nowrap text-right">
                  <span className="inline-flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => window.open(`/print/quote/${q.id}`, '_blank')}>
                      Print
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void share(q)}>
                      WhatsApp
                    </Button>
                    {q.status === 'open' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(q.id)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void cancel(q)}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="primary" onClick={() => setConverting(q)}>
                          Make bill
                        </Button>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No quotations here.</Empty>
        )}
      </section>
      {editing != null && <QuoteEditor id={typeof editing === 'number' ? editing : null} template={editing === 'full_house' ? 'full_house' : null} onClose={() => (setEditing(null), void list.refetch())} />}
      {converting && <ConvertQuote quote={converting} onClose={() => setConverting(null)} onDone={(id) => (setConverting(null), void list.refetch(), navigate(`/sales?open=${id}`))} />}
    </div>
  );
}

interface QLine {
  key: string;
  stage: string;
  productId: number | '';
  qty: string;
  rate: string;
  disc: string;
}

function QuoteEditor({ id, template, onClose }: { id: number | null; template: 'full_house' | null; onClose: () => void }) {
  const toast = useToast();
  const products = useQuery({ queryKey: ['products', 'billing'], queryFn: () => get<ProductRow[]>('/api/products') });
  const existing = useQuery({ queryKey: ['ops', 'quote', id], queryFn: () => get<Record<string, unknown> & { lines: { stage: string | null; product_id: number; qty_milli: number; rate_paise: number; discount_bp: number }[] }>(`/api/quotes/${id}`), enabled: id != null });
  const [f, setF] = useState({ customerName: '', customerPhone: '', customerAddress: '', site: '', validUntil: '', notes: '' });
  const [isFullHouse, setFullHouse] = useState(template === 'full_house');
  const emptyLine = (stage = ''): QLine => ({ key: uuid(), stage, productId: '', qty: '', rate: '', disc: '' });
  const [lines, setLines] = useState<QLine[]>(() => (template === 'full_house' ? STAGES.map((s) => emptyLine(s)) : [emptyLine()]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = existing.data;
    if (!q) return;
    setF({
      customerName: String(q.display_name ?? q.customer_name ?? ''),
      customerPhone: String(q.display_phone ?? ''),
      customerAddress: String(q.display_address ?? ''),
      site: String(q.site ?? ''),
      validUntil: String(q.valid_until ?? ''),
      notes: String(q.notes ?? ''),
    });
    setFullHouse(q.template === 'full_house');
    setLines(q.lines.map((l) => ({ key: uuid(), stage: l.stage ?? '', productId: l.product_id, qty: String(l.qty_milli / 1000), rate: (l.rate_paise / 100).toFixed(2), disc: l.discount_bp ? String(l.discount_bp / 100) : '' })));
  }, [existing.data]);

  const byId = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);
  const set = (key: string, patch: Partial<QLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const filled = lines.filter((l) => l.productId && parseQty(l.qty));
  const roughTotal = filled.reduce((t, l) => {
    const p = byId.get(Number(l.productId));
    const rate = l.rate ? (parseRupees(l.rate) ?? 0) : (p?.sale_price_paise ?? 0);
    return t + Math.round(((parseQty(l.qty) ?? 0) / 1000) * rate * (1 + (p?.gst_rate_bp ?? 0) / 10000) * (1 - (Number(l.disc) || 0) / 100));
  }, 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        customerName: f.customerName || null,
        customerPhone: f.customerPhone || null,
        customerAddress: f.customerAddress || null,
        site: f.site || null,
        validUntil: f.validUntil || undefined,
        notes: f.notes || null,
        template: isFullHouse ? 'full_house' : null,
        lines: filled.map((l) => ({
          stage: isFullHouse ? l.stage || null : null,
          productId: Number(l.productId),
          qtyMilli: parseQty(l.qty)!,
          ratePaise: l.rate ? (parseRupees(l.rate) ?? undefined) : undefined,
          discountBp: l.disc ? Math.round(Number(l.disc) * 100) : 0,
        })),
      };
      const r = id == null ? await post<{ number: string }>('/api/quotes', body) : await put<{ number: string }>(`/api/quotes/${id}`, body);
      toast({ tone: 'good', text: `Quotation ${r.number} saved` });
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const groups = isFullHouse ? [...STAGES, ''] : [''];
  return (
    <Modal open onClose={onClose} title={id == null ? (isFullHouse ? 'Full House estimate' : 'New quotation') : 'Edit quotation'} width={980} footer={<><span className="num mr-auto text-sm">About <b>{money(roughTotal)}</b> incl. GST (exact total on save)</span><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!filled.length} onClick={() => void save()}>Save quotation</Button></>}>
      <div className="flex flex-col gap-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Customer">
            <Input value={f.customerName} onChange={(e) => setF((x) => ({ ...x, customerName: e.target.value }))} />
          </Field>
          <Field label="Phone">
            <Input value={f.customerPhone} onChange={(e) => setF((x) => ({ ...x, customerPhone: e.target.value }))} inputMode="tel" />
          </Field>
          <Field label="Valid till">
            <Input type="date" value={f.validUntil} onChange={(e) => setF((x) => ({ ...x, validUntil: e.target.value }))} />
          </Field>
          <Field label="Address">
            <Input value={f.customerAddress} onChange={(e) => setF((x) => ({ ...x, customerAddress: e.target.value }))} />
          </Field>
          <Field label="Site / project">
            <Input value={f.site} onChange={(e) => setF((x) => ({ ...x, site: e.target.value }))} placeholder="e.g. New house, Bogole" />
          </Field>
          <Field label="Note">
            <Input value={f.notes} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} />
          </Field>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={isFullHouse} onChange={(e) => setFullHouse(e.target.checked)} /> Group by building stage (Full House)
        </label>
        {groups.map((g) => {
          const ls = isFullHouse ? lines.filter((l) => (l.stage || '') === g) : lines;
          if (isFullHouse && g === '' && !ls.length) return null;
          return (
            <div key={g || 'all'} className="flex flex-col gap-1.5">
              {isFullHouse && <div className="text-[12px] font-bold uppercase tracking-[.1em] text-brick">{g || 'Other'}</div>}
              {ls.map((l) => {
                const p = l.productId ? byId.get(Number(l.productId)) : undefined;
                return (
                  <div key={l.key} className="grid grid-cols-[minmax(0,1fr)_90px_110px_80px_auto] items-center gap-2">
                    <Select aria-label="Product" value={l.productId} onChange={(e) => set(l.key, { productId: e.target.value ? Number(e.target.value) : '' })}>
                      <option value="">Product…</option>
                      {(products.data ?? []).filter((x) => x.active).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </Select>
                    <Input aria-label="Quantity" placeholder={p ? `qty (${p.unit_code})` : 'qty'} inputMode="decimal" className="num" value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} />
                    <Input aria-label="Rate" placeholder={p ? (p.sale_price_paise / 100).toFixed(2) : 'rate'} inputMode="decimal" className="num" value={l.rate} onChange={(e) => set(l.key, { rate: e.target.value })} />
                    <Input aria-label="Discount %" placeholder="disc %" inputMode="decimal" className="num" value={l.disc} onChange={(e) => set(l.key, { disc: e.target.value })} />
                    <Button size="sm" variant="ghost" onClick={() => setLines((x) => x.filter((y) => y.key !== l.key))} aria-label="Remove line">
                      ×
                    </Button>
                  </div>
                );
              })}
              <div>
                <Button size="sm" onClick={() => setLines((x) => [...x, emptyLine(g)])}>
                  + Item{isFullHouse ? ` in ${g || 'Other'}` : ''}
                </Button>
              </div>
            </div>
          );
        })}
        <p className="text-[12px] text-ink-3">Leave the rate blank to use today's price (excluding GST). Stock is checked when the quotation is turned into a bill.</p>
        {error && <Notice tone="bad">{error}</Notice>}
      </div>
    </Modal>
  );
}

function ConvertQuote({ quote, onClose, onDone }: { quote: QuoteListRow; onClose: () => void; onDone: (invoiceId: number) => void }) {
  const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'credit'>('cash');
  const [prices, setPrices] = useState<'quoted' | 'today'>('quoted');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ref] = useState(uuid);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: number }>(`/api/quotes/${quote.id}/convert`, { paymentMode: mode, prices, clientRef: ref });
      onDone(r.id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Make a bill from ${quote.number}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void go()}>Make bill</Button></>}>
      <div className="flex flex-col gap-3 text-sm">
        <div>
          {quote.customer_name} · {quote.items} items · <b className="num">{money(quote.total_paise)}</b>
        </div>
        <Field label="Payment">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {(['cash', 'upi', 'card', 'credit'] as const).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prices">
          <Select value={prices} onChange={(e) => setPrices(e.target.value as typeof prices)}>
            <option value="quoted">As quoted</option>
            <option value="today">Today's prices</option>
          </Select>
        </Field>
        {mode === 'credit' && <Notice tone="warn">A credit bill needs a saved customer. If this quote was for a walk-in customer, choose another payment, or bill it from the billing screen.</Notice>}
        {error && <Notice tone="bad">{error}</Notice>}
        <p className="text-[12px] text-ink-3">Stock, discount limits and the credit limit are checked as for any bill. If prices have changed since the quote, staff use today's prices; admin can keep the quoted ones.</p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ deliveries

interface DeliveryRow {
  id: number;
  number: string;
  delivery_date: string;
  status: 'pending' | 'out' | 'delivered' | 'cancelled';
  site_address: string | null;
  contact_phone: string | null;
  vehicle_no: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  charge_paise: number;
  out_at: string | null;
  delivered_at: string | null;
  received_by: string | null;
  invoice_id: number;
  invoice_number: string;
  customer_name: string;
  items: string;
}

const STATUS_TONE: Record<string, 'warn' | 'teal' | 'good' | 'neutral'> = { pending: 'warn', out: 'teal', delivered: 'good', cancelled: 'neutral' };
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', out: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };

function Deliveries() {
  const toast = useToast();
  const [date, setDate] = useState(todayIst());
  const [all, setAll] = useState(false);
  const list = useQuery({ queryKey: ['ops', 'deliveries', all ? 'open' : date], queryFn: () => get<DeliveryRow[]>(all ? '/api/deliveries' : `/api/deliveries?date=${date}`) });
  const rows = (list.data ?? []).filter((d) => !all || d.status === 'pending' || d.status === 'out');
  const [receiving, setReceiving] = useState<DeliveryRow | null>(null);
  const [receivedBy, setReceivedBy] = useState('');

  const status = async (d: DeliveryRow, s: DeliveryRow['status'], extra: Record<string, string> = {}) => {
    try {
      await post(`/api/deliveries/${d.id}/status`, { status: s, ...extra });
      void list.refetch();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  const counts = { pending: rows.filter((d) => d.status === 'pending').length, out: rows.filter((d) => d.status === 'out').length, delivered: rows.filter((d) => d.status === 'delivered').length };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={date} onChange={(e) => (setDate(e.target.value), setAll(false))} className="w-[160px]" aria-label="Delivery date" />
        <Button size="sm" variant={all ? 'dark' : 'secondary'} onClick={() => setAll((a) => !a)}>
          All not yet delivered
        </Button>
        <span className="ml-auto text-sm text-ink-3">
          {counts.pending} pending · {counts.out} out · {counts.delivered} delivered
        </span>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : rows.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((d) => (
            <section key={d.id} className={cx('flex flex-col gap-2 rounded-[6px] border bg-white p-3 text-sm', d.status === 'out' ? 'border-teal' : 'border-line')}>
              <div className="flex items-center gap-2">
                <b className="num">{d.number}</b>
                <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
                <span className="num ml-auto text-[12px] text-ink-3">{fmtDate(d.delivery_date)}</span>
              </div>
              <div>
                <b>{d.customer_name}</b> <span className="text-ink-3">· bill {d.invoice_number}</span>
                {d.site_address && <div className="text-ink-2">{d.site_address}</div>}
                {d.contact_phone && <div className="num text-ink-3">{d.contact_phone}</div>}
              </div>
              <div className="rounded-[4px] bg-paper px-2 py-1.5 text-[13px]">{d.items}</div>
              <div className="text-[12px] text-ink-3">
                {[d.vehicle_no, d.driver_name, d.driver_phone].filter(Boolean).join(' · ') || 'No vehicle yet'}
                {d.charge_paise > 0 && <> · charge {money(d.charge_paise)}</>}
                {d.received_by && <> · received by {d.received_by}</>}
              </div>
              <div className="mt-auto flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => window.open(`/print/challan/${d.id}`, '_blank')}>
                  Challan
                </Button>
                {d.status === 'pending' && (
                  <Button size="sm" variant="primary" onClick={() => void status(d, 'out')}>
                    Out for delivery
                  </Button>
                )}
                {(d.status === 'pending' || d.status === 'out') && (
                  <>
                    <Button size="sm" variant="dark" onClick={() => (setReceiving(d), setReceivedBy(''))}>
                      Delivered
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void status(d, 'cancelled')}>
                      Cancel
                    </Button>
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty>No deliveries {all ? 'waiting' : 'on this day'}. Plan one from Sales → open a bill → Delivery…</Empty>
      )}
      <Modal open={!!receiving} onClose={() => setReceiving(null)} title={`Delivered — ${receiving?.number ?? ''}`} footer={<><Button onClick={() => setReceiving(null)}>Cancel</Button><Button variant="primary" onClick={() => (receiving && void status(receiving, 'delivered', receivedBy ? { receivedBy } : {}), setReceiving(null))}>Mark delivered</Button></>}>
        <Field label="Received by (optional)">
          <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </div>
  );
}

/** Plan a delivery for a bill (opened from Sales → bill). */
export function DeliveryModal({ invoiceId, open, onClose }: { invoiceId: number; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const left = useQuery({ queryKey: ['ops', 'deliverable', invoiceId], queryFn: () => get<{ id: number; product_name: string; unit_code: string; qty_milli: number; remaining_milli: number }[]>(`/api/invoices/${invoiceId}/deliverable`), enabled: open });
  const [qty, setQty] = useState<Record<number, string>>({});
  const [f, setF] = useState({ date: todayIst(), siteAddress: '', vehicleNo: '', driverName: '', driverPhone: '', charge: '', notes: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && left.data) setQty(Object.fromEntries(left.data.map((l) => [l.id, l.remaining_milli > 0 ? String(l.remaining_milli / 1000) : ''])));
  }, [open, left.data]);
  const save = async () => {
    setBusy(true);
    try {
      const lines = Object.entries(qty).map(([id, v]) => ({ invoiceLineId: Number(id), qtyMilli: parseQty(v) ?? 0 })).filter((l) => l.qtyMilli > 0);
      const r = await post<{ number: string; id: number }>(`/api/invoices/${invoiceId}/deliveries`, {
        date: f.date,
        siteAddress: f.siteAddress || undefined,
        vehicleNo: f.vehicleNo || undefined,
        driverName: f.driverName || undefined,
        driverPhone: f.driverPhone || undefined,
        chargePaise: f.charge ? (parseRupees(f.charge) ?? 0) : 0,
        notes: f.notes || undefined,
        lines,
      });
      toast({ tone: 'good', text: `Delivery ${r.number} planned`, action: { label: 'Print challan', onClick: () => window.open(`/print/challan/${r.id}`, '_blank') } });
      void qc.invalidateQueries({ queryKey: ['ops'] });
      onClose();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Plan a delivery" width={720} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save delivery</Button></>}>
      {!left.data ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <Table minWidth={480} head={<tr><th>Item</th><th className="text-right">Billed</th><th className="text-right">Left to deliver</th><th className="text-right">In this trip</th></tr>}>
            {left.data.map((l) => (
              <tr key={l.id}>
                <td>{l.product_name}</td>
                <td className="num text-right">{formatQty(l.qty_milli)} {l.unit_code}</td>
                <td className="num text-right">{formatQty(l.remaining_milli)}</td>
                <td className="text-right">
                  <Input aria-label={`Deliver ${l.product_name}`} inputMode="decimal" className="num ml-auto w-[100px] text-right" disabled={l.remaining_milli <= 0} value={qty[l.id] ?? ''} onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))} />
                </td>
              </tr>
            ))}
          </Table>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Date">
              <Input type="date" value={f.date} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} />
            </Field>
            <Field label="Vehicle number">
              <Input value={f.vehicleNo} onChange={(e) => setF((x) => ({ ...x, vehicleNo: e.target.value }))} className="uppercase" />
            </Field>
            <Field label="Delivery charge (₹)" hint="Shown on the challan. To charge GST on it, add it as a line on the bill.">
              <Input value={f.charge} onChange={(e) => setF((x) => ({ ...x, charge: e.target.value }))} inputMode="decimal" />
            </Field>
            <Field label="Driver">
              <Input value={f.driverName} onChange={(e) => setF((x) => ({ ...x, driverName: e.target.value }))} />
            </Field>
            <Field label="Driver phone">
              <Input value={f.driverPhone} onChange={(e) => setF((x) => ({ ...x, driverPhone: e.target.value }))} inputMode="tel" />
            </Field>
            <Field label="Site address (blank = bill address)">
              <Input value={f.siteAddress} onChange={(e) => setF((x) => ({ ...x, siteAddress: e.target.value }))} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ cement age

interface AgeRow {
  productId: number;
  name: string;
  unit: string;
  stockMilli: number;
  layers: { received: string; packedOn: string | null; batch: string | null; qtyMilli: number; ageDays: number }[];
  oldest: { ageDays: number } | null;
  unknownMilli: number;
  warn: boolean;
}

function CementAge() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['ops', 'age'], queryFn: () => get<{ warnDays: number; products: AgeRow[] }>('/api/stock-age') });
  const products = useQuery({ queryKey: ['products', 'billing'], queryFn: () => get<ProductRow[]>('/api/products'), enabled: can('products.manage') });
  const [addId, setAddId] = useState('');
  const toggle = async (productId: number, on: boolean) => {
    await post('/api/stock-age/products', { productId, on }).catch((e) => toast({ tone: 'bad', text: errText(e) }));
    setAddId('');
    void qc.invalidateQueries({ queryKey: ['ops', 'age'] });
  };
  if (!d.data) return <Spinner />;
  const tracked = new Set(d.data.products.map((p) => p.productId));
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="teal">
        Bags are assumed to go out oldest first, so the stock on hand is the newest receipts. Age counts from the packing date on the bag (entered on the purchase), otherwise from the day it arrived. Over {d.data.warnDays} days is flagged.
      </Notice>
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">
        {d.data.products.length ? (
          <Table head={<tr><th>Product</th><th className="text-right">In stock</th><th>What is on hand (oldest first)</th><th />{can('products.manage') && <th />}</tr>}>
            {d.data.products.map((p) => (
              <tr key={p.productId}>
                <td className="font-semibold">{p.name}</td>
                <td className="num text-right">{formatQty(p.stockMilli)} {p.unit}</td>
                <td className="text-[13px]">
                  {p.layers.map((l, i) => (
                    <div key={i} className={cx(l.ageDays > d.data!.warnDays && 'font-bold text-bad')}>
                      {formatQty(l.qtyMilli)} {p.unit} · {l.batch ?? 'no batch'} · {l.packedOn ? `packed ${fmtDate(l.packedOn)}` : `arrived ${fmtDate(l.received)}`} · {l.ageDays} days
                    </div>
                  ))}
                  {p.unknownMilli > 0 && <div className="text-warn-ink">{formatQty(p.unknownMilli)} {p.unit} older than the records</div>}
                  {!p.layers.length && !p.unknownMilli && <span className="text-ink-3">No stock</span>}
                </td>
                <td>{p.warn ? <Badge tone="bad">Sell old stock first</Badge> : <Badge tone="good">Fresh</Badge>}</td>
                {can('products.manage') && (
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => void toggle(p.productId, false)}>
                      Stop tracking
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No products are tracked yet.</Empty>
        )}
      </section>
      {can('products.manage') && (
        <div className="flex max-w-[560px] gap-2">
          <Select value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">Track stock age for another product…</option>
            {(products.data ?? []).filter((p) => !tracked.has(p.id)).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button disabled={!addId} onClick={() => void toggle(Number(addId), true)}>
            Track
          </Button>
        </div>
      )}
    </div>
  );
}


import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ewayNeeded,
  B2C_DETAILS_THRESHOLD_PAISE,
  BASE,
  STATES,
  calcBill,
  calcLine,
  convertRate,
  discountHintCode,
  effectiveMaxDiscountBp,
  formatPaise,
  formatPercent,
  formatQty,
  parsePercent,
  parseQty,
  parseRupees,
  toBase,
  unitPrice,
  type PriceMode,
  type SupplyType,
} from '@kph/core';
import { ApiError, del, get, post, put, qs, store } from '../lib/api';
import { MODE_LABEL, fmtDate, uuid } from '../lib/format';
import { useOverride } from '../lib/override';
import { useSession } from '../lib/session';
import type { AssistantBillCard, CustomerRow, ProductRow } from '../lib/types';
import { PartnerPicker, type PartnerPick } from '../components/PartnerBits';
import { useT } from '../lib/i18n';
import { Button, Field, Input, Kbd, Modal, Notice, cx, useDebounced, useToast } from '../components/ui';

type Mode = 'cash' | 'upi' | 'card' | 'credit';

interface Line {
  key: string;
  productId: number;
  qtyText: string;
  discText: string;
  rateText: string | null; // set only when admin changes the rate
  unitCode?: string | null;
  mode?: PriceMode;
  overrideToken?: string;
  overrideBp?: number;
  approvedBy?: string;
}

interface Draft {
  clientRef: string;
  lines: Line[];
  customer: (Pick<CustomerRow, 'id' | 'name' | 'phone' | 'address' | 'balance_paise' | 'credit_limit_paise'> & { gstin?: string | null }) | null;
  walkinName: string;
  walkinPhone: string;
  walkinAddress?: string;
  /** GST place of supply; null = automatic */
  pos?: string | null;
  billMode?: PriceMode;
  /** Trade partner who brought this customer, and their site. */
  partner?: PartnerPick | null;
  siteId?: number | null;
  mode: Mode;
  notes: string;
  savedAt?: string;
}

const emptyDraft = (): Draft => ({ clientRef: uuid(), lines: [], customer: null, walkinName: '', walkinPhone: '', mode: 'cash', notes: '' });
const MODES: Mode[] = ['cash', 'upi', 'card', 'credit'];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The unit a line is sold in (base unit unless another sale unit is chosen). */
function unitFor(p: ProductRow, code: string | null | undefined) {
  const u = code && code !== p.unit_code ? p.units.find((x) => x.unit_code === code && x.for_sale) : undefined;
  return u ? { code: u.unit_code, factor: { num: u.factor_num, den: u.factor_den }, ownPrice: u.price_paise } : { code: p.unit_code, factor: BASE, ownPrice: null as number | null };
}

export function Billing() {
  const { boot, user, can } = useSession();
  const t = useT();
  const toast = useToast();
  const askOverride = useOverride();
  const draftKey = `kph.draft.${store.workspace}.${boot?.device?.id}.${user?.userId}`;

  const products = useQuery({ queryKey: ['products', 'billing'], queryFn: () => get<ProductRow[]>('/api/products') });
  // Cement: tell the counter which bags to send out first.
  const stockAge = useQuery({
    queryKey: ['ops', 'age'],
    queryFn: () => get<{ warnDays: number; products: { productId: number; oldest: { batch: string | null; packedOn: string | null; received: string; ageDays: number } | null; warn: boolean }[] }>('/api/stock-age'),
    staleTime: 300_000,
  });
  const ageOf = useMemo(() => new Map((stockAge.data?.products ?? []).map((p) => [p.productId, p])), [stockAge.data]);
  const byId = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);

  // ------------------------------------------------------------ draft (never lose a half-made bill)
  const [draft, setDraftState] = useState<Draft>(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) return JSON.parse(raw) as Draft;
    } catch {
      /* ignore */
    }
    return emptyDraft();
  });
  const [restoredFromServer, setRestored] = useState(false);
  useEffect(() => {
    if (restoredFromServer) return;
    setRestored(true);
    if (draft.lines.length) return;
    get<{ data: Draft } | null>('/api/drafts/current')
      .then((d) => {
        if (d?.data?.lines?.length) setDraftState(d.data);
      })
      .catch(() => {});
  }, [restoredFromServer, draft.lines.length]);

  const setDraft = useCallback((fn: (d: Draft) => Draft) => {
    setDraftState((d) => ({ ...fn(d), savedAt: new Date().toISOString() }));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      /* storage full or blocked */
    }
    const t = setTimeout(() => {
      if (draft.lines.length || draft.customer) put('/api/drafts/current', draft).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [draft, draftKey]);

  // A bill drafted by the assistant: its lines are added here for a person to check and save.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const card = (location.state as { assistantBill?: AssistantBillCard } | null)?.assistantBill;
    if (!card) return;
    navigate(location.pathname, { replace: true, state: null });
    setDraft((d) => ({
      ...d,
      customer: d.customer ?? card.customer,
      walkinName: d.customer || d.walkinName ? d.walkinName : (card.walkinName ?? ''),
      mode: d.lines.length ? d.mode : card.mode,
      lines: [
        ...d.lines,
        ...card.lines.map((l) => ({ key: uuid(), productId: l.productId, qtyText: String(l.qtyMilli / 1000), discText: '', rateText: null, unitCode: l.unitCode, mode: d.billMode ?? boot?.settings.salesPriceMode ?? 'excl' })),
      ],
    }));
    toast({ tone: 'good', text: `Added ${card.lines.length} item${card.lines.length === 1 ? '' : 's'} from the assistant — check and save the bill.` });
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ line maths
  const canOver = can('billing.discount_over_limit');
  const canRate = can('products.edit_price');
  const hintOn = boot?.settings.discountHintEnabled ?? true;

  const shopState = boot?.settings.stateCode ?? '37';
  const billMode: PriceMode = draft.billMode ?? boot?.settings.salesPriceMode ?? 'excl';
  const custState = draft.customer?.gstin ? draft.customer.gstin.slice(0, 2) : null;
  const pos = draft.pos ?? custState ?? shopState;
  const supply: SupplyType = pos === shopState ? 'intra' : 'inter';

  const baseOf = (l: Line) => {
    const p = byId.get(l.productId);
    const q = parseQty(l.qtyText);
    if (!p || q == null) return 0;
    const u = unitFor(p, l.unitCode);
    return toBase(q, u.factor).baseMilli;
  };

  const rows = draft.lines.map((l) => {
    const p = byId.get(l.productId);
    const qtyMilli = parseQty(l.qtyText);
    const discBp = l.discText === '' ? 0 : parsePercent(l.discText);
    const mode: PriceMode = l.mode ?? billMode;
    const unit = p ? unitFor(p, l.unitCode) : { code: '', factor: BASE, ownPrice: null };
    const listRate = p ? convertRate(unit.ownPrice ?? unitPrice(p.sale_price_paise, unit.factor), p.price_includes_tax ? 'incl' : 'excl', mode, p.gst_rate_bp) : 0;
    const ratePaise = l.rateText != null ? parseRupees(l.rateText) : listRate;
    const scale = (t: 'pct' | 'amt' | null, v: number | null) => (t && v != null ? (t === 'amt' ? { type: t, value: unitPrice(v, unit.factor) } : { type: t, value: v }) : null);
    const maxBp = p
      ? effectiveMaxDiscountBp({
          productLimit: scale(p.max_disc_type, p.max_disc_value),
          categoryLimit: scale(p.cat_disc_type, p.cat_disc_value),
          staffCapBp: canOver ? null : (user?.discountCapBp ?? null),
          ratePaise: convertRate(ratePaise ?? 0, mode, 'excl', p.gst_rate_bp),
        })
      : 0;
    const valid = !!p && qtyMilli != null && qtyMilli > 0 && discBp != null && discBp <= 10000 && ratePaise != null;
    const result = valid ? calcLine({ qtyMilli: qtyMilli!, ratePaise: ratePaise!, discountBp: discBp!, gstRateBp: p!.gst_rate_bp, mode }, supply) : null;
    const over = valid && discBp! > maxBp;
    const approved = over && !!l.overrideToken && (l.overrideBp ?? -1) >= discBp!;
    const blocked = over && !canOver && !approved;
    const baseMilli = baseOf(l);
    const usedElsewhere = draft.lines.filter((o) => o.productId === l.productId && o.key !== l.key).reduce((s, o) => s + baseOf(o), 0);
    const available = (p?.qty_milli ?? 0) - usedElsewhere;
    const short = valid && baseMilli > available;
    const saleUnits = p ? [p.unit_code, ...p.units.filter((u) => u.for_sale).map((u) => u.unit_code)] : [];
    return { l, p, qtyMilli, discBp, ratePaise, listRate, mode, unit, saleUnits, baseMilli, maxBp, valid, result, over, approved, blocked, short, available };
  });

  const totals = calcBill(
    rows.filter((r) => r.valid).map((r) => ({ qtyMilli: r.qtyMilli!, ratePaise: r.ratePaise!, discountBp: r.discBp!, gstRateBp: r.p!.gst_rate_bp, mode: r.mode })),
    supply,
  );
  const units = rows.reduce((s, r) => s + (r.qtyMilli ?? 0), 0);
  const blockedLine = rows.findIndex((r) => r.blocked);
  const invalidLine = rows.findIndex((r) => !r.valid);
  const shortLine = rows.findIndex((r) => r.short);
  const creditProblem = draft.mode === 'credit' && !draft.customer;
  // GST rules (also enforced by the server)
  const b2bNoAddress = !!draft.customer?.gstin && !draft.customer.address;
  const bigNoDetails =
    !draft.customer?.gstin && totals.totalPaise >= B2C_DETAILS_THRESHOLD_PAISE && !(draft.customer ? draft.customer.address : draft.walkinName.trim() && draft.walkinAddress?.trim());
  const canSave = rows.length > 0 && blockedLine < 0 && invalidLine < 0 && shortLine < 0 && !creditProblem && !b2bNoAddress && !bigNoDetails;

  // ------------------------------------------------------------ search
  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const matches = useMemo(() => {
    const words = norm(q).split(' ').filter(Boolean);
    if (!words.length) return [];
    // Every typed word must appear; words that start a word in the name rank higher ("12" → "12mm" before "112").
    return (products.data ?? [])
      .map((p) => {
        const hay = norm(`${p.name} ${p.sku} ${p.brand_name ?? ''} ${p.category_name ?? ''}`);
        if (!words.every((w) => hay.includes(w))) return null;
        const nameWords = norm(p.name).split(' ');
        const score = words.reduce((s, w) => s + (nameWords.some((x) => x === w) ? 3 : nameWords.some((x) => x.startsWith(w)) ? 2 : 0), 0);
        return { p, score };
      })
      .filter((x): x is { p: ProductRow; score: number } => x != null)
      .sort((a, b) => b.score - a.score || a.p.name.length - b.p.name.length)
      .slice(0, 8)
      .map((x) => x.p);
  }, [q, products.data]);
  useEffect(() => setCursor(0), [q]);

  const qtyRefs = useRef(new Map<string, HTMLInputElement>());
  const discRefs = useRef(new Map<string, HTMLInputElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (!focusKey) return;
    const el = qtyRefs.current.get(focusKey);
    el?.focus();
    el?.select();
    setFocusKey(null);
  }, [focusKey, draft.lines.length]);

  const addProduct = (p: ProductRow) => {
    const key = uuid();
    setDraft((d) => ({ ...d, lines: [...d.lines, { key, productId: p.id, qtyText: '1', discText: '', rateText: null, unitCode: null, mode: d.billMode ?? boot?.settings.salesPriceMode ?? 'excl' }] }));
    setQ('');
    setFocusKey(key);
  };

  const updateLine = (key: string, patch: Partial<Line>) => setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key: string) => setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.key !== key) }));
  const [expanded, setExpanded] = useState<string | null>(null);

  // ------------------------------------------------------------ approval
  const approveLine = async (i: number) => {
    const r = rows[i];
    if (!r || !r.p || r.discBp == null) return;
    const extra = r.result ? Math.round(((r.discBp - r.maxBp) / 10000) * r.result.grossPaise) : 0;
    const res = await askOverride({
      permission: 'billing.discount_over_limit',
      context: { productId: r.p.id, discountBp: r.discBp },
      title: 'Discount above limit',
      details: (
        <>
          <div>
            {r.p.name} × {formatQty(r.qtyMilli ?? 0)} {r.p.unit_code}
          </div>
          <div className="num">
            Asking <b className="text-bad">{formatPercent(r.discBp)}%</b> · allowed {formatPercent(r.maxBp)}% · extra ₹{formatPaise(Math.max(0, extra))}
          </div>
        </>
      ),
    });
    if (res) updateLine(r.l.key, { overrideToken: res.token, overrideBp: r.discBp, approvedBy: res.approvedBy.name });
  };

  // ------------------------------------------------------------ customer
  const custRef = useRef<HTMLInputElement>(null);
  const [custQ, setCustQ] = useState('');
  const custDebounced = useDebounced(custQ, 200);
  const custResults = useQuery({
    queryKey: ['customers', 'search', custDebounced],
    queryFn: () => get<CustomerRow[]>(`/api/customers${qs({ search: custDebounced })}`),
    enabled: custDebounced.trim().length >= 2,
  });
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);

  // ------------------------------------------------------------ save
  const [saving, setSaving] = useState(false);
  /** Bills above ₹50,000: ask whether goods are moving by vehicle (e-way bill) before the next bill. */
  const [ewayAsk, setEwayAsk] = useState<{ id: number; number: string; totalPaise: number } | null>(null);
  const save = async (print: boolean, creditOverrideToken?: string) => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const r = await post<{ id: number; number: string }>('/api/invoices', {
        clientRef: draft.clientRef,
        customerId: draft.customer?.id ?? null,
        customerName: draft.customer ? undefined : draft.walkinName || undefined,
        customerPhone: draft.customer ? undefined : draft.walkinPhone || undefined,
        customerAddress: draft.customer ? undefined : draft.walkinAddress?.trim() || undefined,
        placeOfSupply: pos,
        paymentMode: draft.mode,
        notes: draft.notes || undefined,
        creditOverrideToken,
        partnerId: draft.partner?.id ?? null,
        siteId: draft.partner ? (draft.siteId ?? null) : null,
        lines: rows.map((x) => ({
          productId: x.p!.id,
          qtyMilli: x.qtyMilli!,
          unitCode: x.unit.code,
          rateMode: x.mode,
          ratePaise: x.l.rateText != null ? x.ratePaise! : undefined,
          discountBp: x.discBp!,
          overrideToken: x.over ? x.l.overrideToken : undefined,
        })),
      });
      const fresh = emptyDraft();
      setDraftState(fresh);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
      del('/api/drafts/current').catch(() => {});
      if (print) window.open(`/print/invoice/${r.id}?auto=1`, '_blank');
      toast({
        tone: 'good',
        text: (
          <>
            Bill <b className="num">{r.number}</b> saved · ₹{formatPaise(totals.totalPaise)}
          </>
        ),
        action: print ? undefined : { label: 'Print', onClick: () => window.open(`/print/invoice/${r.id}?auto=1`, '_blank') },
      });
      products.refetch();
      if (ewayNeeded({ taxablePaise: totals.taxablePaise, cgstPaise: totals.cgstPaise, sgstPaise: totals.sgstPaise, igstPaise: totals.igstPaise })) {
        setEwayAsk({ id: r.id, number: r.number, totalPaise: totals.totalPaise });
      } else setTimeout(() => searchRef.current?.focus(), 50);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === 'NEEDS_OVERRIDE' && typeof err.details?.lineIndex === 'number') {
        void approveLine(err.details.lineIndex);
      } else if (err?.code === 'NEEDS_OVERRIDE' && err.details?.permission === 'billing.over_credit_limit') {
        const det = err.details as { customerId: number; balancePaise: number; limitPaise: number; afterPaise: number };
        setSaving(false);
        const res = await askOverride({
          permission: 'billing.over_credit_limit',
          context: { customerId: det.customerId, upToPaise: det.afterPaise },
          title: 'Over the credit limit',
          details: (
            <div className="num">
              {draft.customer?.name}: owes ₹{formatPaise(det.balancePaise)} · this bill ₹{formatPaise(det.afterPaise - det.balancePaise)}
              <br />
              After this bill <b className="text-bad">₹{formatPaise(det.afterPaise)}</b> · limit ₹{formatPaise(det.limitPaise)}
            </div>
          ),
        });
        if (res) return save(print, res.token);
        return;
      } else {
        toast({ tone: 'bad', text: err?.message ?? 'Could not save the bill. It is kept — try again.' });
      }
      if (err?.code === 'INSUFFICIENT_STOCK' || err?.code === 'OVERRIDE_INVALID') products.refetch();
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'F4') {
        e.preventDefault();
        custRef.current?.focus();
      } else if (e.key === 'F8') {
        e.preventDefault();
        if (blockedLine >= 0) void approveLine(blockedLine);
      } else if (e.key === 'F10') {
        e.preventDefault();
        void save(true);
      } else if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void save(false);
      } else if (e.altKey && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        setDraft((d) => ({ ...d, mode: MODES[Number(e.key) - 1]! }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const balanceAfter = draft.customer && draft.mode === 'credit' ? draft.customer.balance_paise + totals.totalPaise : null;
  const overLimit = balanceAfter != null && draft.customer?.credit_limit_paise != null && balanceAfter > draft.customer.credit_limit_paise;

  return (
    <main className="flex flex-1 flex-wrap items-start gap-4 px-4 pb-3 pt-4 sm:px-5">
      {/* ---------------------------------------------------- items */}
      <section aria-label="Bill items" className="flex min-w-0 flex-[999_1_640px] flex-col gap-3">
        <div className="relative">
          <label htmlFor="search" className="sr-only">
            Find product
          </label>
          <div className="flex h-[52px] items-center gap-2.5 rounded-[6px] border-2 border-teal bg-white px-3.5 focus-within:ring-4 focus-within:ring-teal-soft">
            <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#55524c" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              id="search"
              ref={searchRef}
              autoComplete="off"
              placeholder={products.isLoading ? 'Loading products…' : t('Type product name, SKU or brand…')}
              value={q}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, matches.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === 'Enter' && matches[cursor]) {
                  e.preventDefault();
                  addProduct(matches[cursor]!);
                } else if (e.key === 'Escape') setQ('');
              }}
              className="flex-1 bg-transparent text-[17px] outline-none focus-visible:outline-none"
            />
            <Kbd>F2</Kbd>
          </div>
          {q.trim() && searchFocused && (
            <div role="listbox" aria-label="Matching products" className="absolute inset-x-0 top-[58px] z-20 overflow-hidden rounded-[6px] border border-line bg-white shadow-xl">
              {matches.length === 0 && <div className="px-4 py-3 text-sm text-ink-3">No product matches “{q}”.</div>}
              {matches.map((p, i) => (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addProduct(p);
                  }}
                  className={cx('flex cursor-pointer items-center gap-3 border-t border-line-3 px-3.5 py-2.5 first:border-t-0', i === cursor && 'bg-teal-soft shadow-[inset_3px_0_0_#1e3f48]')}
                >
                  <div className="min-w-0 flex-1">
                    <div className={cx('truncate text-[15px]', i === cursor ? 'font-bold' : 'font-medium')}>{p.name}</div>
                    <div className="truncate text-xs text-ink-3">
                      {p.sku} · {p.category_name ?? 'No category'} {p.brand_name ? `· ${p.brand_name}` : ''}
                    </div>
                  </div>
                  <div className={cx('num whitespace-nowrap text-[13px] font-bold', p.stock_status === 'ok' ? 'text-good' : p.stock_status === 'low' ? 'text-warn' : 'text-bad')}>
                    {formatQty(p.qty_milli)} {p.unit_code}
                    {p.stock_status !== 'ok' && ` · ${p.stock_status}`}
                  </div>
                  <div className="num w-[110px] text-right font-semibold">₹{formatPaise(p.sale_price_paise)}</div>
                  <span className="w-12 text-right">{i === cursor && <Kbd>Enter</Kbd>}</span>
                </div>
              ))}
              <div className="border-t border-line-3 bg-paper px-3.5 py-2 text-xs text-ink-3">↑ ↓ to move · Enter to add · Esc to close · prices exclude GST</div>
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-[6px] border border-line bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead className="bg-paper text-left [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-line [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-[11px] [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-[.12em] [&_th]:text-ink-3">
                <tr>
                  <th className="w-7">#</th>
                  <th>Item</th>
                  <th className="w-24 text-right">Qty</th>
                  <th className="w-28 text-right">Rate {billMode === 'incl' ? 'incl.' : 'excl.'} GST</th>
                  <th className="w-[108px] text-right">Disc %</th>
                  <th className="w-28 text-right">Taxable</th>
                  <th className="w-24 text-right">GST</th>
                  <th className="w-28 text-right">Amount</th>
                  <th className="w-9">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody className="[&_td]:border-b [&_td]:border-line-3 [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="!py-12 text-center text-ink-3">
                      Press <Kbd>F2</Kbd> and type a product name to start the bill.
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => (
                  <tr key={r.l.key} className={cx(r.blocked ? 'bg-[#fdf4f2]' : expanded === r.l.key && 'bg-[#fcfbf9]')}>
                    <td className="num text-cement">{i + 1}</td>
                    <td className="cursor-pointer" onClick={() => setExpanded((k) => (k === r.l.key ? null : r.l.key))}>
                      <div className="font-bold">{r.p?.name ?? 'Product no longer available'}</div>
                      {r.p && (
                        <div className="text-xs text-ink-3">
                          {r.p.sku} · HSN {r.p.hsn ?? '—'} ·{' '}
                          <span className={r.short ? 'font-bold text-bad' : r.available <= 0 ? 'text-bad' : 'text-good'}>
                            {r.short ? `only ${formatQty(Math.max(0, r.available))} ${r.p.unit_code} in stock` : `${formatQty(r.available)} ${r.p.unit_code} in stock`}
                          </span>
                        </div>
                      )}
                      {r.p && ageOf.get(r.p.id)?.oldest && (
                        <div className={cx('text-xs', ageOf.get(r.p.id)!.warn ? 'font-semibold text-warn-ink' : 'text-ink-3')}>
                          Send oldest first: {ageOf.get(r.p.id)!.oldest!.batch ?? 'stock'} ·{' '}
                          {ageOf.get(r.p.id)!.oldest!.packedOn ? `packed ${fmtDate(ageOf.get(r.p.id)!.oldest!.packedOn)}` : `arrived ${fmtDate(ageOf.get(r.p.id)!.oldest!.received)}`} ({ageOf.get(r.p.id)!.oldest!.ageDays} days)
                        </div>
                      )}
                      {expanded === r.l.key && r.result && r.p && (
                        <div className="num mt-1.5 rounded-[4px] bg-concrete px-2 py-1.5 text-xs text-ink-2">
                          {formatQty(r.qtyMilli!)} × ₹{formatPaise(r.ratePaise!)} = ₹{formatPaise(r.result.grossPaise)}
                          {r.discBp ? ` − ${formatPercent(r.discBp)}% (₹${formatPaise(r.result.discountPaise)})` : ''} = {r.mode === 'incl' ? `₹${formatPaise(r.result.amountPaise)} incl. GST → ` : ''}taxable ₹{formatPaise(r.result.taxablePaise)} +{' '}
                          {supply === 'intra'
                            ? `CGST ${formatPercent(r.p.gst_rate_bp / 2)}% ₹${formatPaise(r.result.cgstPaise)} + SGST ${formatPercent(r.p.gst_rate_bp / 2)}% ₹${formatPaise(r.result.sgstPaise)}`
                            : `IGST ${formatPercent(r.p.gst_rate_bp)}% ₹${formatPaise(r.result.igstPaise)}`}{' '}
                          = ₹{formatPaise(r.result.amountPaise)}
                        </div>
                      )}
                      {r.blocked && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-bad">
                          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
                          Discount is above what you can give.
                          <button type="button" onClick={(e) => (e.stopPropagation(), void approveLine(i))} className="inline-flex h-[30px] items-center gap-1.5 rounded-[6px] bg-ink px-2.5 text-xs font-bold text-white">
                            Ask admin PIN <span className="text-nav">F8</span>
                          </button>
                        </div>
                      )}
                      {r.approved && <div className="mt-1 text-xs text-good">Discount approved by {r.l.approvedBy}</div>}
                    </td>
                    <td className="text-right">
                      <input
                        aria-label="Quantity"
                        ref={(el) => {
                          if (el) qtyRefs.current.set(r.l.key, el);
                          else qtyRefs.current.delete(r.l.key);
                        }}
                        inputMode="decimal"
                        value={r.l.qtyText}
                        onChange={(e) => updateLine(r.l.key, { qtyText: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            discRefs.current.get(r.l.key)?.focus();
                            discRefs.current.get(r.l.key)?.select();
                          }
                        }}
                        className={cx('num h-9 w-full rounded-[6px] border bg-white px-2.5 text-right outline-none focus:border-teal focus:ring-4 focus:ring-teal-soft', r.qtyMilli == null || r.short ? 'border-bad' : 'border-line-2')}
                      />
                      {r.saleUnits.length > 1 ? (
                        <select
                          aria-label="Unit"
                          value={r.unit.code}
                          onChange={(e) => updateLine(r.l.key, { unitCode: e.target.value, rateText: null })}
                          className="mt-0.5 w-full rounded-[4px] border border-line bg-white px-1 text-right text-[11px]"
                        >
                          {r.saleUnits.map((u) => (
                            <option key={u}>{u}</option>
                          ))}
                        </select>
                      ) : (
                        <div className="mt-0.5 text-[11px] text-cement">{r.unit.code}</div>
                      )}
                    </td>
                    <td className="num text-right">
                      {canRate ? (
                        <input
                          aria-label={`Rate ${r.mode === 'incl' ? 'including' : 'excluding'} GST`}
                          inputMode="decimal"
                          value={r.l.rateText ?? formatPaise(r.listRate).replace(/,/g, '')}
                          onChange={(e) => updateLine(r.l.key, { rateText: e.target.value })}
                          className={cx('num h-9 w-full rounded-[6px] border bg-white px-2 text-right outline-none focus:border-teal', r.ratePaise == null ? 'border-bad' : r.l.rateText != null ? 'border-warn' : 'border-line-2')}
                        />
                      ) : (
                        <div className="pt-2">{r.ratePaise != null ? formatPaise(r.ratePaise) : '—'}</div>
                      )}
                      <button
                        type="button"
                        title="Switch this line between price excluding and including GST"
                        onClick={() => updateLine(r.l.key, { mode: r.mode === 'incl' ? 'excl' : 'incl', rateText: null })}
                        className={cx('mt-0.5 rounded-[3px] px-1 text-[10px] font-bold', r.mode === 'incl' ? 'bg-teal-soft text-teal' : 'text-cement hover:text-ink')}
                      >
                        {r.mode === 'incl' ? 'INCL. GST' : 'excl. GST'}
                      </button>
                    </td>
                    <td className="text-right">
                      <input
                        aria-label="Discount percent"
                        ref={(el) => {
                          if (el) discRefs.current.set(r.l.key, el);
                          else discRefs.current.delete(r.l.key);
                        }}
                        inputMode="decimal"
                        placeholder="0"
                        value={r.l.discText}
                        onChange={(e) => updateLine(r.l.key, { discText: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            searchRef.current?.focus();
                          }
                        }}
                        className={cx('num h-9 w-full rounded-[6px] border bg-white px-2.5 text-right outline-none focus:border-teal focus:ring-4 focus:ring-teal-soft', r.discBp == null || r.blocked ? 'border-bad' : 'border-line-2')}
                      />
                      {hintOn && r.p && (
                        <div className="mt-0.5 text-right">
                          <span className="disc-hint" title={`Max discount ${formatPercent(r.maxBp)}%`}>
                            {discountHintCode(r.maxBp)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="num pt-[18px] text-right">{r.result ? formatPaise(r.result.taxablePaise) : '—'}</td>
                    <td className="num pt-[18px] text-right text-ink-3">{r.result ? formatPaise(r.result.cgstPaise + r.result.sgstPaise + r.result.igstPaise) : '—'}</td>
                    <td className="num pt-[18px] text-right font-bold">{r.result ? formatPaise(r.result.amountPaise) : '—'}</td>
                    <td className="pt-3.5">
                      <button type="button" aria-label={`Remove ${r.p?.name ?? 'line'}`} onClick={() => removeLine(r.l.key)} className="grid size-7 place-items-center rounded-[4px] text-cement hover:bg-bad-soft hover:text-bad">
                        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap justify-between gap-2 bg-paper px-3.5 py-2.5 text-xs text-ink-3">
            <span className="flex flex-wrap items-center gap-2">
              Prices typed
              <span role="radiogroup" aria-label="Prices typed including or excluding GST" className="inline-flex overflow-hidden rounded-[4px] border border-line-2 bg-white">
                {(['excl', 'incl'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={billMode === m}
                    onClick={() => setDraft((d) => ({ ...d, billMode: m, lines: d.lines.map((l) => ({ ...l, mode: m, rateText: null })) }))}
                    className={cx('h-6 px-2 text-[11px] font-bold', billMode === m ? 'bg-teal text-white' : 'text-ink-2')}
                  >
                    {m === 'excl' ? 'Excl. GST' : 'Incl. GST'}
                  </button>
                ))}
              </span>
              · click a line to see how its amount is worked out
            </span>
            <span className="num">
              {rows.length} items · {formatQty(units)} units
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-3.5 text-xs text-ink-3">
          <span><Kbd>F2</Kbd> Find product</span>
          <span><Kbd>F4</Kbd> Customer</span>
          <span><Kbd>Alt</Kbd>+<Kbd>1</Kbd>…<Kbd>4</Kbd> Payment</span>
          <span><Kbd>F8</Kbd> Admin PIN</span>
          <span><Kbd>F10</Kbd> Save &amp; print</span>
          <span><Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> Save only</span>
          <span><Kbd>Ctrl</Kbd>+<Kbd>L</Kbd> Lock / switch user</span>
        </div>
      </section>

      {/* ---------------------------------------------------- summary */}
      <aside aria-label="Bill summary" className="flex w-full flex-[1_1_340px] flex-col gap-3 md:max-w-[400px]">
        <div className="flex flex-col gap-2.5 rounded-[6px] border border-line bg-white px-4 py-3.5">
          <div className="flex items-center justify-between">
            <span className="eyebrow">{t('Customer')}</span>
            {draft.customer ? (
              <button type="button" onClick={() => setDraft((d) => ({ ...d, customer: null }))} className="h-[30px] rounded-[6px] border border-line-2 px-2.5 text-[13px] font-semibold hover:bg-paper">
                Change <Kbd>F4</Kbd>
              </button>
            ) : (
              <button type="button" onClick={() => setAddCustomerOpen(true)} className="h-[30px] rounded-[6px] border border-line-2 px-2.5 text-[13px] font-semibold hover:bg-paper">
                {t('+ New customer')}
              </button>
            )}
          </div>
          {draft.customer ? (
            <>
              <div>
                <div className="text-base font-bold">{draft.customer.name}</div>
                <div className="text-[13px] text-ink-3">{[draft.customer.phone, draft.customer.address].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className={cx('rounded-[4px] px-2.5 py-2', draft.customer.balance_paise > 0 ? 'bg-warn-soft text-warn-ink' : 'bg-concrete')}>
                  <div className="text-[11px]">{t('Balance due')}</div>
                  <div className="num text-[15px] font-extrabold">₹{formatPaise(draft.customer.balance_paise)}</div>
                </div>
                <div className="rounded-[4px] bg-concrete px-2.5 py-2">
                  <div className="text-[11px] text-ink-3">{t('Credit limit')}</div>
                  <div className="num text-[15px] font-bold">{draft.customer.credit_limit_paise != null ? `₹${formatPaise(draft.customer.credit_limit_paise)}` : 'Not set'}</div>
                </div>
              </div>
            </>
          ) : (
            <div className="relative flex flex-col gap-2">
              <input
                ref={custRef}
                aria-label="Find customer by name or phone"
                placeholder="Find customer by name or phone…"
                value={custQ}
                onChange={(e) => setCustQ(e.target.value)}
                className="h-10 rounded-[6px] border border-line-2 px-3 text-sm outline-none focus:border-teal focus:ring-4 focus:ring-teal-soft"
              />
              {custQ.trim().length >= 2 && (
                <div className="absolute inset-x-0 top-11 z-20 max-h-72 overflow-auto rounded-[6px] border border-line bg-white shadow-xl">
                  {(custResults.data ?? []).map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => {
                        setDraft((d) => ({ ...d, customer: c, pos: null }));
                        setCustQ('');
                      }}
                      className="flex w-full items-center justify-between gap-2 border-t border-line-3 px-3 py-2 text-left first:border-t-0 hover:bg-teal-soft"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{c.name}</span>
                        <span className="block text-xs text-ink-3">{c.phone ?? 'No phone'}</span>
                      </span>
                      {c.balance_paise > 0 && <span className="num text-xs font-bold text-warn">₹{formatPaise(c.balance_paise)} due</span>}
                    </button>
                  ))}
                  {custResults.data?.length === 0 && (
                    <button type="button" onClick={() => setAddCustomerOpen(true)} className="w-full px-3 py-2.5 text-left text-sm font-semibold text-teal hover:bg-teal-soft">
                      No match — add “{custQ}” as new customer
                    </button>
                  )}
                </div>
              )}
              <div className="text-xs text-ink-3">Walk-in (optional name and phone; name and address needed for bills of ₹50,000 or more):</div>
              <div className="grid grid-cols-2 gap-2">
                <Input aria-label="Walk-in name" placeholder="Name" value={draft.walkinName} onChange={(e) => setDraft((d) => ({ ...d, walkinName: e.target.value }))} />
                <Input aria-label="Walk-in phone" placeholder="Phone" inputMode="tel" value={draft.walkinPhone} onChange={(e) => setDraft((d) => ({ ...d, walkinPhone: e.target.value }))} />
                <Input aria-label="Walk-in address" placeholder="Address / village" className="col-span-2" value={draft.walkinAddress ?? ''} onChange={(e) => setDraft((d) => ({ ...d, walkinAddress: e.target.value }))} />
              </div>
            </div>
          )}
        </div>

        <PartnerPicker partner={draft.partner ?? null} siteId={draft.siteId ?? null} onChange={(partner, siteId) => setDraft((d) => ({ ...d, partner, siteId }))} />

        <div className="flex flex-col gap-2.5 rounded-[6px] border border-line bg-white px-4 py-3.5">
          <span className="eyebrow">{t('Payment')}</span>
          <div role="radiogroup" aria-label="Payment mode" className="grid grid-cols-4 gap-1.5">
            {MODES.map((m, i) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={draft.mode === m}
                title={`Alt+${i + 1}`}
                onClick={() => setDraft((d) => ({ ...d, mode: m }))}
                className={cx('h-11 rounded-[6px] text-sm', draft.mode === m ? 'border-2 border-teal bg-teal font-bold text-white' : 'border border-line-2 bg-white font-semibold hover:bg-paper')}
              >
                {t(MODE_LABEL[m]!)}
              </button>
            ))}
          </div>
          {creditProblem && <div className="text-xs text-bad">Choose a customer for a credit bill.</div>}
          <label className="mt-1 flex items-center justify-between gap-2 text-xs text-ink-3">
            <span>
              {t('Place of supply')} {supply === 'inter' && <b className="text-teal">· IGST</b>}
            </span>
            <select
              aria-label="Place of supply"
              value={pos}
              onChange={(e) => setDraft((d) => ({ ...d, pos: e.target.value === (custState ?? shopState) ? null : e.target.value }))}
              className="max-w-[60%] rounded-[4px] border border-line bg-white px-1 py-0.5 text-xs text-ink"
            >
              {Object.entries(STATES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name} ({code})
                </option>
              ))}
            </select>
          </label>
          {balanceAfter != null && (
            <div className={cx('num text-xs', overLimit ? 'font-bold text-bad' : 'text-ink-3')}>
              After this bill: balance ₹{formatPaise(balanceAfter)}
              {draft.customer?.credit_limit_paise != null && ` of ₹${formatPaise(draft.customer.credit_limit_paise)} limit`}
              {overLimit && ' — over the credit limit'}
            </div>
          )}
        </div>

        <div className="num flex flex-col gap-1.5 rounded-[6px] border border-line bg-white px-4 py-3.5 text-sm">
          <Row label={t('Gross')} value={`₹${formatPaise(totals.grossPaise)}`} />
          <Row label={t('Discount')} value={totals.discountPaise ? `− ₹${formatPaise(totals.discountPaise)}` : '₹0.00'} />
          <Row label={t('Taxable value')} value={`₹${formatPaise(totals.taxablePaise)}`} />
          {supply === 'intra' ? (
            <>
              <Row label="CGST" value={`₹${formatPaise(totals.cgstPaise)}`} />
              <Row label="SGST" value={`₹${formatPaise(totals.sgstPaise)}`} />
            </>
          ) : (
            <Row label="IGST" value={`₹${formatPaise(totals.igstPaise)}`} />
          )}
          <Row label={t('Round off')} value={`${totals.roundOffPaise < 0 ? '− ' : ''}₹${formatPaise(Math.abs(totals.roundOffPaise))}`} />
          <div className="my-1.5 h-px bg-line" />
          <div className="flex items-baseline justify-between">
            <span className="headline text-[15px] tracking-[.04em]">{t('Total')}</span>
            <span className="text-[38px] font-extrabold" style={{ fontStretch: '80%' }}>
              ₹{formatPaise(totals.totalPaise)}
            </span>
          </div>
        </div>

        {b2bNoAddress && <Notice tone="bad">{draft.customer?.name} is a registered business. Add their address in Customers — it must be on the GST bill.</Notice>}
        {bigNoDetails && <Notice tone="bad">Bills of ₹50,000 or more need the customer’s name and address (GST rule). Choose the customer, or type the walk-in name and address.</Notice>}
        {blockedLine >= 0 && <Notice tone="bad">Line {blockedLine + 1} needs admin approval before this bill can be saved.</Notice>}
        {shortLine >= 0 && blockedLine < 0 && <Notice tone="bad">Line {shortLine + 1} has more than the stock available.</Notice>}
        {invalidLine >= 0 && <Notice tone="bad">Line {invalidLine + 1} has a quantity, rate or discount that isn’t a valid number.</Notice>}

        <Button variant="primary" size="lg" disabled={!canSave} busy={saving} onClick={() => void save(true)} className="h-14 text-lg font-extrabold tracking-[.04em]">
          {user?.language === 'te' ? t('Save & print') : 'SAVE & PRINT'} <span className="kbd !border-white/70 !bg-transparent !text-white">F10</span>
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button disabled={!canSave || saving} onClick={() => void save(false)} className="h-11">
            {t('Save only')}
          </Button>
          <Button
            variant="danger"
            className="h-11"
            disabled={!draft.lines.length && !draft.customer}
            onClick={() => {
              if (confirm('Clear this bill? All items will be removed.')) {
                setDraftState(emptyDraft());
                del('/api/drafts/current').catch(() => {});
                searchRef.current?.focus();
              }
            }}
          >
            {t('Clear bill')}
          </Button>
        </div>
        <Field label={t('Note on bill (optional)')}>
          <Input value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} placeholder="e.g. deliver to site tomorrow" />
        </Field>
        {draft.savedAt && draft.lines.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-ink-3">
            <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1d7a3e" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
            Draft saved {new Date(draft.savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} — safe if the screen locks or the power goes
          </div>
        )}
      </aside>

      <EwayQuestion
        ask={ewayAsk}
        onYes={(id) => {
          setEwayAsk(null);
          navigate(`/sales?open=${id}&eway=1`);
        }}
        onDone={() => {
          setEwayAsk(null);
          setTimeout(() => searchRef.current?.focus(), 50);
        }}
      />
      <QuickCustomer
        open={addCustomerOpen}
        initialName={custQ}
        onClose={() => setAddCustomerOpen(false)}
        onCreated={(c) => {
          setDraft((d) => ({ ...d, customer: c, pos: null }));
          setCustQ('');
          setAddCustomerOpen(false);
        }}
      />
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-ink-3">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function QuickCustomer({ open, onClose, onCreated, initialName }: { open: boolean; onClose: () => void; onCreated: (c: Draft['customer'] & {}) => void; initialName: string }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      const looksLikePhone = /^\d[\d\s]{5,}$/.test(initialName.trim());
      setName(looksLikePhone ? '' : initialName);
      setPhone(looksLikePhone ? initialName.trim() : '');
      setAddress('');
      setError(null);
    }
  }, [open, initialName]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: number }>('/api/customers', { name, phone: phone || null, address: address || null });
      onCreated({ id: r.id, name, phone: phone || null, address: address || null, balance_paise: 0, credit_limit_paise: null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add customer');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New customer"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" busy={busy} disabled={name.trim().length < 2} onClick={submit}>
            Add customer
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Phone">
          <Input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Area / address">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

const NOT_NEEDED = ['Customer collected the goods from the shop', 'Goods not moving yet (delivery later)', 'Delivered by hand / no vehicle'];

/** After a bill above ₹50,000: is an e-way bill needed? Yes → the e-way bill form for that bill; No → noted with a reason. */
function EwayQuestion({ ask, onYes, onDone }: { ask: { id: number; number: string; totalPaise: number } | null; onYes: (id: number) => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState(NOT_NEEDED[0]!);
  const [busy, setBusy] = useState(false);
  const no = async () => {
    if (!ask) return;
    setBusy(true);
    try {
      await put(`/api/invoices/${ask.id}/transport`, { notNeededReason: reason });
      toast({ tone: 'good', text: `No e-way bill for ${ask.number}: ${reason.toLowerCase()}` });
      onDone();
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!ask}
      onClose={onDone}
      title="E-way bill needed?"
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Ask later
          </Button>
          <Button busy={busy} onClick={() => void no()}>
            No, not needed
          </Button>
          <Button variant="primary" onClick={() => ask && onYes(ask.id)}>
            Yes, make e-way bill
          </Button>
        </>
      }
    >
      {ask && (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Bill <b className="num">{ask.number}</b> is <b className="num">₹{formatPaise(ask.totalPaise)}</b>, above ₹50,000. If the goods go by vehicle (our delivery, a lorry or a transporter), an e-way bill is needed before they leave.
          </p>
          <Field label="If not needed, why?">
            <select className="h-11 rounded-[6px] border border-line-2 bg-white px-3" value={reason} onChange={(e) => setReason(e.target.value)}>
              {NOT_NEEDED.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <p className="text-[12px] text-ink-3">“Ask later” keeps it on the bill as “E-way bill needed…” in Sales.</p>
        </div>
      )}
    </Modal>
  );
}

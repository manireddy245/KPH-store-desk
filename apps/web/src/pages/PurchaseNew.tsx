import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { exclFromIncl, formatPaise, formatPercent, formatQty, mulDivRound, parsePercent, parseQty, parseRupees, toBase } from '@kph/core';
import { ApiError, get, post, store } from '../lib/api';
import { todayIst, uuid } from '../lib/format';
import { preparePage, type PreparedPage } from '../lib/images';
import { useSession } from '../lib/session';
import type { ProductRow, SupplierRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Field, Input, Modal, Notice, PageTitle, Select, cx, useToast } from '../components/ui';

type MatchKind = 'remembered' | 'sku' | 'name' | 'none' | 'manual';

interface LineDraft {
  key: string;
  description: string;
  hsn: string;
  billUnit: string | null;
  qtyText: string;
  amountText: string; // value of the line after discount (₹), excl. or incl. GST per draft.amountMode
  /** Unit the quantity is in (default: matched from the bill, else our base unit). */
  unitCode?: string | null;
  /** Actual count received in our base unit (overrides the conversion). */
  countText?: string;
  gstText: string;
  productId: number | null;
  newProduct: { name: string; unitCode: string } | null;
  match: MatchKind;
  lastCostPaise: number | null;
  warnings: string[];
}

interface Draft {
  clientRef: string;
  scanId: number | null;
  pageCount: number;
  supplierId: number | null;
  supplierRead: { name: string | null; gstin: string | null } | null;
  billNo: string;
  billDate: string;
  supplyType: 'intra' | 'inter';
  amountMode?: 'excl' | 'incl';
  freightText: string;
  billTotalText: string;
  notes: string;
  scanNotes: string | null;
  duplicateOf: string | null;
  lines: LineDraft[];
}

interface ScanResult {
  scanId: number;
  pageCount: number;
  supplier: { name: string | null; gstin: string | null; matchedId: number | null; matchedBy: string };
  invoice: { number: string | null; date: string | null; isInterstate: boolean | null };
  lines: {
    description: string;
    hsn: string | null;
    qtyMilli: number | null;
    billUnit: string | null;
    taxablePaise: number | null;
    gstRateBp: number | null;
    match: { kind: MatchKind; productId: number | null };
    lastCostPaise: number | null;
    warnings: string[];
  }[];
  freightPaise: number | null;
  grandTotalPaise: number | null;
  notes: string | null;
  duplicateOf: string | null;
}

const rs = (p: number | null | undefined) => (p == null ? '' : formatPaise(p).replace(/,/g, ''));
const emptyLine = (): LineDraft => ({ key: uuid(), description: '', hsn: '', billUnit: null, qtyText: '', amountText: '', gstText: '18', productId: null, newProduct: null, match: 'manual', lastCostPaise: null, warnings: [] });
const emptyDraft = (): Draft => ({ clientRef: uuid(), scanId: null, pageCount: 0, supplierId: null, supplierRead: null, billNo: '', billDate: todayIst(), supplyType: 'intra', freightText: '', billTotalText: '', notes: '', scanNotes: null, duplicateOf: null, lines: [emptyLine()] });

const UNIT_ALIASES: Record<string, string> = { bags: 'bag', bag: 'bag', nos: 'nos', no: 'nos', pcs: 'pcs', pc: 'pcs', kg: 'kg', kgs: 'kg', ton: 'tonne', tons: 'tonne', mt: 'tonne', tonne: 'tonne', ltr: 'ltr', l: 'ltr', litre: 'ltr', ltrs: 'ltr', mtr: 'mtr', m: 'mtr', coil: 'coil', coils: 'coil', box: 'box', set: 'set', sets: 'set', rod: 'rod', rods: 'rod', bundle: 'bundle', bundles: 'bundle', tin: 'tin', tins: 'tin', bucket: 'bucket', length: 'length', lengths: 'length', ft: 'ft' };
const unitCode = (u: string | null) => (u ? (UNIT_ALIASES[u.toLowerCase().replace(/[^a-z]/g, '')] ?? null) : null);

export function PurchaseNew() {
  const { boot, user, can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const draftKey = `kph.purchaseDraft.${store.workspace}.${boot?.device?.id}.${user?.userId}`;

  const products = useQuery({ queryKey: ['products', 'all-active'], queryFn: () => get<ProductRow[]>('/api/products') });
  const suppliers = useQuery({ queryKey: ['suppliers', 'all'], queryFn: () => get<SupplierRow[]>('/api/suppliers') });
  const byId = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);

  const [draft, setDraft] = useState<Draft | null>(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) return JSON.parse(raw) as Draft;
    } catch {
      /* ignore */
    }
    return params.get('manual') ? emptyDraft() : null;
  });
  useEffect(() => {
    try {
      if (draft) localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [draft, draftKey]);

  // A bill photo read in the assistant chat opens straight in review.
  const location = useLocation();
  useEffect(() => {
    const scan = (location.state as { scan?: ScanResult } | null)?.scan;
    if (!scan) return;
    navigate(location.pathname, { replace: true, state: null });
    setDraft(fromScan(scan));
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- capture
  const [pages, setPages] = useState<PreparedPage[]>([]);
  const [chosenSupplier, setChosenSupplier] = useState<number | ''>('');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const next = [...pages];
    for (const f of Array.from(files)) {
      if (next.length >= 6) break;
      next.push(await preparePage(f));
    }
    setPages(next);
  };

  const read = async () => {
    setReading(true);
    setReadError(null);
    try {
      const r = await post<ScanResult>('/api/purchases/scan', { supplierId: chosenSupplier || null, pages: pages.map((p) => ({ mimeType: p.mimeType, base64: p.base64 })) });
      setDraft(fromScan(r));
    } catch (e) {
      setReadError(e instanceof ApiError ? e.message : 'The scanner could not read this bill.');
    } finally {
      setReading(false);
    }
  };

  // ---------------------------------------------------------------- review helpers
  const update = (fn: (d: Draft) => Draft) => setDraft((d) => (d ? fn(d) : d));
  const setLine = (key: string, patch: Partial<LineDraft>) => update((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  if (!draft) {
    return (
      <Page>
        <PageTitle telugu="సరఫరాదారు బిల్లు" title="Scan supplier bill" sub="Photograph every page, or choose the PDF the supplier sent. Nothing is added to stock until someone checks the items and saves." />
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <section className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {pages.map((p, i) => (
                <div key={p.previewUrl} className="relative h-52 overflow-hidden rounded-[6px] border border-line bg-white">
                  {p.mimeType === 'application/pdf' ? (
                    <div className="grid h-full place-items-center p-3 text-center text-sm">
                      <div>
                        <div className="headline text-3xl text-brick">PDF</div>
                        <div className="mt-1 break-all text-ink-3">{p.name}</div>
                      </div>
                    </div>
                  ) : (
                    <img src={p.previewUrl} alt={`Page ${i + 1}`} className="h-full w-full object-cover" />
                  )}
                  <span className="absolute bottom-2 left-2 rounded-[3px] bg-ink px-2 py-0.5 text-xs font-bold text-white">Page {i + 1}</span>
                  <button type="button" aria-label={`Remove page ${i + 1}`} onClick={() => setPages(pages.filter((_, j) => j !== i))} className="absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-full bg-ink/75 text-white">
                    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
              {pages.length < 6 && (
                <button type="button" onClick={() => cameraRef.current?.click()} className="flex h-52 flex-col items-center justify-center gap-2 rounded-[6px] border-2 border-dashed border-line-2 bg-white text-ink-2 hover:bg-paper">
                  <svg aria-hidden width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16181b" strokeWidth="1.8"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                  <b className="text-[15px]">{pages.length ? `Add page ${pages.length + 1}` : 'Take a photo'}</b>
                  <span className="text-xs text-ink-3">Opens the camera on a phone</span>
                </button>
              )}
            </div>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ''))} />
            <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ''))} />
            <div>
              <Button onClick={() => fileRef.current?.click()}>Choose photo or PDF file…</Button>
            </div>
            <Notice tone="teal">Lay the bill flat in good light with all four corners in the photo. Up to 6 pages per bill.</Notice>
          </section>
          <aside className="flex flex-col gap-3">
            <Field label="Supplier (optional — the scanner reads it from the bill)">
              <Select value={chosenSupplier} onChange={(e) => setChosenSupplier(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Let the scanner find it</option>
                {(suppliers.data ?? []).filter((s) => s.active).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            {readError && <Notice tone="bad">{readError}</Notice>}
            <Button variant="primary" size="lg" disabled={!pages.length} busy={reading} onClick={read} className="font-extrabold tracking-[.04em]">
              {reading ? 'READING THE BILL…' : `READ THE BILL${pages.length ? ` · ${pages.length} PAGE${pages.length > 1 ? 'S' : ''}` : ''}`}
            </Button>
            <p className="text-center text-xs text-ink-3">Needs internet for about 10–30 seconds. No internet? Enter the bill by hand.</p>
            <Button variant="ghost" onClick={() => setDraft(emptyDraft())}>
              Enter by hand instead
            </Button>
          </aside>
        </div>
      </Page>
    );
  }

  return (
    <Review
      draft={draft}
      update={update}
      setLine={setLine}
      pages={pages}
      products={products.data ?? []}
      byId={byId}
      suppliers={suppliers.data ?? []}
      canNewProduct={can('products.manage')}
      canNewSupplier={can('suppliers.manage')}
      onDiscard={() => {
        if (!confirm('Discard this purchase? Nothing will be saved.')) return;
        setDraft(null);
        setPages([]);
      }}
      onSaved={async (r) => {
        setDraft(null);
        setPages([]);
        toast({ tone: 'good', text: <>Purchase <b className="num">{r.number}</b> saved — stock updated{r.createdProducts.length ? `, ${r.createdProducts.length} new product(s) created` : ''}.</> });
        await qc.invalidateQueries({ queryKey: ['products'] });
        await qc.invalidateQueries({ queryKey: ['purchases'] });
        navigate(`/purchases?open=${r.id}`);
      }}
    />
  );
}

function fromScan(r: ScanResult): Draft {
  return {
    ...emptyDraft(),
    scanId: r.scanId,
    pageCount: r.pageCount,
    supplierId: r.supplier.matchedId,
    supplierRead: { name: r.supplier.name, gstin: r.supplier.gstin },
    billNo: r.invoice.number ?? '',
    billDate: r.invoice.date ?? todayIst(),
    supplyType: r.invoice.isInterstate ? 'inter' : 'intra',
    freightText: rs(r.freightPaise),
    billTotalText: rs(r.grandTotalPaise),
    scanNotes: r.notes,
    duplicateOf: r.duplicateOf,
    lines: r.lines.map((l) => ({
      key: uuid(),
      description: l.description,
      hsn: l.hsn ?? '',
      billUnit: l.billUnit,
      qtyText: l.qtyMilli != null ? formatQty(l.qtyMilli) : '',
      amountText: rs(l.taxablePaise),
      gstText: l.gstRateBp != null ? formatPercent(l.gstRateBp) : '',
      productId: l.match.productId,
      newProduct: null,
      match: l.match.kind,
      lastCostPaise: l.lastCostPaise,
      warnings: l.warnings,
    })),
  };
}

// ==================================================================== review

function Review({
  draft,
  update,
  setLine,
  pages,
  products,
  byId,
  suppliers,
  canNewProduct,
  canNewSupplier,
  onDiscard,
  onSaved,
}: {
  draft: Draft;
  update: (fn: (d: Draft) => Draft) => void;
  setLine: (key: string, patch: Partial<LineDraft>) => void;
  pages: PreparedPage[];
  products: ProductRow[];
  byId: Map<number, ProductRow>;
  suppliers: SupplierRow[];
  canNewProduct: boolean;
  canNewSupplier: boolean;
  onDiscard: () => void;
  onSaved: (r: { id: number; number: string; createdProducts: number[] }) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSupplierOpen, setNewSupplierOpen] = useState(false);
  const [pageView, setPageView] = useState<string | null>(null);
  const qc = useQueryClient();

  const amountMode = draft.amountMode ?? 'excl';
  const rows = draft.lines.map((l) => {
    const qty = parseQty(l.qtyText);
    const typed = parseRupees(l.amountText);
    const gst = parsePercent(l.gstText);
    const amount = typed != null && gst != null && amountMode === 'incl' ? exclFromIncl(typed, gst) : typed;
    const p = l.productId ? byId.get(l.productId) : undefined;
    const buyUnits = p ? [p.unit_code, ...p.units.filter((u) => u.for_purchase).map((u) => u.unit_code)] : [];
    const billUnitCode = unitCode(l.billUnit);
    const chosenUnit = l.unitCode ?? (billUnitCode && buyUnits.includes(billUnitCode) ? billUnitCode : (p?.unit_code ?? null));
    const pu = p && chosenUnit && chosenUnit !== p.unit_code ? p.units.find((u) => u.unit_code === chosenUnit) : undefined;
    const converted = qty != null && pu ? toBase(qty, { num: pu.factor_num, den: pu.factor_den }).baseMilli : qty;
    const counted = l.countText?.trim() ? parseQty(l.countText) : null;
    const base = counted ?? converted;
    const ok = qty != null && qty > 0 && base != null && base > 0 && amount != null && amount >= 0 && gst != null && (!!p || !!l.newProduct) && (!l.countText?.trim() || counted != null);
    const half = ok ? mulDivRound(amount!, gst!, 20000) : 0;
    const igst = ok ? mulDivRound(amount!, gst!, 10000) : 0;
    const tax = draft.supplyType === 'inter' ? igst : 2 * half;
    const unitCost = ok && base ? mulDivRound(amount!, 1000, base) : null;
    const ourUnit = p?.unit_code ?? l.newProduct?.unitCode ?? null;
    const billUnit = unitCode(l.billUnit);
    const unitWarn = billUnit && ourUnit && billUnit !== chosenUnit && billUnit !== ourUnit ? `Bill counts in ${l.billUnit}; enter the quantity in ${chosenUnit ?? ourUnit}${p ? '' : ''}.` : null;
    const costWarn = unitCost != null && l.lastCostPaise && Math.abs(unitCost - l.lastCostPaise) / l.lastCostPaise > 0.25 ? `Cost ₹${formatPaise(unitCost)} is far from last time (₹${formatPaise(l.lastCostPaise)})` : null;
    return { l, p, qty, typed, amount, gst, ok, half, igst, tax, unitCost, ourUnit, unitWarn, costWarn, buyUnits, chosenUnit, base, converted, pu };
  });
  const taxable = rows.reduce((s, r) => s + (r.ok ? r.amount! : 0), 0);
  const cgst = draft.supplyType === 'intra' ? rows.reduce((s, r) => s + (r.ok ? r.half : 0), 0) : 0;
  const igst = draft.supplyType === 'inter' ? rows.reduce((s, r) => s + (r.ok ? r.igst : 0), 0) : 0;
  const freight = draft.freightText.trim() ? parseRupees(draft.freightText) : 0;
  const computed = taxable + 2 * cgst + igst + (freight ?? 0);
  const billTotal = draft.billTotalText.trim() ? parseRupees(draft.billTotalText) : null;
  const diff = billTotal != null ? billTotal - computed : 0;
  const units = rows.reduce((s, r) => s + (r.ok ? r.base! : 0), 0);
  const badLine = rows.findIndex((r) => !r.ok);
  const canSave = !!draft.supplierId && draft.billNo.trim() && /^\d{4}-\d{2}-\d{2}$/.test(draft.billDate) && rows.length > 0 && badLine < 0 && freight != null && Math.abs(diff) <= 1000;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await post<{ id: number; number: string; createdProducts: number[] }>('/api/purchases', {
        clientRef: draft.clientRef,
        supplierId: draft.supplierId,
        supplierInvoiceNo: draft.billNo.trim(),
        supplierInvoiceDate: draft.billDate,
        supplyType: draft.supplyType,
        freightPaise: freight ?? 0,
        billTotalPaise: billTotal ?? undefined,
        notes: draft.notes || undefined,
        scanId: draft.scanId ?? undefined,
        lines: rows.map((r) => ({
          productId: r.l.productId ?? undefined,
          newProduct: r.l.productId ? undefined : r.l.newProduct ? { name: r.l.newProduct.name, unitCode: r.l.newProduct.unitCode, hsn: r.l.hsn || null } : undefined,
          description: r.l.description || undefined,
          qtyMilli: r.qty!,
          unitCode: r.l.newProduct ? undefined : (r.chosenUnit ?? undefined),
          baseQtyMilli: r.l.countText?.trim() ? r.base! : undefined,
          amountPaise: r.typed!,
          amountMode,
          gstRateBp: r.gst!,
          hsn: r.l.hsn || null,
        })),
      });
      onSaved(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the purchase. It is kept on this screen — try again.');
    } finally {
      setSaving(false);
    }
  };

  const openServerPage = async (n: number) => {
    const res = await fetch(`/api/purchases/scans/${draft.scanId}/pages/${n}`, { headers: { 'x-device-token': store.deviceToken ?? '', authorization: `Bearer ${store.sessionToken}` } });
    if (res.ok) setPageView(URL.createObjectURL(await res.blob()));
  };

  return (
    <Page wide>
      <PageTitle
        telugu="కొనుగోలు తనిఖీ"
        title={draft.scanId ? 'Check the scanned bill' : 'Enter supplier bill'}
        sub={draft.scanId ? 'Read by the scanner — check every line before saving.' : 'Type the bill as printed. Amounts are before GST.'}
      />
      {draft.duplicateOf && <Notice tone="bad">This bill looks like one already entered as <b>{draft.duplicateOf}</b>. Saving it again would add the stock twice.</Notice>}
      {draft.scanNotes && <Notice tone="warn">Scanner note: {draft.scanNotes}</Notice>}

      <div className="flex flex-wrap items-start gap-4">
        {(pages.length > 0 || draft.pageCount > 0) && (
          <aside aria-label="Scanned pages" className="flex w-full flex-col gap-2 lg:max-w-[340px] lg:flex-[1_1_300px]">
            {pages.length > 0
              ? pages.map((p, i) =>
                  p.mimeType === 'application/pdf' ? (
                    <a key={i} href={p.previewUrl} target="_blank" rel="noreferrer" className="rounded-[6px] border border-line bg-white p-4 text-sm font-semibold underline">
                      Open PDF page {i + 1}
                    </a>
                  ) : (
                    <button key={i} type="button" onClick={() => setPageView(p.previewUrl)} className="overflow-hidden rounded-[6px] border border-line bg-white" aria-label={`Zoom page ${i + 1}`}>
                      <img src={p.previewUrl} alt={`Page ${i + 1} of the supplier bill`} className="max-h-[480px] w-full object-contain" />
                    </button>
                  ),
                )
              : Array.from({ length: draft.pageCount }, (_, i) => (
                  <Button key={i} onClick={() => void openServerPage(i + 1)}>
                    View scanned page {i + 1}
                  </Button>
                ))}
            <span className="text-xs text-ink-3">The pages are kept with the purchase for checking later.</span>
          </aside>
        )}

        <section className="flex min-w-0 flex-[999_1_720px] flex-col gap-3">
          <div className="grid gap-3 rounded-[6px] border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Supplier"
              className="sm:col-span-2"
              hint={draft.supplierRead?.name ? `On the bill: ${draft.supplierRead.name}${draft.supplierRead.gstin ? ` · ${draft.supplierRead.gstin}` : ''}` : undefined}
              error={!draft.supplierId ? 'Choose the supplier' : undefined}
            >
              <div className="flex gap-2">
                <Select value={draft.supplierId ?? ''} onChange={(e) => update((d) => ({ ...d, supplierId: e.target.value ? Number(e.target.value) : null }))}>
                  <option value="">— choose —</option>
                  {suppliers.filter((s) => s.active).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                {canNewSupplier && (
                  <Button onClick={() => setNewSupplierOpen(true)} className="whitespace-nowrap">
                    + New
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Supplier bill no.">
              <Input className="num" value={draft.billNo} onChange={(e) => update((d) => ({ ...d, billNo: e.target.value }))} />
            </Field>
            <Field label="Bill date">
              <Input type="date" value={draft.billDate} max={todayIst()} onChange={(e) => update((d) => ({ ...d, billDate: e.target.value }))} />
            </Field>
            <Field label="Line amounts on the bill are">
              <Select value={amountMode} onChange={(e) => update((d) => ({ ...d, amountMode: e.target.value as 'excl' | 'incl' }))}>
                <option value="excl">Before GST (taxable value)</option>
                <option value="incl">Including GST</option>
              </Select>
            </Field>
            <Field label="GST type">
              <Select value={draft.supplyType} onChange={(e) => update((d) => ({ ...d, supplyType: e.target.value as 'intra' | 'inter' }))}>
                <option value="intra">Within AP — CGST + SGST</option>
                <option value="inter">From another state — IGST</option>
              </Select>
            </Field>
            <Field label="Freight / loading on bill (₹)">
              <Input className="num" inputMode="decimal" value={draft.freightText} onChange={(e) => update((d) => ({ ...d, freightText: e.target.value }))} />
            </Field>
            <Field label="Bill grand total (₹)" hint="As printed — used to check the lines">
              <Input className="num" inputMode="decimal" value={draft.billTotalText} onChange={(e) => update((d) => ({ ...d, billTotalText: e.target.value }))} />
            </Field>
            <Field label="Note">
              <Input value={draft.notes} onChange={(e) => update((d) => ({ ...d, notes: e.target.value }))} />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <div key={r.l.key} className={cx('rounded-[6px] border bg-white p-3', !r.ok ? 'border-bad/50' : r.l.newProduct ? 'border-warn/60 bg-[#fffbf2]' : 'border-line')}>
                <div className="grid gap-3 lg:grid-cols-[minmax(180px,1.1fr)_minmax(220px,1.6fr)_90px_120px_70px_110px_32px]">
                  <div className="min-w-0">
                    <div className="eyebrow lg:hidden">On the bill</div>
                    <Input aria-label={`Line ${i + 1} as on the bill`} value={r.l.description} placeholder="Item as printed" onChange={(e) => setLine(r.l.key, { description: e.target.value })} className="h-9 font-semibold" />
                    <div className="mt-1 flex items-center gap-2 text-xs text-ink-3">
                      HSN
                      <input aria-label="HSN" value={r.l.hsn} onChange={(e) => setLine(r.l.key, { hsn: e.target.value })} className="num w-20 rounded-[4px] border border-line px-1.5 py-0.5" />
                      {r.l.billUnit && <span>· bill unit {r.l.billUnit}</span>}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="eyebrow lg:hidden">Our product</div>
                    <ProductPicker
                      products={products}
                      value={r.l.productId}
                      newProduct={r.l.newProduct}
                      allowNew={canNewProduct}
                      suggestedName={r.l.description}
                      suggestedUnit={unitCode(r.l.billUnit) ?? 'pcs'}
                      onChange={(id) => setLine(r.l.key, { productId: id, newProduct: null, match: 'manual' })}
                      onNew={(np) => setLine(r.l.key, { productId: null, newProduct: np, match: 'manual' })}
                    />
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <MatchBadge kind={r.l.newProduct ? 'new' : r.l.productId ? r.l.match : 'none'} />
                      {r.l.lastCostPaise != null && <span className="text-ink-3">last cost ₹{formatPaise(r.l.lastCostPaise)}</span>}
                    </div>
                  </div>
                  <div>
                    <div className="eyebrow lg:hidden">Qty</div>
                    <Input aria-label="Quantity in our unit" inputMode="decimal" value={r.l.qtyText} onChange={(e) => setLine(r.l.key, { qtyText: e.target.value })} className={cx('num h-9 text-right', r.qty == null && 'border-bad')} />
                    {r.buyUnits.length > 1 ? (
                      <select
                        aria-label="Unit bought in"
                        value={r.chosenUnit ?? ''}
                        onChange={(e) => setLine(r.l.key, { unitCode: e.target.value, countText: '' })}
                        className="mt-0.5 w-full rounded-[4px] border border-line bg-white px-1 text-right text-[11px]"
                      >
                        {r.buyUnits.map((u) => (
                          <option key={u}>{u}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="mt-0.5 text-right text-[11px] text-cement">{r.ourUnit ?? ''}</div>
                    )}
                    {r.pu && r.converted != null && (
                      <div className="mt-1 text-right text-[11px] text-ink-2">
                        = {formatQty(r.converted)} {r.ourUnit}
                        <label className="mt-0.5 flex items-center justify-end gap-1">
                          counted
                          <input
                            aria-label={`Actual ${r.ourUnit} counted`}
                            inputMode="decimal"
                            placeholder={formatQty(r.converted)}
                            value={r.l.countText ?? ''}
                            onChange={(e) => setLine(r.l.key, { countText: e.target.value })}
                            className="num w-16 rounded-[4px] border border-line px-1 text-right"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="eyebrow lg:hidden">Amount {amountMode === 'incl' ? 'incl.' : 'excl.'} GST</div>
                    <Input aria-label={`Amount ${amountMode === 'incl' ? 'including' : 'excluding'} GST`} inputMode="decimal" value={r.l.amountText} onChange={(e) => setLine(r.l.key, { amountText: e.target.value })} className={cx('num h-9 text-right', r.amount == null && 'border-bad')} />
                    <div className="num mt-0.5 text-right text-[11px] text-cement">{r.unitCost != null ? `₹${formatPaise(r.unitCost)} / ${r.ourUnit ?? 'unit'}` : ''}</div>
                  </div>
                  <div>
                    <div className="eyebrow lg:hidden">GST %</div>
                    <Input aria-label="GST percent" inputMode="decimal" value={r.l.gstText} onChange={(e) => setLine(r.l.key, { gstText: e.target.value })} className={cx('num h-9 text-right', r.gst == null && 'border-bad')} />
                  </div>
                  <div className="num pt-2 text-right font-bold">{r.ok ? `₹${formatPaise(r.amount! + r.tax)}` : '—'}</div>
                  <button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => update((d) => ({ ...d, lines: d.lines.filter((x) => x.key !== r.l.key) }))} className="grid size-8 place-items-center self-start rounded-[4px] text-cement hover:bg-bad-soft hover:text-bad">
                    <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                {[...r.l.warnings, r.unitWarn, r.costWarn].filter(Boolean).length > 0 && (
                  <ul className="mt-2 flex flex-col gap-0.5 text-xs text-warn">
                    {[...new Set([...r.l.warnings, r.unitWarn, r.costWarn].filter(Boolean))].map((w) => (
                      <li key={w}>! {w}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <div>
              <Button onClick={() => update((d) => ({ ...d, lines: [...d.lines, emptyLine()] }))}>+ Add line</Button>
            </div>
          </div>

          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-2">
              {billTotal == null ? (
                <Notice tone="warn">Type the bill’s grand total to check the lines add up.</Notice>
              ) : diff === 0 ? (
                <Notice tone="good">
                  <b>Totals match the bill.</b> Bill ₹{formatPaise(billTotal)} · our calculation ₹{formatPaise(computed)}.
                </Notice>
              ) : Math.abs(diff) <= 1000 ? (
                <Notice tone="good">
                  Totals match within ₹{formatPaise(Math.abs(diff))} — saved as round-off.
                </Notice>
              ) : (
                <Notice tone="bad">
                  <b>Doesn’t add up.</b> Bill says ₹{formatPaise(billTotal)} but the lines come to ₹{formatPaise(computed)} (difference ₹{formatPaise(Math.abs(diff))}). Check quantities, amounts and GST.
                </Notice>
              )}
              {rows.some((r) => r.l.newProduct) && <Notice tone="warn">New products will be created with the details shown. Set their selling price and discount limit in Inventory.</Notice>}
              {badLine >= 0 && <Notice tone="bad">Line {badLine + 1}: choose our product and fill quantity, amount and GST.</Notice>}
              {error && <Notice tone="bad">{error}</Notice>}
            </div>
            <div className="num grid flex-[0_1_340px] grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-[6px] border border-line bg-white px-4 py-3.5 text-sm">
              <span className="text-ink-3">Taxable value</span>
              <span className="text-right">₹{formatPaise(taxable)}</span>
              {draft.supplyType === 'intra' ? (
                <>
                  <span className="text-ink-3">CGST</span>
                  <span className="text-right">₹{formatPaise(cgst)}</span>
                  <span className="text-ink-3">SGST</span>
                  <span className="text-right">₹{formatPaise(cgst)}</span>
                </>
              ) : (
                <>
                  <span className="text-ink-3">IGST</span>
                  <span className="text-right">₹{formatPaise(igst)}</span>
                </>
              )}
              <span className="text-ink-3">Freight / loading</span>
              <span className="text-right">₹{formatPaise(freight ?? 0)}</span>
              {billTotal != null && diff !== 0 && Math.abs(diff) <= 1000 && (
                <>
                  <span className="text-ink-3">Round off</span>
                  <span className="text-right">{formatPaise(diff)}</span>
                </>
              )}
              <span className="headline border-t border-line pt-1.5 text-[15px] tracking-[.04em]">Total</span>
              <span className="border-t border-line pt-1.5 text-right text-2xl font-extrabold">₹{formatPaise(billTotal != null && Math.abs(diff) <= 1000 ? billTotal : computed)}</span>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button size="lg" onClick={onDiscard}>
              Discard
            </Button>
            <Button variant="primary" size="lg" disabled={!canSave} busy={saving} onClick={save} className="font-extrabold tracking-[.04em]">
              SAVE PURCHASE · ADD {formatQty(units)} TO STOCK
            </Button>
          </div>
        </section>
      </div>

      <Modal open={!!pageView} onClose={() => setPageView(null)} title="Scanned page" width={1000}>
        {pageView && <img src={pageView} alt="Scanned supplier bill" className="w-full" />}
      </Modal>
      <NewSupplier
        open={newSupplierOpen}
        initial={draft.supplierRead}
        onClose={() => setNewSupplierOpen(false)}
        onCreated={async (id) => {
          await qc.invalidateQueries({ queryKey: ['suppliers'] });
          update((d) => ({ ...d, supplierId: id }));
          setNewSupplierOpen(false);
        }}
      />
    </Page>
  );
}

function MatchBadge({ kind }: { kind: MatchKind | 'new' }) {
  const map = {
    remembered: ['good', 'Remembered', 'matched like last time'],
    sku: ['good', 'Item code', 'matched by SKU'],
    name: ['teal', 'Name match', 'please check'],
    manual: ['neutral', 'Chosen', ''],
    none: ['bad', 'Not matched', 'choose our product or create it'],
    new: ['warn', 'New', 'will be created'],
  } as const;
  const [tone, label, note] = map[kind];
  return (
    <>
      <Badge tone={tone}>{label}</Badge>
      {note && <span className="text-ink-3">{note}</span>}
    </>
  );
}

function ProductPicker({
  products,
  value,
  newProduct,
  allowNew,
  suggestedName,
  suggestedUnit,
  onChange,
  onNew,
}: {
  products: ProductRow[];
  value: number | null;
  newProduct: { name: string; unitCode: string } | null;
  allowNew: boolean;
  suggestedName: string;
  suggestedUnit: string;
  onChange: (id: number) => void;
  onNew: (np: { name: string; unitCode: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const selected = value ? products.find((p) => p.id === value) : null;
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return products.filter((p) => words.every((w) => `${p.name} ${p.sku} ${p.brand_name ?? ''}`.toLowerCase().includes(w))).slice(0, 8);
  }, [q, products]);

  return (
    <div className="relative">
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setQ('');
          }}
          className={cx('flex h-9 w-full items-center justify-between gap-2 rounded-[6px] border bg-white px-2.5 text-left text-sm', selected || newProduct ? 'border-line-2' : 'border-bad')}
        >
          <span className="truncate">{selected ? selected.name : newProduct ? `+ New: ${newProduct.name}` : 'Choose our product…'}</span>
          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      ) : (
        <>
          <Input autoFocus placeholder="Search our products…" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} className="h-9" />
          <div className="absolute inset-x-0 top-10 z-20 max-h-72 overflow-auto rounded-[6px] border border-line bg-white shadow-xl">
            {list.map((p) => (
              <button
                key={p.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(p.id);
                  setOpen(false);
                }}
                className="flex w-full justify-between gap-2 border-t border-line-3 px-3 py-2 text-left text-sm first:border-t-0 hover:bg-teal-soft"
              >
                <span className="min-w-0 truncate">{p.name}</span>
                <span className="whitespace-nowrap text-xs text-ink-3">{p.unit_code}</span>
              </button>
            ))}
            {list.length === 0 && <div className="px-3 py-2 text-sm text-ink-3">No product matches.</div>}
            {allowNew && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  setNewOpen(true);
                }}
                className="w-full border-t border-line px-3 py-2 text-left text-sm font-bold text-brick hover:bg-paper"
              >
                + Create a new product…
              </button>
            )}
          </div>
        </>
      )}
      <NewProductModal open={newOpen} name={suggestedName} unit={suggestedUnit} onClose={() => setNewOpen(false)} onSave={(np) => (onNew(np), setNewOpen(false))} />
    </div>
  );
}

function NewProductModal({ open, name, unit, onClose, onSave }: { open: boolean; name: string; unit: string; onClose: () => void; onSave: (np: { name: string; unitCode: string }) => void }) {
  const units = useQuery({ queryKey: ['units'], queryFn: () => get<{ code: string; name: string }[]>('/api/units'), enabled: open });
  const [n, setN] = useState('');
  const [u, setU] = useState('pcs');
  useEffect(() => {
    if (open) {
      setN(
        name
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .trim(),
      );
      setU(unit);
    }
  }, [open, name, unit]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New product"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" disabled={n.trim().length < 2} onClick={() => onSave({ name: n.trim(), unitCode: u })}>
            Use this
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Product name (as we will sell it)">
          <Input value={n} onChange={(e) => setN(e.target.value)} autoFocus />
        </Field>
        <Field label="Unit we stock it in">
          <Select value={u} onChange={(e) => setU(e.target.value)}>
            {(units.data ?? [{ code: u, name: u }]).map((x) => (
              <option key={x.code} value={x.code}>
                {x.code} — {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-xs text-ink-3">It is created when the purchase is saved, with this bill’s cost and GST. Add the selling price in Inventory afterwards.</p>
      </div>
    </Modal>
  );
}

function NewSupplier({ open, initial, onClose, onCreated }: { open: boolean; initial: { name: string | null; gstin: string | null } | null; onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState('');
  const [gstin, setGstin] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '');
      setGstin(initial?.gstin ?? '');
      setPhone('');
      setError(null);
    }
  }, [open, initial]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: number }>('/api/suppliers', { name, gstin: gstin || null, phone: phone || null });
      onCreated(r.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add supplier');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New supplier"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" busy={busy} disabled={name.trim().length < 2} onClick={save}>
            Add supplier
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="GSTIN">
          <Input value={gstin} onChange={(e) => setGstin(e.target.value)} />
        </Field>
        <Field label="Phone">
          <Input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
      </div>
    </Modal>
  );
}


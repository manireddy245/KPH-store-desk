import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { exclFromIncl, formatPaise, formatPercent, formatQty, inclFromExcl, parsePercent, parseQty, parseRupees, standardRodsPerTonne, formatCost, parseCost, parseMarkup, priceFromCost } from '@kph/core';
import { ApiError, del, get, patch, post } from '../lib/api';
import { csvCell, downloadText, fmtDateTime } from '../lib/format';
import { useSession } from '../lib/session';
import type { Category, ProductRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Checkbox, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, cx, useToast } from '../components/ui';

const statusTone = { ok: 'text-good', low: 'text-warn', out: 'text-bad', service: 'text-ink-3' } as const;

export function Inventory() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const stock = (params.get('stock') as 'low' | 'out' | null) ?? '';
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const all = useQuery({ queryKey: ['products', 'all', showInactive], queryFn: () => get<ProductRow[]>(`/api/products${showInactive ? '?includeInactive=true' : ''}`) });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => get<Category[]>('/api/categories') });
  const [editing, setEditing] = useState<ProductRow | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<ProductRow | null>(null);
  const [card, setCard] = useState<ProductRow | null>(null);
  /** Quick price from cost: a markup chip dropped on (or tapped onto) a product opens its price box with "+N%". */
  const [armed, setArmed] = useState<string | null>(null);
  const [dropped, setDropped] = useState<{ id: number; text: string; n: number } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const quickPrice = can('products.edit_price') && can('products.view_cost');
  const dropOn = (p: ProductRow, text: string) => {
    setDropped((d) => ({ id: p.id, text, n: (d?.n ?? 0) + 1 }));
    setArmed(null);
  };

  const rows = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return (all.data ?? []).filter((p) => {
      if (categoryId && String(p.category_id) !== categoryId) return false;
      if (stock && p.stock_status !== stock) return false;
      const hay = `${p.name} ${p.sku} ${p.brand_name ?? ''} ${p.category_name ?? ''} ${p.hsn ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [all.data, search, categoryId, stock]);
  const counts = useMemo(() => {
    const c = { all: 0, low: 0, out: 0 };
    for (const p of all.data ?? []) {
      if (!p.active) continue;
      c.all++;
      if (p.stock_status === 'low') c.low++;
      if (p.stock_status === 'out') c.out++;
    }
    return c;
  }, [all.data]);

  const exportCsv = () => {
    const head = ['SKU', 'Name', 'Category', 'Brand', 'Unit', 'HSN', 'GST %', 'Price excl GST', 'Cost', 'MRP', 'Stock', 'Reorder level'];
    const lines = rows.map((p) =>
      [p.sku, p.name, p.category_name, p.brand_name, p.unit_code, p.hsn, formatPercent(p.gst_rate_bp), formatPaise(p.sale_price_paise), p.cost_price_cp != null ? formatCost(p.cost_price_cp) : '', p.mrp_paise != null ? formatPaise(p.mrp_paise) : '', formatQty(p.qty_milli), p.reorder_level_milli != null ? formatQty(p.reorder_level_milli) : '']
        .map(csvCell)
        .join(','),
    );
    downloadText('stock-list.csv', [head.join(','), ...lines].join('\n'));
  };

  return (
    <Page>
      <PageTitle
        telugu="సరుకు నిల్వ"
        title="Inventory"
        actions={
          <>
            <Button onClick={exportCsv}>Export</Button>
            {can('settings.manage') && (
              <Link to="/settings/import" className="inline-flex h-10 items-center rounded-[6px] border border-line-2 bg-white px-4 text-sm font-semibold hover:bg-paper">
                Import from Excel
              </Link>
            )}
            {can('products.manage') && (
              <Button variant="primary" onClick={() => setEditing('new')}>
                + Add product
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Search products" placeholder="Search name, SKU, brand, HSN…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-[240px] flex-1" />
        <Select aria-label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-auto">
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <div role="radiogroup" aria-label="Stock status" className="flex overflow-hidden rounded-[6px] border border-line-2 bg-white">
          {(
            [
              ['', `All ${counts.all}`, ''],
              ['low', `Low ${counts.low}`, 'text-warn'],
              ['out', `Out ${counts.out}`, 'text-bad'],
            ] as const
          ).map(([v, label, cls]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={stock === v}
              onClick={() => setParams(v ? { stock: v } : {})}
              className={cx('h-[38px] border-l border-line-2 px-3.5 text-sm first:border-l-0', stock === v ? 'bg-teal font-bold text-white' : `font-semibold ${cls}`)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-teal" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      {quickPrice && (
        <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-line bg-paper px-3 py-2 text-sm">
          <span className="font-semibold">Quick price from cost</span>
          <span className="text-ink-3">drag a markup onto a product, or tap one then tap a price · Enter saves</span>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {['+5%', '+10%', '+15%', '+20%', '+25%'].map((m) => (
              <button
                key={m}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/x-markup', m);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDragEnd={() => setDragOver(null)}
                onClick={() => setArmed((a) => (a === m ? null : m))}
                aria-pressed={armed === m}
                title={`Selling price = cost + ${m.slice(1)} (GST is added on the bill)`}
                className={cx('num h-9 cursor-grab rounded-full border px-3.5 font-bold active:cursor-grabbing', armed === m ? 'border-teal bg-teal text-white' : 'border-line-2 bg-white hover:border-teal')}
              >
                {m}
              </button>
            ))}
          </div>
          {armed && <span className="w-full text-[13px] font-semibold text-teal">Now tap a product's price to set it to cost {armed}. Tap {armed} again to stop.</span>}
        </div>
      )}

      <div className="overflow-hidden rounded-[6px] border border-line bg-white">
        <Table
          minWidth={1100}
          head={
            <tr>
              <th>Product</th>
              <th>Category</th>
              <th className="text-right">In stock</th>
              <th className="text-right">Price (as kept)</th>
              <th className="text-right">Other way</th>
              {can('products.view_cost') && <th className="text-right">Cost</th>}
              <th className="text-right">Max disc.</th>
              <th>HSN · GST</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          }
        >
          {rows.map((p) => (
            <tr
              key={p.id}
              className={cx(!p.active && 'opacity-60', dragOver === p.id && 'outline outline-2 -outline-offset-2 outline-teal')}
              onDragOver={(e) => {
                if (!quickPrice || !e.dataTransfer.types.includes('text/x-markup')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (dragOver !== p.id) setDragOver(p.id);
              }}
              onDragLeave={() => setDragOver((d) => (d === p.id ? null : d))}
              onDrop={(e) => {
                const m = e.dataTransfer.getData('text/x-markup');
                setDragOver(null);
                if (!m) return;
                e.preventDefault();
                dropOn(p, m);
              }}
            >
              <td>
                <div className="font-bold">
                  {p.name} {!p.active && <Badge>Inactive</Badge>}
                </div>
                <div className="text-xs text-ink-3">
                  {p.sku}
                  {p.brand_name && ` · ${p.brand_name}`}
                </div>
              </td>
              <td className="text-ink-2">{p.category_name ?? '—'}</td>
              <td className="num text-right">
                {p.is_service ? (
                  <span className="text-[13px] font-semibold text-ink-3">Service</span>
                ) : can('stock.adjust') ? (
                  <button type="button" title="Adjust stock (reason required)" onClick={() => setAdjusting(p)} className={cx('-mx-1.5 rounded-[4px] border border-dashed border-transparent px-1.5 py-0.5 font-bold hover:border-cement hover:bg-paper', statusTone[p.stock_status])}>
                    {formatQty(p.qty_milli)} {p.unit_code}
                  </button>
                ) : (
                  <span className={cx('font-bold', statusTone[p.stock_status])}>
                    {formatQty(p.qty_milli)} {p.unit_code}
                  </span>
                )}
                {!p.is_service && <div className={cx('text-[11px]', statusTone[p.stock_status])}>{p.stock_status === 'ok' ? 'OK' : p.stock_status === 'low' ? `Low (${formatQty(p.reorder_level_milli ?? 0) || 'default'})` : 'Out of stock'}</div>}
              </td>
              <td className="num text-right">
                <InlinePrice
                  p={p}
                  editable={can('products.edit_price')}
                  preset={dropped?.id === p.id ? dropped : null}
                  armed={armed}
                  onArmedUse={(text) => dropOn(p, text)}
                />
              </td>
              <td className="num text-right text-ink-3">
                {formatPaise(p.price_includes_tax ? exclFromIncl(p.sale_price_paise, p.gst_rate_bp) : inclFromExcl(p.sale_price_paise, p.gst_rate_bp))}
                {p.units.filter((u) => u.for_sale).map((u) => (
                  <div key={u.unit_code} className="text-[11px]">
                    1 {u.unit_code} = {formatQty(Math.round((u.factor_num * 1000) / u.factor_den))} {p.unit_code}
                  </div>
                ))}
              </td>
              {can('products.view_cost') && <td className="num text-right text-ink-3">{p.cost_price_cp != null ? formatCost(p.cost_price_cp) : '—'}</td>}
              <td className="num text-right">
                {p.max_disc_type ? (p.max_disc_type === 'pct' ? `${formatPercent(p.max_disc_value!)}%` : `₹${formatPaise(p.max_disc_value!)} / ${p.unit_code}`) : p.cat_disc_type ? <span className="text-ink-3">{p.cat_disc_type === 'pct' ? `${formatPercent(p.cat_disc_value!)}%` : `₹${formatPaise(p.cat_disc_value!)}`} · cat.</span> : <span className="text-ink-3">0%</span>}
              </td>
              <td className="num text-ink-3">
                {p.hsn ?? <span className="text-warn">no HSN</span>} · {formatPercent(p.gst_rate_bp)}%
              </td>
              <td className="whitespace-nowrap text-right">
                <button type="button" className="mr-3 text-[13px] font-semibold underline-offset-2 hover:underline" onClick={() => setCard(p)}>
                  Stock card
                </button>
                {can('products.manage') && (
                  <button type="button" className="text-[13px] font-semibold underline-offset-2 hover:underline" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {all.isLoading && (
          <div className="flex items-center gap-2 p-6 text-ink-3">
            <Spinner /> Loading…
          </div>
        )}
        {!all.isLoading && rows.length === 0 && <Empty>No products match.</Empty>}
      </div>

      <ProductForm open={editing != null} product={editing === 'new' ? null : editing} categories={cats.data ?? []} onClose={() => setEditing(null)} />
      <AdjustStock product={adjusting} onClose={() => setAdjusting(null)} />
      <StockCard product={card} onClose={() => setCard(null)} />
    </Page>
  );
}

/** "+20%" in a price box → cost + 20% (in the product's own price mode). null = not a markup. */
type Markup = { error: string } | { paise: number; bp: number; costCp: number };
function markupPrice(p: Pick<ProductRow, 'cost_price_cp' | 'gst_rate_bp' | 'price_includes_tax'>, text: string, costCp = p.cost_price_cp): Markup | null {
  const bp = parseMarkup(text);
  if (bp == null) return null;
  if (costCp == null) return { error: 'No cost price yet — enter the cost first' };
  return { paise: priceFromCost(costCp, bp, p.gst_rate_bp, p.price_includes_tax), bp, costCp };
}

function InlinePrice({ p, editable, preset, armed, onArmedUse }: { p: ProductRow; editable: boolean; preset?: { text: string; n: number } | null; armed?: string | null; onArmedUse?: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  // a markup chip was dropped on this product: open the box with it, ready for Enter
  useEffect(() => {
    if (!preset || !editable) return;
    setValue(preset.text);
    setEditing(true);
  }, [preset?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editable) return <>{formatPaise(p.sale_price_paise)}</>;
  const mk = markupPrice(p, value);
  if (!editing)
    return (
      <button
        type="button"
        title={armed ? `Set price to cost ${armed}` : 'Click to change price — or type +20% for cost + 20%'}
        onClick={() => {
          if (armed && onArmedUse) return onArmedUse(armed);
          setValue(formatPaise(p.sale_price_paise).replace(/,/g, ''));
          setEditing(true);
        }}
        className="-mx-1.5 rounded-[4px] border border-dashed border-transparent px-1.5 py-0.5 hover:border-cement hover:bg-paper"
      >
        {formatPaise(p.sale_price_paise)}
      </button>
    );
  const save = async () => {
    if (mk && 'error' in mk) return toast({ tone: 'bad', text: mk.error });
    const paise = mk ? mk.paise : parseRupees(value);
    if (paise == null || paise < 0) return toast({ tone: 'bad', text: 'Enter a price, or a markup like +20%' });
    setBusy(true);
    try {
      await patch(`/api/products/${p.id}`, { salePricePaise: paise });
      toast({ tone: 'good', text: `${p.name}: price now ₹${formatPaise(paise)} (${p.price_includes_tax ? 'incl.' : 'excl.'} GST)${mk ? ` = cost ${value.trim()}` : ''}` });
      await qc.invalidateQueries({ queryKey: ['products'] });
      setEditing(false);
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not save price' });
    } finally {
      setBusy(false);
    }
  };
  const excl = mk && 'paise' in mk ? (p.price_includes_tax ? exclFromIncl(mk.paise, p.gst_rate_bp) : mk.paise) : null;
  return (
    <span className="relative inline-flex flex-col items-end">
      <input
        aria-label={`New price for ${p.name}`}
        autoFocus
        disabled={busy}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="num h-8 w-28 rounded-[4px] border-2 border-teal px-2 text-right outline-none"
      />
      {mk && (
        <span role="status" className={cx('absolute right-0 top-9 z-10 whitespace-nowrap rounded-[4px] border bg-white px-2 py-1 text-left text-[12px] shadow-md', 'error' in mk ? 'border-bad text-bad' : 'border-teal text-ink')}>
          {'error' in mk ? (
            mk.error
          ) : (
            <>
              Cost ₹{formatCost(mk.costCp)} {value.trim()} = <b>₹{formatPaise(excl!)}</b> excl. GST · ₹{formatPaise(inclFromExcl(excl!, p.gst_rate_bp))} with GST
              <br />
              <span className="text-ink-3">Enter saves · Esc cancels</span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

function ProductForm({ open, product, categories, onClose }: { open: boolean; product: ProductRow | null; categories: Category[]; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const unitsQ = useQuery({ queryKey: ['units'], queryFn: () => get<{ code: string; name: string }[]>('/api/units'), enabled: open });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => get<{ id: number; name: string }[]>('/api/brands'), enabled: open });
  const [f, setF] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<UnitDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canPrice = can('products.edit_price');
  const canCost = can('products.view_cost');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(
      product
        ? {
            sku: product.sku,
            name: product.name,
            categoryId: product.category_id ? String(product.category_id) : '',
            brand: product.brand_name ?? '',
            unitCode: product.unit_code,
            hsn: product.hsn ?? '',
            gst: formatPercent(product.gst_rate_bp),
            price: formatPaise(product.sale_price_paise).replace(/,/g, ''),
            cost: product.cost_price_cp != null ? formatCost(product.cost_price_cp).replace(/,/g, '') : '',
            mrp: product.mrp_paise != null ? formatPaise(product.mrp_paise).replace(/,/g, '') : '',
            reorder: product.reorder_level_milli != null ? formatQty(product.reorder_level_milli) : '',
            discType: product.max_disc_type ?? '',
            disc: product.max_disc_value != null ? (product.max_disc_type === 'pct' ? formatPercent(product.max_disc_value) : formatPaise(product.max_disc_value).replace(/,/g, '')) : '',
            active: product.active ? '1' : '0',
            inclMode: product.price_includes_tax ? '1' : '0',
            contents: product.contents_milli != null ? formatQty(product.contents_milli) : '',
            service: product.is_service ? '1' : '0',
            ...buyUnitOf(product),
          }
        : { sku: '', name: '', categoryId: '', brand: '', unitCode: 'pcs', hsn: '', gst: '18', price: '', cost: '', mrp: '', reorder: '', discType: '', disc: '', opening: '', active: '1', inclMode: '0', contents: '', service: '0', buyUnit: 'pcs', perBuy: '' },
    );
    const buy = product ? buyUnitOf(product).buyUnit : null;
    setUnits(
      (product?.units ?? []).filter((u) => !(u.unit_code === buy && u.for_purchase && !u.for_sale)).map((u) => ({
        unitCode: u.unit_code,
        factor: u.factor_den === 1 ? String(u.factor_num) : formatQty(Math.round((u.factor_num * 1000) / u.factor_den)),
        price: u.price_paise != null ? formatPaise(u.price_paise).replace(/,/g, '') : '',
        forSale: u.for_sale,
        forPurchase: u.for_purchase,
      })),
    );
  }, [open, product]);

  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const formMk = markupPrice(
    { cost_price_cp: product?.cost_price_cp ?? null, gst_rate_bp: parsePercent(f.gst ?? '') ?? 1800, price_includes_tax: f.inclMode === '1' },
    f.price ?? '',
    f.cost?.trim() ? parseCost(f.cost) : (product?.cost_price_cp ?? null),
  );
  const priceP = formMk ? ('paise' in formMk ? formMk.paise : null) : parseRupees(f.price ?? '');
  const gstBp = parsePercent(f.gst ?? '');
  const inclMode = f.inclMode === '1';
  const other = priceP != null && gstBp != null ? (inclMode ? exclFromIncl(priceP, gstBp) : inclFromExcl(priceP, gstBp)) : null;
  const steelMm = Number((f.name ?? '').match(/(\d{1,2})\s*mm/i)?.[1] ?? 0);

  const submit = async () => {
    setError(null);
    const money = (s: string | undefined) => (s?.trim() ? parseRupees(s) : null);
    const body: Record<string, unknown> = {
      name: f.name,
      categoryId: f.categoryId ? Number(f.categoryId) : null,
      brandName: f.brand?.trim() || undefined,
      unitCode: f.unitCode,
      hsn: f.hsn?.trim() || null,
      gstRateBp: gstBp,
      mrpPaise: money(f.mrp),
      reorderLevelMilli: f.reorder?.trim() ? parseQty(f.reorder) : null,
      active: f.active === '1',
    };
    if (!product || f.sku !== product.sku) body.sku = f.sku;
    if (gstBp == null) return setError('GST % is not valid');
    if (canPrice) {
      body.salePricePaise = priceP ?? 0;
      if (formMk && 'error' in formMk) return setError(formMk.error);
      if (f.price?.trim() && priceP == null) return setError('Selling price is not valid');
      body.maxDiscType = f.discType || null;
      body.maxDiscValue = f.discType ? (f.discType === 'pct' ? parsePercent(f.disc ?? '') : parseRupees(f.disc ?? '')) : null;
      if (f.discType && body.maxDiscValue == null) return setError('Max discount is not valid');
    }
    if (canCost) {
      const c = f.cost?.trim() ? parseCost(f.cost) : null;
      if (f.cost?.trim() && c == null) return setError('Cost price is not a valid amount (up to 4 decimals, e.g. 57.2034)');
      body.costPriceCp = c;
    }
    if (canPrice) body.priceIncludesTax = inclMode;
    body.contentsMilli = f.contents?.trim() ? parseQty(f.contents) : null;
    body.isService = f.service === '1';
    body.contentsUnit = f.contents?.trim() ? 'ltr' : null;
    const unitBody = [];
    for (const u of units) {
      if (!u.unitCode) continue;
      const q = parseQty(u.factor);
      if (q == null || q <= 0) return setError(`How many ${f.unitCode} are in one ${u.unitCode}? Enter a number.`);
      const price = u.price.trim() ? parseRupees(u.price) : null;
      if (u.price.trim() && price == null) return setError(`Price for ${u.unitCode} is not valid`);
      unitBody.push({ unitCode: u.unitCode, factorNum: q % 1000 === 0 ? q / 1000 : q, factorDen: q % 1000 === 0 ? 1 : 1000, forSale: u.forSale, forPurchase: u.forPurchase, ...(canPrice ? { pricePaise: price } : {}) });
    }
    const buyUnit = f.buyUnit ?? f.unitCode;
    if (buyUnit && buyUnit !== f.unitCode) {
      const q = parseQty(f.perBuy ?? '');
      if (q == null || q <= 0) return setError(`How many ${f.unitCode} are in 1 ${buyUnit}? Enter a number.`);
      const i = unitBody.findIndex((u) => u.unitCode === buyUnit);
      const row = { unitCode: buyUnit, factorNum: q % 1000 === 0 ? q / 1000 : q, factorDen: q % 1000 === 0 ? 1 : 1000, forSale: i >= 0 ? unitBody[i]!.forSale : false, forPurchase: true };
      if (i >= 0) unitBody[i] = { ...unitBody[i]!, ...row };
      else unitBody.push(row);
    }
    body.units = unitBody;
    if (!product && f.opening?.trim()) {
      const q = parseQty(f.opening);
      if (q == null) return setError('Opening stock is not a valid quantity');
      body.openingQtyMilli = q;
    }
    setBusy(true);
    try {
      if (product) await patch(`/api/products/${product.id}`, body);
      else await post('/api/products', body);
      toast({ tone: 'good', text: product ? `Saved ${f.name}` : `Added ${f.name}` });
      await qc.invalidateQueries({ queryKey: ['products'] });
      await qc.invalidateQueries({ queryKey: ['brands'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!product || !confirm(`Remove “${product.name}”? If it has ever been sold or stocked it will only be marked inactive.`)) return;
    try {
      const r = await del<{ deleted: boolean }>(`/api/products/${product.id}`);
      toast({ tone: 'good', text: r.deleted ? 'Product deleted' : 'Product has history, so it was marked inactive' });
      await qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={product ? 'Edit product' : 'Add product'}
      width={720}
      footer={
        <>
          {product && (
            <Button variant="danger" className="mr-auto" onClick={remove}>
              Delete / deactivate
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" busy={busy} onClick={submit} disabled={!f.name?.trim() || !f.sku?.trim()}>
            Save product
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Product name" className="sm:col-span-2">
          <Input value={f.name ?? ''} onChange={set('name')} autoFocus />
        </Field>
        <Field label="SKU / item code">
          <Input value={f.sku ?? ''} onChange={set('sku')} />
        </Field>
        <Field label="Category">
          <Select value={f.categoryId ?? ''} onChange={set('categoryId')}>
            <option value="">— none —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Brand">
          <Input value={f.brand ?? ''} onChange={set('brand')} list="brand-list" />
          <datalist id="brand-list">
            {(brands.data ?? []).map((b) => (
              <option key={b.id} value={b.name} />
            ))}
          </datalist>
        </Field>
        <Field label="We buy in">
          <Select
            value={f.buyUnit ?? f.unitCode ?? 'pcs'}
            onChange={(e) => {
              const v = e.target.value;
              // selling follows buying until it is changed on its own
              setF((x) => ({ ...x, buyUnit: v, unitCode: (x.unitCode ?? 'pcs') === (x.buyUnit ?? x.unitCode) ? v : (x.unitCode ?? 'pcs') }));
            }}
          >
            {(unitsQ.data ?? [{ code: f.buyUnit ?? 'pcs', name: f.buyUnit ?? 'pcs' }]).map((u) => (
              <option key={u.code} value={u.code}>
                {u.code} — {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="We sell in" hint="Stock is counted in this unit">
          <Select value={f.unitCode ?? 'pcs'} onChange={set('unitCode')}>
            {(unitsQ.data ?? [{ code: f.unitCode ?? 'pcs', name: f.unitCode ?? 'pcs' }]).map((u) => (
              <option key={u.code} value={u.code}>
                {u.code} — {u.name}
                {u.code === (f.buyUnit ?? f.unitCode) ? ' (same as buying)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {(f.buyUnit ?? f.unitCode) !== f.unitCode && (
          <Field
            label={`How many ${f.unitCode} in 1 ${f.buyUnit}?`}
            className="sm:col-span-2"
            hint={
              f.buyUnit === 'tonne' && f.unitCode === 'rod' && steelMm
                ? `e.g. 1 tonne of ${steelMm} mm = 100 rods. Standard ≈ ${standardRodsPerTonne(steelMm)} (12 m rods). When a purchase is entered, the real count can be typed instead.`
                : `e.g. 1 tonne = 100 nos. Purchases in ${f.buyUnit} are turned into ${f.unitCode} by this.`
            }
          >
            <Input className="num" inputMode="decimal" value={f.perBuy ?? ''} onChange={set('perBuy')} />
          </Field>
        )}
        <Field label="HSN code">
          <Input value={f.hsn ?? ''} onChange={set('hsn')} inputMode="numeric" />
        </Field>
        <Field label="GST %" hint="18% = 9% CGST + 9% SGST">
          <Input value={f.gst ?? ''} onChange={set('gst')} inputMode="decimal" />
        </Field>
        <Field
          label={`Selling price per ${f.unitCode ?? 'unit'} (₹)`}
          hint={
            formMk && 'error' in formMk
              ? formMk.error
              : formMk
                ? `Cost ${f.price?.trim()} = ₹${formatPaise(priceP!)} ${inclMode ? 'incl.' : 'excl.'} GST${other != null ? ` (${inclMode ? 'excl.' : 'incl.'} ₹${formatPaise(other)})` : ''}`
                : other != null
                  ? `${inclMode ? 'Excl.' : 'Incl.'} GST: ₹${formatPaise(other)} · or type +20% for cost + 20%`
                  : 'Or type +20% for cost + 20%'
          }
        >
          <div className="flex gap-2">
            <Input value={f.price ?? ''} onChange={set('price')} inputMode="decimal" disabled={!canPrice} />
            <div role="radiogroup" aria-label="Price includes GST?" className="flex shrink-0 overflow-hidden rounded-[6px] border border-line-2">
              {(['0', '1'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={(f.inclMode ?? '0') === m}
                  disabled={!canPrice}
                  onClick={() => setF((x) => ({ ...x, inclMode: m }))}
                  className={cx('h-10 px-2.5 text-xs font-bold', (f.inclMode ?? '0') === m ? 'bg-teal text-white' : 'bg-white text-ink-2')}
                >
                  {m === '0' ? 'Excl. GST' : 'Incl. GST'}
                </button>
              ))}
            </div>
          </div>
        </Field>
        {canCost && (
          <Field label="Cost price excl. GST (₹)">
            <Input value={f.cost ?? ''} onChange={set('cost')} inputMode="decimal" />
          </Field>
        )}
        <Field label="MRP (₹, optional)">
          <Input value={f.mrp ?? ''} onChange={set('mrp')} inputMode="decimal" />
        </Field>
        <Field label="Reorder level" hint="Blank = use the shop default">
          <Input value={f.reorder ?? ''} onChange={set('reorder')} inputMode="decimal" />
        </Field>
        {canPrice && (
          <div className="grid grid-cols-[auto_1fr] gap-2 sm:col-span-2">
            <Field label="Max discount">
              <Select value={f.discType ?? ''} onChange={set('discType')}>
                <option value="">Use category default</option>
                <option value="pct">% of price</option>
                <option value="amt">₹ per unit</option>
              </Select>
            </Field>
            <Field label={f.discType === 'amt' ? '₹ per unit' : '%'}>
              <Input value={f.disc ?? ''} onChange={set('disc')} inputMode="decimal" disabled={!f.discType} />
            </Field>
          </div>
        )}
        <div className="flex flex-col gap-2 rounded-[6px] border border-line bg-paper p-3 sm:col-span-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[13px] font-bold">More units (optional)</span>
            <span className="text-xs text-ink-3">
              Extra units you also sell or buy in, e.g. coil and metre for wire. Stock is counted in <b>{f.unitCode}</b>.
            </span>
          </div>
          {units.map((u, i) => (
            <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[110px_1fr_1fr_auto_auto_auto]">
              <Field label="Unit">
                <Select value={u.unitCode} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, unitCode: e.target.value } : x)))}>
                  <option value="">—</option>
                  {(unitsQ.data ?? []).filter((x) => x.code !== f.unitCode).map((x) => (
                    <option key={x.code} value={x.code}>
                      {x.code}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`${f.unitCode} in 1 ${u.unitCode || 'unit'}`} hint={u.unitCode === 'tonne' && f.unitCode === 'rod' && steelMm ? `Standard ≈ ${standardRodsPerTonne(steelMm)} for ${steelMm} mm (12 m rods)` : undefined}>
                <Input className="num" inputMode="decimal" value={u.factor} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, factor: e.target.value } : x)))} />
              </Field>
              <Field label="Own price (optional)">
                <Input className="num" inputMode="decimal" value={u.price} disabled={!canPrice} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
              </Field>
              <Checkbox label="Sell" checked={u.forSale} onChange={(v) => setUnits(units.map((x, j) => (j === i ? { ...x, forSale: v } : x)))} />
              <Checkbox label="Buy" checked={u.forPurchase} onChange={(v) => setUnits(units.map((x, j) => (j === i ? { ...x, forPurchase: v } : x)))} />
              <Button size="sm" variant="ghost" aria-label="Remove unit" onClick={() => setUnits(units.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <div>
            <Button size="sm" onClick={() => setUnits([...units, { unitCode: '', factor: '', price: '', forSale: true, forPurchase: true }])}>
              + Add unit
            </Button>
          </div>
        </div>
        <Field label="Pack contents in litres (optional)" hint="For paint: 20 for a 20L bucket — used in litre reports">
          <Input value={f.contents ?? ''} onChange={set('contents')} inputMode="decimal" />
        </Field>
        <Checkbox
          label="This is a service, not stock (loading / unloading, transport, cutting charges…). Use its SAC code (e.g. 996749) in the HSN box."
          checked={f.service === '1'}
          onChange={(v) => setF((x) => ({ ...x, service: v ? '1' : '0' }))}
        />
        {!product && f.service !== '1' && (
          <Field label={`Opening stock (in ${f.unitCode})`} hint="Saved as an “opening” stock entry">
            <Input value={f.opening ?? ''} onChange={set('opening')} inputMode="decimal" />
          </Field>
        )}
        {product && (
          <Field label="Status">
            <Select value={f.active ?? '1'} onChange={set('active')}>
              <option value="1">Active — can be billed</option>
              <option value="0">Inactive — hidden from billing</option>
            </Select>
          </Field>
        )}
        {error && (
          <div className="sm:col-span-2">
            <Notice tone="bad">{error}</Notice>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

interface UnitDraft {
  unitCode: string;
  factor: string;
  price: string;
  forSale: boolean;
  forPurchase: boolean;
}

const REASONS = ['Damaged', 'Leakage', 'Shortage', 'Counted wrong earlier', 'Found extra stock', 'Opening stock correction'];

function AdjustStock({ product, onClose }: { product: ProductRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState(REASONS[0]!);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (product) {
      setCounted(formatQty(product.qty_milli));
      setReason(REASONS[0]!);
      setOther('');
      setError(null);
    }
  }, [product]);
  const newQty = parseQty(counted);
  const delta = product && newQty != null ? newQty - product.qty_milli : null;
  const finalReason = reason === 'Other' ? other : reason;
  const save = async () => {
    if (!product || newQty == null) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/products/${product.id}/adjust`, { newQtyMilli: newQty, reason: finalReason });
      toast({ tone: 'good', text: `${product.name}: stock now ${formatQty(newQty)} ${product.unit_code}` });
      await qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!product}
      onClose={onClose}
      title={`Adjust stock — ${product?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" busy={busy} disabled={newQty == null || !delta || finalReason.trim().length < 3} onClick={save}>
            Save adjustment
          </Button>
        </>
      }
    >
      {product && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-ink-3">
            System shows{' '}
            <b className="num text-ink">
              {formatQty(product.qty_milli)} {product.unit_code}
            </b>
            . Every change is saved as an adjustment with your name, counter and reason.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Counted quantity">
              <Input className="num" value={counted} onChange={(e) => setCounted(e.target.value)} inputMode="decimal" autoFocus />
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-bold">Change</span>
              <div className={cx('num flex h-10 items-center text-base font-extrabold', delta == null ? 'text-bad' : delta < 0 ? 'text-bad' : delta > 0 ? 'text-good' : 'text-ink-3')}>
                {delta == null ? 'Not a valid number' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${formatQty(Math.abs(delta))} ${product.unit_code}`}
              </div>
            </div>
          </div>
          <Field label="Reason (required)">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {[...REASONS, 'Other'].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </Field>
          {reason === 'Other' && (
            <Field label="Describe the reason">
              <Input value={other} onChange={(e) => setOther(e.target.value)} />
            </Field>
          )}
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
      )}
    </Modal>
  );
}

const KIND_LABEL: Record<string, string> = {
  opening: 'Opening stock',
  purchase: 'Purchase',
  sale: 'Sale',
  sale_cancel: 'Bill cancelled',
  sale_return: 'Sales return',
  purchase_return: 'Purchase return',
  adjustment: 'Adjustment',
  audit: 'Stock audit',
  transfer: 'Transfer',
  unit_change: 'Unit changed',
};

function StockCard({ product, onClose }: { product: ProductRow | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['movements', product?.id],
    queryFn: () => get<{ id: number; at: string; kind: string; qty_milli: number; reason: string | null; ref_number: string | null; user_name: string | null; device_name: string | null; running_milli: number }[]>(`/api/products/${product!.id}/movements`),
    enabled: !!product,
  });
  return (
    <Modal open={!!product} onClose={onClose} title={`Stock card — ${product?.name ?? ''}`} width={860}>
      <p className="mb-3 text-sm text-ink-3">Every change to this product’s stock, newest first. Entries are permanent; mistakes are corrected with a new adjustment.</p>
      <div className="overflow-hidden rounded-[6px] border border-line">
        <Table
          minWidth={680}
          head={
            <tr>
              <th>When</th>
              <th>What</th>
              <th className="text-right">Change</th>
              <th className="text-right">Balance</th>
              <th>By</th>
            </tr>
          }
        >
          {(q.data ?? []).map((m) => (
            <tr key={m.id}>
              <td className="num whitespace-nowrap text-ink-3">{fmtDateTime(m.at)}</td>
              <td>
                {KIND_LABEL[m.kind] ?? m.kind}
                {m.ref_number && <span className="num text-ink-3"> · {m.ref_number}</span>}
                {m.reason && <div className="text-xs text-ink-3">“{m.reason}”</div>}
              </td>
              <td className={cx('num text-right font-bold', m.qty_milli < 0 ? 'text-bad' : 'text-good')}>
                {m.qty_milli > 0 ? '+' : '−'}
                {formatQty(Math.abs(m.qty_milli))}
              </td>
              <td className="num text-right">{formatQty(m.running_milli)}</td>
              <td className="text-ink-3">
                {m.user_name ?? '—'} · {m.device_name ?? '—'}
              </td>
            </tr>
          ))}
        </Table>
        {q.isLoading && (
          <div className="flex items-center gap-2 p-6 text-ink-3">
            <Spinner /> Loading…
          </div>
        )}
        {q.data?.length === 0 && <Empty>No stock entries yet.</Empty>}
      </div>
    </Modal>
  );
}

/** The unit a product is bought in (a buy-only unit), and how many selling units are in one. */
function buyUnitOf(p: ProductRow): { buyUnit: string; perBuy: string } {
  const u = p.units.find((x) => x.for_purchase && !x.for_sale);
  if (!u) return { buyUnit: p.unit_code, perBuy: '' };
  return { buyUnit: u.unit_code, perBuy: u.factor_den === 1 ? String(u.factor_num) : formatQty(Math.round((u.factor_num * 1000) / u.factor_den)) };
}

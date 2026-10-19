import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, formatPercent, formatQty, mulDivRound, parsePercent, parseQty, parseRupees } from '@kph/core';
import { ApiError, del, get, patch, post } from '../lib/api';
import { csvCell, downloadText, fmtDateTime } from '../lib/format';
import { useSession } from '../lib/session';
import type { Category, ProductRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, cx, useToast } from '../components/ui';

const statusTone = { ok: 'text-good', low: 'text-warn', out: 'text-bad' } as const;

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
      [p.sku, p.name, p.category_name, p.brand_name, p.unit_code, p.hsn, formatPercent(p.gst_rate_bp), formatPaise(p.sale_price_paise), p.cost_price_paise != null ? formatPaise(p.cost_price_paise) : '', p.mrp_paise != null ? formatPaise(p.mrp_paise) : '', formatQty(p.qty_milli), p.reorder_level_milli != null ? formatQty(p.reorder_level_milli) : '']
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

      <div className="overflow-hidden rounded-[6px] border border-line bg-white">
        <Table
          minWidth={1100}
          head={
            <tr>
              <th>Product</th>
              <th>Category</th>
              <th className="text-right">In stock</th>
              <th className="text-right">Price excl. GST</th>
              <th className="text-right">Incl. GST</th>
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
            <tr key={p.id} className={cx(!p.active && 'opacity-60')}>
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
                {can('stock.adjust') ? (
                  <button type="button" title="Adjust stock (reason required)" onClick={() => setAdjusting(p)} className={cx('-mx-1.5 rounded-[4px] border border-dashed border-transparent px-1.5 py-0.5 font-bold hover:border-cement hover:bg-paper', statusTone[p.stock_status])}>
                    {formatQty(p.qty_milli)} {p.unit_code}
                  </button>
                ) : (
                  <span className={cx('font-bold', statusTone[p.stock_status])}>
                    {formatQty(p.qty_milli)} {p.unit_code}
                  </span>
                )}
                <div className={cx('text-[11px]', statusTone[p.stock_status])}>{p.stock_status === 'ok' ? 'OK' : p.stock_status === 'low' ? `Low (${formatQty(p.reorder_level_milli ?? 0) || 'default'})` : 'Out of stock'}</div>
              </td>
              <td className="num text-right">
                <InlinePrice p={p} editable={can('products.edit_price')} />
              </td>
              <td className="num text-right text-ink-3">{formatPaise(p.sale_price_paise + mulDivRound(p.sale_price_paise, p.gst_rate_bp, 10000))}</td>
              {can('products.view_cost') && <td className="num text-right text-ink-3">{p.cost_price_paise != null ? formatPaise(p.cost_price_paise) : '—'}</td>}
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

function InlinePrice({ p, editable }: { p: ProductRow; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  if (!editable) return <>{formatPaise(p.sale_price_paise)}</>;
  if (!editing)
    return (
      <button
        type="button"
        title="Click to change price"
        onClick={() => {
          setValue(formatPaise(p.sale_price_paise).replace(/,/g, ''));
          setEditing(true);
        }}
        className="-mx-1.5 rounded-[4px] border border-dashed border-transparent px-1.5 py-0.5 hover:border-cement hover:bg-paper"
      >
        {formatPaise(p.sale_price_paise)}
      </button>
    );
  const save = async () => {
    const paise = parseRupees(value);
    if (paise == null || paise < 0) return toast({ tone: 'bad', text: 'Enter a valid price' });
    setBusy(true);
    try {
      await patch(`/api/products/${p.id}`, { salePricePaise: paise });
      toast({ tone: 'good', text: `${p.name}: price now ₹${formatPaise(paise)} (excl. GST)` });
      await qc.invalidateQueries({ queryKey: ['products'] });
      setEditing(false);
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not save price' });
    } finally {
      setBusy(false);
    }
  };
  return (
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
  );
}

function ProductForm({ open, product, categories, onClose }: { open: boolean; product: ProductRow | null; categories: Category[]; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const units = useQuery({ queryKey: ['units'], queryFn: () => get<{ code: string; name: string }[]>('/api/units'), enabled: open });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => get<{ id: number; name: string }[]>('/api/brands'), enabled: open });
  const [f, setF] = useState<Record<string, string>>({});
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
            cost: product.cost_price_paise != null ? formatPaise(product.cost_price_paise).replace(/,/g, '') : '',
            mrp: product.mrp_paise != null ? formatPaise(product.mrp_paise).replace(/,/g, '') : '',
            reorder: product.reorder_level_milli != null ? formatQty(product.reorder_level_milli) : '',
            discType: product.max_disc_type ?? '',
            disc: product.max_disc_value != null ? (product.max_disc_type === 'pct' ? formatPercent(product.max_disc_value) : formatPaise(product.max_disc_value).replace(/,/g, '')) : '',
            active: product.active ? '1' : '0',
          }
        : { sku: '', name: '', categoryId: '', brand: '', unitCode: 'pcs', hsn: '', gst: '18', price: '', cost: '', mrp: '', reorder: '', discType: '', disc: '', opening: '', active: '1' },
    );
  }, [open, product]);

  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const priceP = parseRupees(f.price ?? '');
  const gstBp = parsePercent(f.gst ?? '');
  const incl = priceP != null && gstBp != null ? priceP + mulDivRound(priceP, gstBp, 10000) : null;

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
      if (f.price?.trim() && priceP == null) return setError('Selling price is not valid');
      body.maxDiscType = f.discType || null;
      body.maxDiscValue = f.discType ? (f.discType === 'pct' ? parsePercent(f.disc ?? '') : parseRupees(f.disc ?? '')) : null;
      if (f.discType && body.maxDiscValue == null) return setError('Max discount is not valid');
    }
    if (canCost) body.costPricePaise = money(f.cost);
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
        <Field label="Unit (stock is kept in this unit)">
          <Select value={f.unitCode ?? 'pcs'} onChange={set('unitCode')}>
            {(units.data ?? [{ code: f.unitCode ?? 'pcs', name: f.unitCode ?? 'pcs' }]).map((u) => (
              <option key={u.code} value={u.code}>
                {u.code} — {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="HSN code">
          <Input value={f.hsn ?? ''} onChange={set('hsn')} inputMode="numeric" />
        </Field>
        <Field label="GST %" hint="18% = 9% CGST + 9% SGST">
          <Input value={f.gst ?? ''} onChange={set('gst')} inputMode="decimal" />
        </Field>
        <Field label="Selling price excl. GST (₹)" hint={incl != null ? `Incl. GST: ₹${formatPaise(incl)}` : undefined}>
          <Input value={f.price ?? ''} onChange={set('price')} inputMode="decimal" disabled={!canPrice} />
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
        {!product && (
          <Field label="Opening stock" hint="Saved as an “opening” stock entry">
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

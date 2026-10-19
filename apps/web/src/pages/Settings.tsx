import { useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, formatPaise, formatPercent, formatQty, parsePercent, parseQty, parseRupees, type Permission } from '@kph/core';
import { ApiError, fileToBase64, get, patch, post, put, store } from '../lib/api';
import { csvCell, downloadText, fmtDateTime } from '../lib/format';
import { useSession } from '../lib/session';
import type { Category } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Card, Checkbox, ConfirmTyped, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, cx, useToast } from '../components/ui';

const TABS: { to: string; label: string; perm: Permission }[] = [
  { to: 'store', label: 'Shop & billing', perm: 'settings.manage' },
  { to: 'gst', label: 'GST & invoices', perm: 'settings.manage' },
  { to: 'discounts', label: 'Categories & discounts', perm: 'products.edit_price' },
  { to: 'users', label: 'Users & roles', perm: 'users.manage' },
  { to: 'counters', label: 'Counters', perm: 'users.manage' },
  { to: 'import', label: 'Import', perm: 'settings.manage' },
  { to: 'data', label: 'Data & backups', perm: 'settings.manage' },
];

export function Settings() {
  const { can } = useSession();
  const tabs = TABS.filter((t) => can(t.perm));
  return (
    <Page>
      <PageTitle telugu="సెట్టింగ్‌లు" title="Settings" />
      <nav aria-label="Settings" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => cx('-mb-px flex h-11 items-center px-3 text-sm', isActive ? 'border-b-[3px] border-brick font-bold' : 'text-ink-3 hover:text-ink')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route path="store" element={<StoreSettings />} />
        <Route path="gst" element={<GstSettings />} />
        <Route path="discounts" element={<Categories />} />
        <Route path="users" element={<Users />} />
        <Route path="counters" element={<Counters />} />
        <Route path="import" element={<Import />} />
        <Route path="data" element={<DataBackups />} />
        <Route path="*" element={<Navigate to={tabs[0]?.to ?? 'store'} replace />} />
      </Routes>
    </Page>
  );
}

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

// ------------------------------------------------------------------ shop & billing

interface StoreSettingsDto {
  storeName: string;
  storeAddress: string;
  storePlace: string;
  storePincode: string;
  tallyCompanyName: string;
  storePhone: string;
  storeGstin: string;
  stateCode: string;
  stateName: string;
  invoicePrefix: string;
  receiptPrefix: string;
  invoiceTerms: string;
  lowStockThresholdMilli: number;
  idleLockMinutes: number;
  discountHintEnabled: boolean;
  allowNegativeStock: boolean;
  autoBackupHour: number;
  geminiApiKeySet: boolean;
  geminiModel: string;
  purchasePrefix: string;
}

function StoreSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { reload } = useSession();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get<StoreSettingsDto>('/api/settings') });
  const [f, setF] = useState<Record<string, string | boolean>>({});
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const s = q.data;
    if (!s) return;
    setF({
      storeName: s.storeName,
      storeAddress: s.storeAddress,
      storePlace: s.storePlace,
      storePincode: s.storePincode,
      tallyCompanyName: s.tallyCompanyName,
      storePhone: s.storePhone,
      storeGstin: s.storeGstin,
      stateCode: s.stateCode,
      stateName: s.stateName,
      invoicePrefix: s.invoicePrefix,
      receiptPrefix: s.receiptPrefix,
      invoiceTerms: s.invoiceTerms,
      lowStock: formatQty(s.lowStockThresholdMilli),
      idle: String(s.idleLockMinutes),
      hint: s.discountHintEnabled,
      negative: s.allowNegativeStock,
      backupHour: String(s.autoBackupHour),
      geminiModel: s.geminiModel,
      purchasePrefix: s.purchasePrefix,
    });
  }, [q.data]);
  const t = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const low = parseQty(String(f.lowStock));
      if (low == null) throw new ApiError(400, 'BAD', 'Low-stock level is not a valid number');
      await put('/api/settings', {
        storeName: f.storeName,
        storeAddress: f.storeAddress,
        storePlace: f.storePlace,
        storePincode: String(f.storePincode ?? '').trim(),
        tallyCompanyName: String(f.tallyCompanyName ?? '').trim(),
        storePhone: f.storePhone,
        storeGstin: String(f.storeGstin).toUpperCase().trim(),
        stateCode: f.stateCode,
        stateName: f.stateName,
        invoicePrefix: String(f.invoicePrefix).toUpperCase().trim(),
        receiptPrefix: String(f.receiptPrefix).toUpperCase().trim(),
        invoiceTerms: f.invoiceTerms,
        lowStockThresholdMilli: low,
        idleLockMinutes: Number(f.idle),
        discountHintEnabled: !!f.hint,
        allowNegativeStock: !!f.negative,
        autoBackupHour: Number(f.backupHour),
        geminiModel: String(f.geminiModel).trim(),
        purchasePrefix: String(f.purchasePrefix).toUpperCase().trim(),
        ...(key ? { geminiApiKey: key } : {}),
      });
      setKey('');
      toast({ tone: 'good', text: 'Settings saved' });
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await reload();
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  if (!q.data) return <Spinner />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Shop details (printed on bills)">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Shop name" className="sm:col-span-2">
            <Input value={String(f.storeName ?? '')} onChange={t('storeName')} />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <Input value={String(f.storeAddress ?? '')} onChange={t('storeAddress')} />
          </Field>
          <Field label="Town (for e-way bills)">
            <Input value={String(f.storePlace ?? '')} onChange={t('storePlace')} />
          </Field>
          <Field label="PIN code (for e-way bills)">
            <Input value={String(f.storePincode ?? '')} onChange={t('storePincode')} inputMode="numeric" maxLength={6} />
          </Field>
          <Field label="Company name in Tally" hint="Exactly as your CA's Tally shows it; blank = shop name" className="sm:col-span-2">
            <Input value={String(f.tallyCompanyName ?? '')} onChange={t('tallyCompanyName')} />
          </Field>
          <Field label="Phone">
            <Input value={String(f.storePhone ?? '')} onChange={t('storePhone')} />
          </Field>
          <Field label="GSTIN">
            <Input value={String(f.storeGstin ?? '')} onChange={t('storeGstin')} />
          </Field>
          <Field label="State">
            <Input value={String(f.stateName ?? '')} onChange={t('stateName')} />
          </Field>
          <Field label="State code">
            <Input value={String(f.stateCode ?? '')} onChange={t('stateCode')} />
          </Field>
          <Field label="Terms printed on bills" className="sm:col-span-2">
            <Input value={String(f.invoiceTerms ?? '')} onChange={t('invoiceTerms')} />
          </Field>
        </div>
      </Card>
      <Card title="Billing & counters">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Invoice prefix" hint={`Numbers look like ${String(f.invoicePrefix || 'KPH')}/26-27/000123`}>
            <Input value={String(f.invoicePrefix ?? '')} onChange={t('invoicePrefix')} maxLength={4} />
          </Field>
          <Field label="Receipt prefix">
            <Input value={String(f.receiptPrefix ?? '')} onChange={t('receiptPrefix')} maxLength={4} />
          </Field>
          <Field label="Default low-stock level" hint="For products without their own reorder level">
            <Input value={String(f.lowStock ?? '')} onChange={t('lowStock')} inputMode="decimal" />
          </Field>
          <Field label="Lock screen after (minutes idle)">
            <Input value={String(f.idle ?? '')} onChange={t('idle')} inputMode="numeric" />
          </Field>
          <Field label="Daily automatic backup after (hour, 0–23)">
            <Input value={String(f.backupHour ?? '')} onChange={t('backupHour')} inputMode="numeric" />
          </Field>
          <div className="flex flex-col justify-end gap-2 sm:col-span-2">
            <Checkbox label="Show the discreet max-discount hint (e.g. “D8”) on the billing screen" checked={!!f.hint} onChange={(v) => setF((x) => ({ ...x, hint: v }))} />
            <Checkbox label="Allow billing more than the stock shown (not recommended)" checked={!!f.negative} onChange={(v) => setF((x) => ({ ...x, negative: v }))} />
          </div>
          <Field label="Purchase number prefix" hint={`Our purchase numbers look like ${String(f.purchasePrefix || 'PUR')}/26-27/000001`}>
            <Input value={String(f.purchasePrefix ?? '')} onChange={t('purchasePrefix')} maxLength={4} />
          </Field>
          <Field label="Gemini model (scanner and assistant)" hint="Change only if Google retires this model">
            <Input value={String(f.geminiModel ?? '')} onChange={t('geminiModel')} />
          </Field>
          <Field label="Gemini API key (invoice scanner and assistant)" hint={q.data.geminiApiKeySet ? 'A key is saved. Type a new one to replace it.' : 'Not set. Kept on this server only; never included in backups.'} className="sm:col-span-2">
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </Card>
      <div className="flex flex-col gap-2 lg:col-span-2">
        {error && <Notice tone="bad">{error}</Notice>}
        <div>
          <Button variant="primary" busy={busy} onClick={save}>
            Save settings
          </Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ GST & invoices

function GstSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { reload } = useSession();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => get<Record<string, string>>('/api/settings') });
  const periods = useQuery({ queryKey: ['gst-periods'], queryFn: () => get<{ month: string; filed_at: string | null; filed_by_name: string | null; note: string | null; bills: number }[]>('/api/gst/periods') });
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s.data)
      setF({
        salesPriceMode: s.data.salesPriceMode!,
        purchasePriceMode: s.data.purchasePriceMode!,
        invoiceLabels: s.data.invoiceLabels!,
        creditNotePrefix: s.data.creditNotePrefix!,
        debitNotePrefix: s.data.debitNotePrefix!,
      });
  }, [s.data]);
  const save = async () => {
    setBusy(true);
    try {
      await put('/api/settings', { ...f, creditNotePrefix: f.creditNotePrefix?.toUpperCase().trim(), debitNotePrefix: f.debitNotePrefix?.toUpperCase().trim() });
      toast({ tone: 'good', text: 'Saved' });
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await reload();
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
    } finally {
      setBusy(false);
    }
  };
  const setFiled = async (month: string, filed: boolean) => {
    const note = filed ? (prompt(`Mark GSTR-1 for ${month} as filed? Bills of that month can then only be corrected with credit notes.\n\nNote (optional, e.g. ARN):`) ?? null) : null;
    if (filed && note === null) return;
    if (!filed && !confirm(`Re-open ${month}? Only do this if the return was not actually filed.`)) return;
    try {
      await post(`/api/gst/periods/${month}`, { filed, note: note || undefined });
      await qc.invalidateQueries({ queryKey: ['gst-periods'] });
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
    }
  };
  const t = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Prices and invoices">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New bill lines: prices typed" hint="Staff can still switch each bill or line">
            <Select value={f.salesPriceMode ?? 'excl'} onChange={t('salesPriceMode')}>
              <option value="excl">Excluding GST</option>
              <option value="incl">Including GST</option>
            </Select>
          </Field>
          <Field label="Purchases: line amounts typed">
            <Select value={f.purchasePriceMode ?? 'excl'} onChange={t('purchasePriceMode')}>
              <option value="excl">Before GST</option>
              <option value="incl">Including GST</option>
            </Select>
          </Field>
          <Field label="Invoice labels">
            <Select value={f.invoiceLabels ?? 'te-en'} onChange={t('invoiceLabels')}>
              <option value="en">English</option>
              <option value="te-en">English + Telugu</option>
            </Select>
          </Field>
          <div />
          <Field label="Credit note prefix" hint={`e.g. ${f.creditNotePrefix || 'CN'}/26-27/000001`}>
            <Input value={f.creditNotePrefix ?? ''} onChange={t('creditNotePrefix')} maxLength={4} />
          </Field>
          <Field label="Debit note prefix" hint={`e.g. ${f.debitNotePrefix || 'DN'}/26-27/000001`}>
            <Input value={f.debitNotePrefix ?? ''} onChange={t('debitNotePrefix')} maxLength={4} />
          </Field>
        </div>
        <div className="mt-4">
          <Button variant="primary" busy={busy} onClick={save}>
            Save
          </Button>
        </div>
      </Card>
      <Card title="GST months (GSTR-1 filed)">
        <p className="mb-3 text-sm text-ink-3">
          After your CA files GSTR-1 for a month, mark it here. Bills of that month can then no longer be cancelled; mistakes are corrected with a credit note (Sales → Return items).
        </p>
        <div className="-mx-4 -mb-4 overflow-hidden">
          <Table
            minWidth={420}
            head={
              <tr>
                <th>Month</th>
                <th className="text-right">Bills</th>
                <th>Status</th>
                <th />
              </tr>
            }
          >
            {(periods.data ?? []).map((p) => (
              <tr key={p.month}>
                <td className="num font-semibold">{p.month}</td>
                <td className="num text-right">{p.bills}</td>
                <td>
                  {p.filed_at ? (
                    <>
                      <Badge tone="good">Filed</Badge>{' '}
                      <span className="text-xs text-ink-3">
                        {fmtDateTime(p.filed_at)} · {p.filed_by_name}
                        {p.note ? ` · ${p.note}` : ''}
                      </span>
                    </>
                  ) : (
                    <Badge>Open</Badge>
                  )}
                </td>
                <td className="text-right">
                  <button type="button" className="text-[13px] font-semibold hover:underline" onClick={() => void setFiled(p.month, !p.filed_at)}>
                    {p.filed_at ? 'Re-open' : 'Mark filed'}
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ categories & discount defaults

function Categories() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['categories'], queryFn: () => get<Category[]>('/api/categories') });
  const [edit, setEdit] = useState<Category | 'new' | null>(null);
  const [f, setF] = useState({ name: '', type: '', value: '', gst: '18' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!edit) return;
    setError(null);
    if (edit === 'new') setF({ name: '', type: 'pct', value: '', gst: '18' });
    else
      setF({
        name: edit.name,
        type: edit.max_disc_type ?? '',
        value: edit.max_disc_value != null ? (edit.max_disc_type === 'pct' ? formatPercent(edit.max_disc_value) : formatPaise(edit.max_disc_value).replace(/,/g, '')) : '',
        gst: formatPercent(edit.default_gst_bp),
      });
  }, [edit]);
  const save = async () => {
    const value = f.type ? (f.type === 'pct' ? parsePercent(f.value) : parseRupees(f.value)) : null;
    const gst = parsePercent(f.gst);
    if (f.type && value == null) return setError('Max discount is not valid');
    if (gst == null) return setError('GST % is not valid');
    setBusy(true);
    setError(null);
    try {
      const body = { name: f.name, maxDiscType: f.type || null, maxDiscValue: f.type ? value : null, defaultGstBp: gst };
      if (edit === 'new') await post('/api/categories', body);
      else if (edit) await patch(`/api/categories/${edit.id}`, body);
      toast({ tone: 'good', text: `Saved ${f.name}` });
      await qc.invalidateQueries({ queryKey: ['categories'] });
      await qc.invalidateQueries({ queryKey: ['products'] });
      setEdit(null);
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Notice tone="teal" icon={false}>
        The max discount set here applies to every product in the category, unless a product has its own limit (set in Inventory → Edit). Staff can give up to the limit; above it the
        billing screen asks for the admin PIN. A staff member’s own cap (Users & roles) can lower it further.
      </Notice>
      <Card title="Categories" actions={<Button variant="primary" onClick={() => setEdit('new')}>+ Add category</Button>}>
        <div className="-m-4 overflow-hidden">
          <Table
            minWidth={560}
            head={
              <tr>
                <th>Category</th>
                <th className="text-right">Max discount</th>
                <th className="text-right">Default GST</th>
                <th className="text-right">Products</th>
                <th />
              </tr>
            }
          >
            {(q.data ?? []).map((c) => (
              <tr key={c.id}>
                <td className="font-bold">{c.name}</td>
                <td className="num text-right">{c.max_disc_type ? (c.max_disc_type === 'pct' ? `${formatPercent(c.max_disc_value!)}%` : `₹${formatPaise(c.max_disc_value!)} / unit`) : <span className="text-ink-3">0% (admin PIN for any discount)</span>}</td>
                <td className="num text-right">{formatPercent(c.default_gst_bp)}%</td>
                <td className="num text-right">{c.product_count}</td>
                <td className="text-right">
                  <button type="button" className="text-[13px] font-semibold hover:underline" onClick={() => setEdit(c)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          {q.data?.length === 0 && <Empty>No categories yet.</Empty>}
        </div>
      </Card>
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit === 'new' ? 'Add category' : 'Edit category'}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="dark" busy={busy} disabled={f.name.trim().length < 2} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Max discount">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="">None (0%)</option>
              <option value="pct">% of price</option>
              <option value="amt">₹ per unit</option>
            </Select>
          </Field>
          <Field label={f.type === 'amt' ? '₹ per unit' : '%'}>
            <Input value={f.value} disabled={!f.type} onChange={(e) => setF({ ...f, value: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="Default GST % for imports">
            <Input value={f.gst} onChange={(e) => setF({ ...f, gst: e.target.value })} inputMode="decimal" />
          </Field>
          {error && (
            <div className="sm:col-span-2">
              <Notice tone="bad">{error}</Notice>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ users & roles

interface UserRow {
  id: number;
  name: string;
  role_id: string;
  role_name: string;
  active: boolean;
  discount_cap_bp: number | null;
  locked: boolean;
}
interface RoleRow {
  id: string;
  name: string;
  permissions: string[];
}

function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me, reload } = useSession();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<UserRow[]>('/api/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<RoleRow[]>('/api/roles') });
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null);
  const [pinFor, setPinFor] = useState<UserRow | null>(null);
  const [f, setF] = useState({ name: '', roleId: 'counter', pin: '', cap: '', active: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!edit) return;
    setError(null);
    setF(edit === 'new' ? { name: '', roleId: 'counter', pin: '', cap: '', active: true } : { name: edit.name, roleId: edit.role_id, pin: '', cap: edit.discount_cap_bp != null ? formatPercent(edit.discount_cap_bp) : '', active: edit.active });
  }, [edit]);
  const save = async () => {
    const cap = f.cap.trim() ? parsePercent(f.cap) : null;
    if (f.cap.trim() && cap == null) return setError('Discount cap is not valid');
    setBusy(true);
    setError(null);
    try {
      if (edit === 'new') await post('/api/users', { name: f.name, roleId: f.roleId, pin: f.pin, discountCapBp: cap });
      else if (edit) await patch(`/api/users/${edit.id}`, { name: f.name, roleId: f.roleId, discountCapBp: cap, active: f.active });
      toast({ tone: 'good', text: `Saved ${f.name}` });
      await qc.invalidateQueries({ queryKey: ['users'] });
      await reload();
      setEdit(null);
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Users" actions={<Button variant="primary" onClick={() => setEdit('new')}>+ Add user</Button>}>
        <div className="-m-4 overflow-hidden">
          <Table
            minWidth={620}
            head={
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th className="text-right">Own discount cap</th>
                <th>Status</th>
                <th />
              </tr>
            }
          >
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td className="font-bold">
                  {u.name} {u.id === me?.userId && <span className="font-normal text-ink-3">(you)</span>}
                </td>
                <td>{u.role_name}</td>
                <td className="num text-right">{u.discount_cap_bp != null ? `${formatPercent(u.discount_cap_bp)}%` : '—'}</td>
                <td>{!u.active ? <Badge>Inactive</Badge> : u.locked ? <Badge tone="bad">Locked (wrong PINs)</Badge> : <Badge tone="good">Active</Badge>}</td>
                <td className="whitespace-nowrap text-right">
                  <button type="button" className="mr-3 text-[13px] font-semibold hover:underline" onClick={() => setPinFor(u)}>
                    Reset PIN
                  </button>
                  <button type="button" className="text-[13px] font-semibold hover:underline" onClick={() => setEdit(u)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </Card>
      <RolesMatrix roles={roles.data ?? []} />
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit === 'new' ? 'Add user' : 'Edit user'}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="dark" busy={busy} disabled={f.name.trim().length < 2 || (edit === 'new' && !/^\d{4,8}$/.test(f.pin))} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Role">
            <Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>
              {(roles.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Own discount cap %" hint="Optional. The lower of this and the product limit applies.">
            <Input value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} inputMode="decimal" />
          </Field>
          {edit === 'new' ? (
            <Field label="PIN (4–8 digits)">
              <Input type="password" inputMode="numeric" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 8) })} />
            </Field>
          ) : (
            <Field label="Status">
              <Select value={f.active ? '1' : '0'} onChange={(e) => setF({ ...f, active: e.target.value === '1' })}>
                <option value="1">Active</option>
                <option value="0">Inactive — cannot log in</option>
              </Select>
            </Field>
          )}
          {error && (
            <div className="sm:col-span-2">
              <Notice tone="bad">{error}</Notice>
            </div>
          )}
        </div>
      </Modal>
      <ResetPin user={pinFor} onClose={() => setPinFor(null)} />
    </>
  );
}

function ResetPin({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPin('');
    setError(null);
  }, [user]);
  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await post(`/api/users/${user.id}/reset-pin`, { pin });
      toast({ tone: 'good', text: `New PIN set for ${user.name}. They have been logged out everywhere.` });
      await qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`Reset PIN — ${user?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" busy={busy} disabled={!/^\d{4,8}$/.test(pin)} onClick={save}>
            Set new PIN
          </Button>
        </>
      }
    >
      <Field label="New PIN (4–8 digits)">
        <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} autoFocus />
      </Field>
      {error && (
        <div className="mt-3">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
    </Modal>
  );
}

function RolesMatrix({ roles }: { roles: RoleRow[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { reload } = useSession();
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  useEffect(() => setDraft(Object.fromEntries(roles.map((r) => [r.id, r.permissions]))), [roles]);
  const dirty = roles.some((r) => JSON.stringify([...r.permissions].sort()) !== JSON.stringify([...(draft[r.id] ?? [])].sort()));
  const toggle = (role: string, p: string) => setDraft((d) => ({ ...d, [role]: d[role]?.includes(p) ? d[role]!.filter((x) => x !== p) : [...(d[role] ?? []), p] }));
  const save = async () => {
    try {
      for (const r of roles) await put(`/api/roles/${r.id}`, { permissions: draft[r.id] ?? [] });
      toast({ tone: 'good', text: 'Role permissions saved' });
      await qc.invalidateQueries({ queryKey: ['roles'] });
      await reload();
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
    }
  };
  return (
    <Card
      title="What each role can do"
      actions={
        <Button variant="dark" disabled={!dirty} onClick={save}>
          Save permissions
        </Button>
      }
    >
      <p className="mb-3 text-sm text-ink-3">Staff who lack “discount above limit” or “cancel a bill” can still do it with an admin PIN on the spot.</p>
      <div className="-mx-4 -mb-4 overflow-hidden">
        <Table
          minWidth={560}
          head={
            <tr>
              <th>Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="text-center">
                  {r.name}
                </th>
              ))}
            </tr>
          }
        >
          {(Object.entries(PERMISSIONS) as [Permission, string][]).map(([p, label]) => (
            <tr key={p}>
              <td>{label}</td>
              {roles.map((r) => (
                <td key={r.id} className="text-center">
                  <input type="checkbox" aria-label={`${r.name}: ${label}`} className="size-4 accent-teal" checked={!!draft[r.id]?.includes(p)} onChange={() => toggle(r.id, p)} />
                </td>
              ))}
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ counters (devices)

function Counters() {
  const qc = useQueryClient();
  const toast = useToast();
  const { boot } = useSession();
  const q = useQuery({ queryKey: ['devices'], queryFn: () => get<{ id: number; name: string; status: string; created_at: string; last_seen_at: string | null; approved_by_name: string | null }[]>('/api/devices') });
  const act = async (id: number, what: 'approve' | 'revoke') => {
    try {
      await post(`/api/devices/${id}/${what}`);
      await qc.invalidateQueries({ queryKey: ['devices'] });
      toast({ tone: 'good', text: what === 'approve' ? 'Computer approved' : 'Computer blocked' });
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
    }
  };
  const rename = async (id: number, current: string) => {
    const name = prompt('New name for this computer', current);
    if (!name || name === current) return;
    try {
      await patch(`/api/devices/${id}`, { name });
      await qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
    }
  };
  return (
    <Card title="Counters and computers">
      <p className="mb-3 text-sm text-ink-3">
        Each computer (or phone) that opens Store Desk registers once with a counter name. Every bill and log entry carries this name. Block a computer that is lost or no longer used.
      </p>
      <div className="-mx-4 -mb-4 overflow-hidden">
        <Table
          minWidth={620}
          head={
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Last seen</th>
              <th>Approved by</th>
              <th />
            </tr>
          }
        >
          {(q.data ?? []).map((d) => (
            <tr key={d.id}>
              <td className="font-bold">
                {d.name} {d.id === boot?.device?.id && <span className="font-normal text-ink-3">(this computer)</span>}
              </td>
              <td>{d.status === 'approved' ? <Badge tone="good">Approved</Badge> : d.status === 'pending' ? <Badge tone="warn">Waiting</Badge> : <Badge tone="bad">Blocked</Badge>}</td>
              <td className="num text-ink-3">{d.last_seen_at ? fmtDateTime(d.last_seen_at) : '—'}</td>
              <td className="text-ink-3">{d.approved_by_name ?? '—'}</td>
              <td className="whitespace-nowrap text-right">
                <button type="button" className="mr-3 text-[13px] font-semibold hover:underline" onClick={() => rename(d.id, d.name)}>
                  Rename
                </button>
                {d.status !== 'approved' && (
                  <button type="button" className="mr-3 text-[13px] font-semibold text-good hover:underline" onClick={() => act(d.id, 'approve')}>
                    Approve
                  </button>
                )}
                {d.status !== 'revoked' && d.id !== boot?.device?.id && (
                  <button type="button" className="text-[13px] font-semibold text-bad hover:underline" onClick={() => act(d.id, 'revoke')}>
                    Block
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ import

type Kind = 'products' | 'customers' | 'suppliers';
interface RawTable {
  headers: string[];
  rows: string[][];
}
interface PreviewRow {
  rowNo: number;
  values: Record<string, unknown>;
  errors: string[];
  warnings: string[];
  action: 'create' | 'update' | 'skip';
}

function Import() {
  const qc = useQueryClient();
  const toast = useToast();
  const fields = useQuery({ queryKey: ['import-fields'], queryFn: () => get<Record<Kind, Record<string, { label: string; required?: boolean }>>>('/api/import/fields') });
  const [kind, setKind] = useState<Kind>('products');
  const [file, setFile] = useState<File | null>(null);
  const [table, setTable] = useState<RawTable | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; summary: { total: number; create: number; update: number; skip: number; errors: number; warnings: number }; newUnits: string[] } | null>(null);
  const [filter, setFilter] = useState<'all' | 'problems'>('problems');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTable(null);
    setPreview(null);
    setError(null);
  };

  const parse = async (f: File) => {
    setFile(f);
    reset();
    setBusy(true);
    try {
      const r = await post<{ table: RawTable; mapping: Record<string, number | null> }>('/api/import/parse', { kind, filename: f.name, base64: await fileToBase64(f) });
      setTable(r.table);
      setMapping(r.mapping);
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    if (!table) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await post('/api/import/preview', { kind, table, mapping, updateExisting }));
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!table) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ summary: Record<string, number> }>('/api/import/apply', { kind, table, mapping, updateExisting });
      toast({ tone: 'good', text: `Import done: ${r.summary.create} added, ${r.summary.update} updated, ${r.summary.skip} skipped.` });
      await qc.invalidateQueries();
      reset();
      setFile(null);
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  const downloadReport = () => {
    if (!preview) return;
    const lines = preview.rows.filter((r) => r.errors.length || r.warnings.length).map((r) => [r.rowNo, String(r.values.name ?? ''), r.action, r.errors.join('; '), r.warnings.join('; ')].map(csvCell).join(','));
    downloadText(`import-problems-${kind}.csv`, ['Row,Name,Action,Errors,Warnings', ...lines].join('\n'));
  };

  const fieldDefs = fields.data?.[kind] ?? {};
  const shown = useMemo(() => (preview?.rows ?? []).filter((r) => filter === 'all' || r.errors.length || r.warnings.length), [preview, filter]);

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="teal" icon={false}>
        Load your existing lists from Excel (.xlsx) or CSV. You will see every row before anything is saved; rows with errors are skipped and listed so you can fix them. Opening stock
        is saved as an “opening” stock entry; customers’ outstanding amounts become their opening balance.
      </Notice>
      <Card title="1 · Choose what and the file">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Importing">
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as Kind);
                reset();
                setFile(null);
              }}
            >
              <option value="products">Products and opening stock</option>
              <option value="customers">Customers and dues</option>
              <option value="suppliers">Suppliers</option>
            </Select>
          </Field>
          <Field label="File (.xlsx or .csv)">
            <input
              type="file"
              accept=".xlsx,.csv,.txt"
              onChange={(e) => e.target.files?.[0] && void parse(e.target.files[0])}
              className="h-10 text-sm file:mr-3 file:h-10 file:rounded-[6px] file:border file:border-line-2 file:bg-white file:px-3 file:font-semibold"
            />
          </Field>
          {busy && <Spinner />}
        </div>
      </Card>

      {table && (
        <Card title={`2 · Match the columns (${table.rows.length} rows in ${file?.name})`}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(fieldDefs).map(([k, def]) => (
              <Field key={k} label={`${def.label}${def.required ? ' *' : ''}`}>
                <Select value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
                  <option value="">— not in file —</option>
                  {table.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`} {table.rows[0]?.[i] ? `(e.g. ${table.rows[0][i]!.slice(0, 24)})` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {kind === 'products' && <Checkbox label="Update products whose SKU already exists (stock is not changed)" checked={updateExisting} onChange={setUpdateExisting} />}
            <Button variant="dark" busy={busy} onClick={runPreview}>
              Check the rows
            </Button>
          </div>
        </Card>
      )}

      {preview && (
        <Card
          title="3 · Review and import"
          actions={
            <div className="flex flex-wrap gap-2">
              <Button onClick={downloadReport}>Download problem list</Button>
              <Button variant="primary" busy={busy} disabled={!preview.summary.create && !preview.summary.update} onClick={apply}>
                Import {preview.summary.create + preview.summary.update} rows
              </Button>
            </div>
          }
        >
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Badge tone="good">{preview.summary.create} new</Badge>
            {preview.summary.update > 0 && <Badge tone="teal">{preview.summary.update} update</Badge>}
            <Badge tone="bad">{preview.summary.skip} skipped</Badge>
            <Badge tone="warn">{preview.summary.warnings} with warnings</Badge>
            {preview.newUnits.length > 0 && <span className="text-ink-3">New units to be created: {preview.newUnits.join(', ')}</span>}
            <label className="ml-auto flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-teal" checked={filter === 'problems'} onChange={(e) => setFilter(e.target.checked ? 'problems' : 'all')} />
              Only rows with problems
            </label>
          </div>
          <div className="-mx-4 -mb-4 max-h-[520px] overflow-auto">
            <Table
              minWidth={760}
              head={
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Will</th>
                  <th>Problems</th>
                </tr>
              }
            >
              {shown.map((r) => (
                <tr key={r.rowNo} className={r.errors.length ? 'bg-bad-soft/50' : ''}>
                  <td className="num text-ink-3">{r.rowNo}</td>
                  <td className="font-semibold">{String(r.values.name ?? '') || <span className="text-bad">(blank)</span>}</td>
                  <td>{r.action === 'create' ? <Badge tone="good">Add</Badge> : r.action === 'update' ? <Badge tone="teal">Update</Badge> : <Badge tone="bad">Skip</Badge>}</td>
                  <td className="text-[13px]">
                    {r.errors.map((e) => (
                      <div key={e} className="text-bad">
                        ✕ {e}
                      </div>
                    ))}
                    {r.warnings.map((w) => (
                      <div key={w} className="text-warn">
                        ! {w}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </Table>
            {shown.length === 0 && <Empty>No problems found.</Empty>}
          </div>
        </Card>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      <p className="text-xs text-ink-3">Importing the old app’s JSON backup will be added once you share a sample file.</p>
    </div>
  );
}

// ------------------------------------------------------------------ data & backups

function DataBackups() {
  const toast = useToast();
  const qc = useQueryClient();
  const { boot } = useSession();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => get<{ dir: string; files: { file: string; sizeBytes: number; at: string }[]; log: { id: number; at: string; kind: string; file: string; ok: boolean; error: string | null }[] }>('/api/backups') });
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirm, setConfirm] = useState<'restore' | 'live' | 'sample' | 'reset' | null>(null);

  const backupNow = async () => {
    setBusy('backup');
    try {
      const r = await post<{ file: string }>('/api/backups/run');
      toast({ tone: 'good', text: `Backup saved: ${r.file}` });
      await qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
    } finally {
      setBusy(null);
    }
  };

  const download = async (file: string) => {
    const res = await fetch(`/api/backups/download/${encodeURIComponent(file)}`, { headers: { 'x-device-token': store.deviceToken ?? '', authorization: `Bearer ${store.sessionToken}` } });
    if (!res.ok) return toast({ tone: 'bad', text: 'Could not download backup' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = file;
    a.click();
  };

  const doRestore = async () => {
    if (!restoreFile) return;
    setBusy('restore');
    try {
      const r = await post<{ safetyBackup: string }>('/api/backups/restore', { base64: await fileToBase64(restoreFile), confirm: 'RESTORE' });
      toast({ tone: 'good', text: `Restored. A copy of the data before restoring was saved as ${r.safetyBackup}.` });
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const switchTo = async (to: 'live' | 'sample') => {
    setBusy('switch');
    try {
      await post('/api/workspace/switch', { to, confirm: to === 'live' ? 'REAL DATA' : 'SAMPLE' });
      setTimeout(() => location.reload(), 500);
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
      setBusy(null);
    }
  };

  const resetSample = async () => {
    setBusy('reset');
    try {
      await post('/api/workspace/reset-sample', { confirm: 'RESET SAMPLE' });
      setTimeout(() => location.reload(), 500);
    } catch (e) {
      toast({ tone: 'bad', text: err(e) });
      setBusy(null);
    }
  };

  const sample = boot?.workspace === 'sample';
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Backups" actions={<Button variant="primary" busy={busy === 'backup'} onClick={backupNow}>Back up now</Button>}>
        <p className="mb-3 text-sm text-ink-3">
          A backup is made automatically every day. The last 30 automatic backups are kept in <span className="font-mono text-xs">{q.data?.dir}</span>. Encrypted copies to a second place
          (another PC, USB or Google Drive) come in Phase 7. The Gemini key is never included.
        </p>
        <div className="-mx-4 -mb-4 max-h-80 overflow-auto">
          <Table
            minWidth={460}
            head={
              <tr>
                <th>File</th>
                <th className="text-right">Size</th>
                <th />
              </tr>
            }
          >
            {(q.data?.files ?? []).map((f) => (
              <tr key={f.file}>
                <td>
                  <div className="font-mono text-xs">{f.file}</div>
                  <div className="text-xs text-ink-3">{fmtDateTime(f.at)}</div>
                </td>
                <td className="num text-right">{Math.max(1, Math.round(f.sizeBytes / 1024))} KB</td>
                <td className="text-right">
                  <button type="button" className="text-[13px] font-semibold hover:underline" onClick={() => void download(f.file)}>
                    Download
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          {q.data?.files.length === 0 && <Empty>No backups yet.</Empty>}
        </div>
      </Card>

      <Card title="Restore from a backup">
        <div className="flex flex-col gap-3 text-sm">
          <Notice tone="warn">
            Restoring replaces <b>all</b> data in the {sample ? 'sample' : 'real'} workspace with the backup. A safety copy of the current data is saved first. Everyone is logged out.
          </Notice>
          <input type="file" accept=".gz,.json" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} className="text-sm file:mr-3 file:h-10 file:rounded-[6px] file:border file:border-line-2 file:bg-white file:px-3 file:font-semibold" />
          <div>
            <Button variant="dark" disabled={!restoreFile} onClick={() => setConfirm('restore')}>
              Restore…
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Sample data and real data" className="lg:col-span-2">
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Store Desk keeps two completely separate sets of books. <b>Sample data</b> is for training and testing and shows the yellow banner on every screen. <b>Real data</b> is the
            shop’s actual books and starts empty: you set up the owner account, register the counters and import the stock list.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Now using: <Badge tone={sample ? 'warn' : 'good'}>{sample ? 'SAMPLE DATA' : 'REAL DATA'}</Badge>
            </span>
            {sample ? (
              <>
                <Button variant="primary" onClick={() => setConfirm('live')}>
                  Switch to real data…
                </Button>
                <Button onClick={() => setConfirm('reset')}>Reset sample data…</Button>
              </>
            ) : (
              <Button onClick={() => setConfirm('sample')}>Switch to sample data (training)…</Button>
            )}
          </div>
        </div>
      </Card>

      <ConfirmTyped open={confirm === 'restore'} onClose={() => setConfirm(null)} title="Restore backup" word="RESTORE" busy={busy === 'restore'} onConfirm={doRestore} confirmLabel="Replace all data">
        <p>
          All data will be replaced by <b>{restoreFile?.name}</b>.
        </p>
      </ConfirmTyped>
      <ConfirmTyped open={confirm === 'live'} onClose={() => setConfirm(null)} title="Switch to real data" word="REAL DATA" busy={busy === 'switch'} onConfirm={() => void switchTo('live')} confirmLabel="Switch">
        <p>All counters will switch to the real books. If this is the first time, you will set up the owner account and register each counter again.</p>
      </ConfirmTyped>
      <ConfirmTyped open={confirm === 'sample'} onClose={() => setConfirm(null)} title="Switch to sample data" word="SAMPLE" busy={busy === 'switch'} onConfirm={() => void switchTo('sample')} confirmLabel="Switch">
        <p>All counters will switch to the practice books. Bills made there are not real. Switch back when training is done.</p>
      </ConfirmTyped>
      <ConfirmTyped open={confirm === 'reset'} onClose={() => setConfirm(null)} title="Reset sample data" word="RESET SAMPLE" busy={busy === 'reset'} onConfirm={() => void resetSample()} confirmLabel="Reset">
        <p>The sample books are wiped and reloaded with fresh sample products, customers and bills. Real data is never touched.</p>
      </ConfirmTyped>
    </div>
  );
}

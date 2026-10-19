import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, parseRupees, type Permission } from '@kph/core';
import { ApiError, download, get, patch, post, put, store } from '../lib/api';
import { fmtDate, fmtDateTime, todayIst, uuid } from '../lib/format';
import { preparePage, type PreparedPage } from '../lib/images';
import { useSession } from '../lib/session';
import type { SupplierRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Checkbox, ConfirmTyped, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, cx, useToast } from '../components/ui';

/**
 * Accounts (Phase 3A): pay suppliers, expenses, cash ↔ bank, journals, books,
 * supplier dues, day-end cash count, and setup (bank accounts, expense heads, opening balances).
 */

type Tab = 'pay' | 'expense' | 'contra' | 'journal' | 'books' | 'dues' | 'cash' | 'setup';
const TABS: { id: Tab; label: string; perm: Permission[] }[] = [
  { id: 'cash', label: 'Cash count', perm: ['payments.receive', 'payments.make'] },
  { id: 'expense', label: 'Expenses', perm: ['expenses.create'] },
  { id: 'pay', label: 'Pay supplier', perm: ['payments.make'] },
  { id: 'dues', label: 'Supplier dues', perm: ['payments.make', 'reports.view'] },
  { id: 'contra', label: 'Cash ↔ bank', perm: ['payments.make'] },
  { id: 'books', label: 'Books', perm: ['reports.view'] },
  { id: 'journal', label: 'Journal', perm: ['accounts.manage'] },
  { id: 'setup', label: 'Setup', perm: ['accounts.manage'] },
];

interface Ledger {
  id: number;
  name: string;
  group_name: string;
  kind: string | null;
  system_code: string | null;
  balance_paise: number;
  opening_dr_paise: number;
  active: boolean;
  details: Record<string, string>;
}

const rs = (p: number | null | undefined) => (p == null ? '' : formatPaise(p));
const drcr = (p: number) => (p === 0 ? '0.00' : `${formatPaise(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`);
const errText = (e: unknown, fallback = 'Something went wrong') => (e instanceof ApiError ? e.message : fallback);

function useMoneyLedgers() {
  return useQuery({
    queryKey: ['accounts', 'money-ledgers'],
    queryFn: async () => {
      const [cash, bank, clearing] = await Promise.all(['cash', 'bank', 'clearing'].map((k) => get<Ledger[]>(`/api/ledgers?kind=${k}`)));
      return [...cash!, ...bank!, ...clearing!].filter((l) => l.active);
    },
  });
}

export function AccountsPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => t.perm.some(can));
  const tab = (tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id) as Tab | undefined;
  const go = (t: Tab, extra: Record<string, string> = {}) => setParams({ tab: t, ...extra });

  return (
    <Page wide>
      <PageTitle telugu="ఖాతాలు" title="Accounts" sub="Money in and out of the shop. Every entry is numbered, balanced and never deleted — a mistake is cancelled with a reason." />
      <nav aria-label="Accounts" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => go(t.id)} className={cx('h-11 px-3 text-sm', tab === t.id ? 'font-bold text-ink shadow-[inset_0_-3px_0_#c2491a]' : 'text-ink-3 hover:text-ink')}>
            {t.label}
          </button>
        ))}
      </nav>
      {!tab && <Notice>You don't have access to the accounts.</Notice>}
      {tab === 'pay' && <PaySupplier preselect={Number(params.get('supplier')) || null} />}
      {tab === 'expense' && <Expenses />}
      {tab === 'contra' && <Contra />}
      {tab === 'journal' && <Journal />}
      {tab === 'books' && <Books />}
      {tab === 'dues' && <SupplierDues onPay={(id) => go('pay', { supplier: String(id) })} />}
      {tab === 'cash' && <CashCount />}
      {tab === 'setup' && <Setup />}
    </Page>
  );
}

// ------------------------------------------------------------------ shared bits

function Panel({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[6px] border border-line bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <h2 className="flex-1 text-[15px] font-bold">{title}</h2>
        {actions}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function MoneyInput({ value, onChange, label, hint, autoFocus }: { value: string; onChange: (v: string) => void; label: string; hint?: ReactNode; autoFocus?: boolean }) {
  const bad = value !== '' && parseRupees(value) == null;
  return (
    <Field label={label} hint={hint} error={bad ? 'Enter rupees, e.g. 1250.50' : undefined}>
      <Input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="₹" className="num" autoFocus={autoFocus} />
    </Field>
  );
}

function LedgerSelect({ ledgers, value, onChange, placeholder = 'Choose…' }: { ledgers: Ledger[]; value: number | ''; onChange: (id: number | '') => void; placeholder?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
      <option value="">{placeholder}</option>
      {ledgers.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}
        </option>
      ))}
    </Select>
  );
}

/** Recent entries of one kind, with cancel for admin. */
function EntryList({ kind, title }: { kind: 'payment' | 'expense' | 'contra' | 'journal'; title: string }) {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [from, setFrom] = useState(`${todayIst().slice(0, 8)}01`);
  const list = useQuery({ queryKey: ['accounts', 'entries', kind, from], queryFn: () => get<EntryRow[]>(`/api/money?kind=${kind}&from=${from}`) });
  const [cancel, setCancel] = useState<EntryRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);

  const doCancel = async () => {
    if (!cancel) return;
    setBusy(true);
    try {
      await post(`/api/money/${cancel.id}/cancel`, { reason });
      toast({ tone: 'good', text: `${cancel.number} cancelled` });
      setCancel(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const showPhoto = async (id: number) => {
    const res = await fetch(`/api/money/${id}/file`, { headers: { 'x-device-token': store.deviceToken ?? '', authorization: `Bearer ${store.sessionToken}` } });
    if (res.ok) setPhoto(URL.createObjectURL(await res.blob()));
  };

  const rows = list.data ?? [];
  return (
    <Panel
      title={title}
      actions={
        <label className="flex items-center gap-2 text-[13px] text-ink-3">
          since <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[150px]" />
        </label>
      }
    >
      {list.isLoading ? (
        <Spinner />
      ) : rows.length ? (
        <div className="-m-3">
          <Table minWidth={560} head={<tr><th>No</th><th>Date</th><th>Details</th><th className="text-right">Amount</th><th /></tr>}>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'cancelled' ? 'text-ink-3' : ''}>
                <td className="num font-semibold">
                  {r.number} {r.status === 'cancelled' && <Badge tone="bad">Cancelled</Badge>}
                </td>
                <td className="num">{fmtDate(r.entry_date)}</td>
                <td>
                  {r.kind === 'payment' && <>{r.supplier_name} <span className="text-ink-3">from {r.from_ledger_name}</span></>}
                  {r.kind === 'expense' && <>{r.ledger_name} <span className="text-ink-3">from {r.from_ledger_name}{r.gst_rate_bp ? ` · GST ${r.gst_rate_bp / 100}%` : ''}</span></>}
                  {r.kind === 'contra' && <>{r.from_ledger_name} → {r.ledger_name}{r.charges_paise ? <span className="text-ink-3"> · charges ₹{rs(r.charges_paise)}</span> : null}</>}
                  {r.narration && <div className="text-[12px] text-ink-3">{r.narration}</div>}
                  {r.status === 'cancelled' && r.cancel_reason && <div className="text-[12px] text-bad">Cancelled: {r.cancel_reason}</div>}
                </td>
                <td className={cx('num text-right font-bold', r.status === 'cancelled' && 'line-through')}>₹{rs(r.amount_paise)}</td>
                <td className="whitespace-nowrap text-right">
                  {r.file && (
                    <Button size="sm" variant="ghost" onClick={() => void showPhoto(r.id)}>
                      Bill photo
                    </Button>
                  )}
                  {r.status === 'posted' && can('accounts.manage') && (
                    <Button size="sm" variant="ghost" onClick={() => setCancel(r)}>
                      Cancel…
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      ) : (
        <Empty>Nothing yet in this period.</Empty>
      )}
      <Modal open={!!cancel} onClose={() => setCancel(null)} title={`Cancel ${cancel?.number ?? ''}`} footer={<><Button variant="ghost" onClick={() => setCancel(null)}>Keep it</Button><Button variant="danger" busy={busy} disabled={reason.trim().length < 3} onClick={() => void doCancel()}>Cancel entry</Button></>}>
        <p className="mb-3 text-sm">The entry stays in the books, marked cancelled, and a reversing entry is posted today.</p>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </Modal>
      <Modal open={!!photo} onClose={() => setPhoto(null)} title="Expense bill" width={720}>
        {photo && <img src={photo} alt="Expense bill" className="max-h-[70vh] w-full object-contain" />}
      </Modal>
    </Panel>
  );
}

interface EntryRow {
  id: number;
  number: string;
  kind: string;
  entry_date: string;
  amount_paise: number;
  charges_paise: number;
  status: string;
  narration: string | null;
  reference: string | null;
  file: string | null;
  gst_rate_bp: number | null;
  supplier_name: string | null;
  ledger_name: string | null;
  from_ledger_name: string | null;
  cancel_reason: string | null;
}

// ------------------------------------------------------------------ pay supplier

interface DueBill {
  id: number;
  number: string;
  supplier_invoice_no: string;
  supplier_invoice_date: string;
  total_paise: number;
  due_paise: number;
}

function PaySupplier({ preselect }: { preselect: number | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ['suppliers', 'all'], queryFn: () => get<SupplierRow[]>('/api/suppliers') });
  const money = useMoneyLedgers();
  const [supplierId, setSupplierId] = useState<number | ''>(preselect ?? '');
  const [fromId, setFromId] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIst());
  const [reference, setReference] = useState('');
  const [narration, setNarration] = useState('');
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef(uuid());

  useEffect(() => setSupplierId(preselect ?? ''), [preselect]);
  const bills = useQuery({ queryKey: ['accounts', 'outstanding', supplierId], queryFn: () => get<DueBill[]>(`/api/suppliers/${supplierId}/outstanding`), enabled: !!supplierId });
  const due = (bills.data ?? []).filter((b) => b.due_paise > 0);
  const sup = suppliers.data?.find((s) => s.id === supplierId);
  useEffect(() => setAlloc({}), [supplierId]);

  const amountPaise = parseRupees(amount) ?? 0;
  const allocations = Object.entries(alloc)
    .map(([id, v]) => ({ purchaseId: Number(id), amountPaise: parseRupees(v) ?? 0 }))
    .filter((a) => a.amountPaise > 0);
  const allocated = allocations.reduce((t, a) => t + a.amountPaise, 0);

  /** Spread the amount over the oldest bills. */
  const autoAllocate = () => {
    let left = amountPaise;
    const next: Record<number, string> = {};
    for (const b of due) {
      if (left <= 0) break;
      const take = Math.min(left, b.due_paise);
      next[b.id] = (take / 100).toFixed(2);
      left -= take;
    }
    setAlloc(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ number: string }>('/api/money/payments', { clientRef: clientRef.current, supplierId, fromLedgerId: fromId, amountPaise, date, reference: reference || undefined, narration: narration || undefined, allocations });
      toast({ tone: 'good', text: `${r.number}: ₹${rs(amountPaise)} paid to ${sup?.name}` });
      clientRef.current = uuid();
      setAmount('');
      setReference('');
      setNarration('');
      setAlloc({});
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Pay a supplier">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" className="sm:col-span-2">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose…</option>
              {(suppliers.data ?? []).filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.payable_paise > 0 ? ` — we owe ₹${rs(s.payable_paise)}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <MoneyInput label="Amount paid" value={amount} onChange={setAmount} />
          <Field label="Paid from">
            <LedgerSelect ledgers={(money.data ?? []).filter((l) => l.kind !== 'clearing')} value={fromId} onChange={setFromId} />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Cheque / UTR no. (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Note (optional)" className="sm:col-span-2">
            <Input value={narration} onChange={(e) => setNarration(e.target.value)} />
          </Field>
        </div>
        {supplierId !== '' && (
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2">
              <b className="flex-1 text-sm">Settle bills (optional)</b>
              <Button size="sm" onClick={autoAllocate} disabled={!amountPaise || !due.length}>
                Oldest first
              </Button>
            </div>
            {bills.isLoading ? (
              <Spinner />
            ) : due.length ? (
              <div className="flex flex-col divide-y divide-line-3 rounded-[6px] border border-line">
                {due.map((b) => (
                  <div key={b.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">Bill {b.supplier_invoice_no}</div>
                      <div className="text-[12px] text-ink-3">
                        {fmtDate(b.supplier_invoice_date)} · {b.number} · due ₹{rs(b.due_paise)} of ₹{rs(b.total_paise)}
                      </div>
                    </div>
                    <Input aria-label={`Pay against ${b.supplier_invoice_no}`} inputMode="decimal" className="num w-[120px]" value={alloc[b.id] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [b.id]: e.target.value }))} placeholder="₹" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-3">No unpaid bills — the payment goes on account.</p>
            )}
            {allocated > 0 && (
              <p className={cx('mt-2 text-[13px]', allocated > amountPaise ? 'text-bad' : 'text-ink-3')}>
                Against bills ₹{rs(allocated)} · on account ₹{rs(Math.max(amountPaise - allocated, 0))}
              </p>
            )}
          </div>
        )}
        {error && <div className="mt-3"><Notice tone="bad">{error}</Notice></div>}
        <div className="mt-4">
          <Button variant="primary" busy={busy} disabled={!supplierId || !fromId || amountPaise <= 0 || allocated > amountPaise} onClick={() => void save()}>
            Save payment
          </Button>
        </div>
      </Panel>
      <EntryList kind="payment" title="Payments this period" />
    </div>
  );
}

// ------------------------------------------------------------------ expenses

const GST_RATES = [5, 12, 18, 28];

function Expenses() {
  const toast = useToast();
  const qc = useQueryClient();
  const money = useMoneyLedgers();
  const heads = useQuery({ queryKey: ['accounts', 'heads'], queryFn: () => get<Ledger[]>('/api/ledgers?kind=expense') });
  const [head, setHead] = useState<number | ''>('');
  const [fromId, setFromId] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIst());
  const [narration, setNarration] = useState('');
  const [gst, setGst] = useState(false);
  const [rate, setRate] = useState(18);
  const [inter, setInter] = useState(false);
  const [vendor, setVendor] = useState({ name: '', gstin: '', billNo: '' });
  const [photo, setPhoto] = useState<PreparedPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef(uuid());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fromId === '' && money.data) setFromId(money.data.find((l) => l.kind === 'cash')?.id ?? '');
  }, [money.data, fromId]);

  const amountPaise = parseRupees(amount) ?? 0;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ number: string }>('/api/money/expenses', {
        clientRef: clientRef.current,
        ledgerId: head,
        fromLedgerId: fromId,
        amountPaise,
        date,
        narration: narration || undefined,
        ...(gst ? { gstRateBp: rate * 100, interState: inter, vendorName: vendor.name || undefined, vendorGstin: vendor.gstin.toUpperCase().trim(), vendorBillNo: vendor.billNo } : {}),
        ...(photo ? { photo: { mimeType: photo.mimeType === 'application/pdf' ? 'application/pdf' : photo.mimeType === 'image/png' ? 'image/png' : 'image/jpeg', base64: photo.base64 } } : {}),
      });
      toast({ tone: 'good', text: `${r.number}: ₹${rs(amountPaise)} expense saved` });
      clientRef.current = uuid();
      setAmount('');
      setNarration('');
      setVendor({ name: '', gstin: '', billNo: '' });
      setPhoto(null);
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Enter an expense">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What for">
            <LedgerSelect ledgers={(heads.data ?? []).filter((h) => h.active && h.system_code !== 'round_off')} value={head} onChange={setHead} />
          </Field>
          <MoneyInput label={gst ? 'Bill total (incl. GST)' : 'Amount'} value={amount} onChange={setAmount} />
          <Field label="Paid from">
            <LedgerSelect ledgers={(money.data ?? []).filter((l) => l.kind !== 'clearing')} value={fromId} onChange={setFromId} />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Note" className="sm:col-span-2">
            <Input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="e.g. unloading 2 lorries of cement" />
          </Field>
        </div>
        <div className="mt-3">
          <Checkbox label="This is a GST bill (claim input tax credit)" checked={gst} onChange={setGst} />
        </div>
        {gst && (
          <div className="mt-3 grid gap-3 rounded-[6px] bg-paper p-3 sm:grid-cols-2">
            <Field label="GST rate">
              <Select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Their GSTIN">
              <Input value={vendor.gstin} onChange={(e) => setVendor((v) => ({ ...v, gstin: e.target.value }))} className="uppercase" maxLength={15} />
            </Field>
            <Field label="Their bill no">
              <Input value={vendor.billNo} onChange={(e) => setVendor((v) => ({ ...v, billNo: e.target.value }))} />
            </Field>
            <Field label="Their name">
              <Input value={vendor.name} onChange={(e) => setVendor((v) => ({ ...v, name: e.target.value }))} />
            </Field>
            <div className="sm:col-span-2">
              <Checkbox label="From another state (IGST)" checked={inter} onChange={setInter} />
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => fileRef.current?.click()}>{photo ? 'Change bill photo' : 'Add bill photo'}</Button>
          {photo && (
            <span className="text-[13px] text-ink-3">
              {photo.name} <button type="button" className="underline" onClick={() => setPhoto(null)}>remove</button>
            </span>
          )}
          <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPhoto(await preparePage(f)); e.target.value = ''; }} />
        </div>
        {error && <div className="mt-3"><Notice tone="bad">{error}</Notice></div>}
        <div className="mt-4">
          <Button variant="primary" busy={busy} disabled={!head || !fromId || amountPaise <= 0} onClick={() => void save()}>
            Save expense
          </Button>
        </div>
      </Panel>
      <EntryList kind="expense" title="Expenses this period" />
    </div>
  );
}

// ------------------------------------------------------------------ contra

function Contra() {
  const toast = useToast();
  const qc = useQueryClient();
  const money = useMoneyLedgers();
  const [fromId, setFromId] = useState<number | ''>('');
  const [toId, setToId] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [charges, setCharges] = useState('');
  const [date, setDate] = useState(todayIst());
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef(uuid());
  const amountPaise = parseRupees(amount) ?? 0;
  const chargesPaise = charges ? (parseRupees(charges) ?? 0) : 0;
  const ledgers = money.data ?? [];
  const from = ledgers.find((l) => l.id === fromId);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ number: string }>('/api/money/contra', { clientRef: clientRef.current, fromLedgerId: fromId, toLedgerId: toId, amountPaise, chargesPaise, date, reference: reference || undefined });
      toast({ tone: 'good', text: `${r.number} saved` });
      clientRef.current = uuid();
      setAmount('');
      setCharges('');
      setReference('');
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Move money between cash and bank">
        <p className="mb-3 text-[13px] text-ink-3">Cash deposited in the bank, cash withdrawn, or UPI / card money that the bank has credited (with any charges they cut).</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <Select value={fromId} onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose…</option>
              {ledgers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} (₹{drcr(l.balance_paise)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="To">
            <LedgerSelect ledgers={ledgers.filter((l) => l.id !== fromId)} value={toId} onChange={setToId} />
          </Field>
          <MoneyInput label="Amount" value={amount} onChange={setAmount} />
          <MoneyInput label="Charges cut (optional)" value={charges} onChange={setCharges} hint={from?.kind === 'clearing' ? 'e.g. card machine fee — booked to Bank Charges' : undefined} />
          <Field label="Date">
            <Input type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reference (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="deposit slip / UTR" />
          </Field>
        </div>
        {chargesPaise > 0 && amountPaise > 0 && <p className="mt-2 text-[13px] text-ink-3">The bank gets ₹{rs(amountPaise - chargesPaise)}; ₹{rs(chargesPaise)} goes to Bank Charges.</p>}
        {error && <div className="mt-3"><Notice tone="bad">{error}</Notice></div>}
        <div className="mt-4">
          <Button variant="primary" busy={busy} disabled={!fromId || !toId || amountPaise <= 0} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </Panel>
      <EntryList kind="contra" title="Cash ↔ bank this period" />
    </div>
  );
}

// ------------------------------------------------------------------ journal

function Journal() {
  const toast = useToast();
  const qc = useQueryClient();
  const all = useQuery({ queryKey: ['accounts', 'all-ledgers'], queryFn: () => get<Ledger[]>('/api/ledgers?includeParties=true') });
  const empty = () => ({ key: uuid(), ledgerId: '' as number | '', dr: '', cr: '' });
  const [lines, setLines] = useState([empty(), empty()]);
  const [narration, setNarration] = useState('');
  const [date, setDate] = useState(todayIst());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef(uuid());
  const dr = lines.reduce((t, l) => t + (parseRupees(l.dr) ?? 0), 0);
  const cr = lines.reduce((t, l) => t + (parseRupees(l.cr) ?? 0), 0);
  const set = (key: string, patch: Partial<ReturnType<typeof empty>>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ number: string }>('/api/money/journals', {
        clientRef: clientRef.current,
        date,
        narration,
        lines: lines.filter((l) => l.ledgerId).map((l) => ({ ledgerId: l.ledgerId, drPaise: parseRupees(l.dr) ?? 0, crPaise: parseRupees(l.cr) ?? 0 })),
      });
      toast({ tone: 'good', text: `${r.number} saved` });
      clientRef.current = uuid();
      setLines([empty(), empty()]);
      setNarration('');
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Panel title="Journal entry">
        <p className="mb-3 text-[13px] text-ink-3">For corrections and anything the other screens don't cover. Debits must equal credits; a reason is required.</p>
        <div className="flex flex-col gap-2">
          {lines.map((l) => (
            <div key={l.key} className="grid grid-cols-[minmax(0,1fr)_110px_110px] gap-2">
              <Select aria-label="Account" value={l.ledgerId} onChange={(e) => set(l.key, { ledgerId: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">Account…</option>
                {(all.data ?? []).filter((x) => x.active).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} · {x.group_name}
                  </option>
                ))}
              </Select>
              <Input aria-label="Debit" placeholder="Debit" inputMode="decimal" className="num" value={l.dr} onChange={(e) => set(l.key, { dr: e.target.value, cr: '' })} />
              <Input aria-label="Credit" placeholder="Credit" inputMode="decimal" className="num" value={l.cr} onChange={(e) => set(l.key, { cr: e.target.value, dr: '' })} />
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setLines((ls) => [...ls, empty()])}>
              Add line
            </Button>
            <span className={cx('num ml-auto text-sm', dr === cr && dr > 0 ? 'text-good' : 'text-ink-3')}>
              Dr ₹{rs(dr)} · Cr ₹{rs(cr)}
              {dr !== cr && ` · difference ₹${rs(Math.abs(dr - cr))}`}
            </span>
          </div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_180px]">
          <Field label="Reason (narration)">
            <Input value={narration} onChange={(e) => setNarration(e.target.value)} />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {error && <div className="mt-3"><Notice tone="bad">{error}</Notice></div>}
        <div className="mt-4">
          <Button variant="primary" busy={busy} disabled={dr !== cr || dr <= 0 || narration.trim().length < 5} onClick={() => void save()}>
            Save journal
          </Button>
        </div>
      </Panel>
      <EntryList kind="journal" title="Journals this period" />
    </div>
  );
}

// ------------------------------------------------------------------ books

function Books() {
  const toast = useToast();
  const [view, setView] = useState<'ledger' | 'day' | 'trial'>('ledger');
  const all = useQuery({ queryKey: ['accounts', 'all-ledgers'], queryFn: () => get<Ledger[]>('/api/ledgers?includeParties=true') });
  const cashId = all.data?.find((l) => l.system_code === 'cash')?.id;
  const [ledgerId, setLedgerId] = useState<number | ''>('');
  useEffect(() => {
    if (ledgerId === '' && cashId) setLedgerId(cashId);
  }, [cashId, ledgerId]);
  const [from, setFrom] = useState(`${todayIst().slice(0, 8)}01`);
  const [to, setTo] = useState(todayIst());
  const path = view === 'ledger' ? `/api/ledgers/${ledgerId}/statement?from=${from}&to=${to}` : view === 'day' ? `/api/books/day?from=${from}&to=${to}` : `/api/books/trial-balance?asOf=${to}`;
  const data = useQuery({ queryKey: ['accounts', 'books', path], queryFn: () => get(path), enabled: view !== 'ledger' || !!ledgerId });

  const ordered = useMemo(() => {
    const ls = all.data ?? [];
    const rank = (l: Ledger) => (l.kind === 'cash' ? 0 : l.kind === 'bank' ? 1 : l.kind === 'clearing' ? 2 : l.group_name.startsWith('Sundry') ? 4 : 3);
    return [...ls].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [all.data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-white p-3">
        <Field label="Book">
          <Select value={view} onChange={(e) => setView(e.target.value as typeof view)}>
            <option value="ledger">Ledger / Cash book / Bank book</option>
            <option value="day">Day book</option>
            <option value="trial">Trial balance</option>
          </Select>
        </Field>
        {view === 'ledger' && (
          <Field label="Account">
            <Select value={ledgerId} onChange={(e) => setLedgerId(e.target.value ? Number(e.target.value) : '')} className="min-w-[260px]">
              {ordered.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.group_name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {view !== 'trial' && (
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        )}
        <Field label={view === 'trial' ? 'As on' : 'To'}>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="ml-auto">
          <Button variant="primary" disabled={!data.data} onClick={() => download(`${path}&format=xlsx`, 'book.xlsx').catch((e) => toast({ tone: 'bad', text: errText(e) }))}>
            Download Excel
          </Button>
        </div>
      </div>
      {data.isLoading && <Spinner />}
      {data.error && <Notice tone="bad">{errText(data.error)}</Notice>}
      {data.data && view === 'ledger' && <LedgerView d={data.data} />}
      {data.data && view === 'day' && <DayBookView d={data.data} />}
      {data.data && view === 'trial' && <TrialView d={data.data} />}
    </div>
  );
}

function LedgerView({ d }: { d: { ledger: { name: string; group_name: string }; openingPaise: number; closingPaise: number; totalDrPaise: number; totalCrPaise: number; from: string; to: string; entries: { voucher_id: number; vdate: string; vtype: string; narration: string | null; other: string | null; dr_paise: number; cr_paise: number; balance_paise: number }[] } }) {
  return (
    <section className="overflow-hidden rounded-[6px] border border-line bg-white">
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line px-3 py-2.5 text-sm">
        <b className="text-[15px]">{d.ledger.name}</b>
        <span className="text-ink-3">{d.ledger.group_name}</span>
        <span className="ml-auto">
          Opening <b className="num">₹{drcr(d.openingPaise)}</b>
        </span>
        <span>
          Closing <b className="num">₹{drcr(d.closingPaise)}</b>
        </span>
      </div>
      {d.entries.length ? (
        <Table head={<tr><th>Date</th><th>Type</th><th>Particulars</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th></tr>}>
          {d.entries.map((e) => (
            <tr key={e.voucher_id}>
              <td className="num whitespace-nowrap">{fmtDate(e.vdate)}</td>
              <td><Badge>{e.vtype.replace('_', ' ')}</Badge></td>
              <td>
                {e.narration}
                {e.other && <div className="text-[12px] text-ink-3">{e.other}</div>}
              </td>
              <td className="num text-right">{e.dr_paise ? rs(e.dr_paise) : ''}</td>
              <td className="num text-right">{e.cr_paise ? rs(e.cr_paise) : ''}</td>
              <td className="num whitespace-nowrap text-right font-semibold">{drcr(e.balance_paise)}</td>
            </tr>
          ))}
          <tr className="bg-paper font-bold">
            <td colSpan={3}>Total</td>
            <td className="num text-right">{rs(d.totalDrPaise)}</td>
            <td className="num text-right">{rs(d.totalCrPaise)}</td>
            <td className="num text-right">{drcr(d.closingPaise)}</td>
          </tr>
        </Table>
      ) : (
        <Empty>No entries in this period.</Empty>
      )}
    </section>
  );
}

function DayBookView({ d }: { d: { vouchers: { id: number; vdate: string; vtype: string; narration: string | null; user_name: string | null; lines: { ledger: string; dr: number; cr: number }[] }[] } }) {
  if (!d.vouchers.length) return <Empty>No entries in this period.</Empty>;
  return (
    <section className="overflow-hidden rounded-[6px] border border-line bg-white">
      <Table head={<tr><th>Date</th><th>Type</th><th>Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr>}>
        {d.vouchers.map((v) =>
          v.lines.map((l, i) => (
            <tr key={`${v.id}-${i}`} className={i === 0 ? 'border-t-2 border-line' : ''}>
              <td className="num whitespace-nowrap">{i === 0 ? fmtDate(v.vdate) : ''}</td>
              <td>{i === 0 ? <Badge>{v.vtype.replace('_', ' ')}</Badge> : ''}</td>
              <td>
                <span className={l.cr ? 'pl-6' : ''}>{l.ledger}</span>
                {i === v.lines.length - 1 && v.narration && <div className="text-[12px] text-ink-3">{v.narration}{v.user_name ? ` · ${v.user_name}` : ''}</div>}
              </td>
              <td className="num text-right">{l.dr ? rs(l.dr) : ''}</td>
              <td className="num text-right">{l.cr ? rs(l.cr) : ''}</td>
            </tr>
          )),
        )}
      </Table>
    </section>
  );
}

function TrialView({ d }: { d: { asOf: string; groups: { group: string; accounts: { id: number | null; name: string; dr: number; cr: number }[] }[]; totalDrPaise: number; totalCrPaise: number; differencePaise: number } }) {
  return (
    <section className="overflow-hidden rounded-[6px] border border-line bg-white">
      {d.differencePaise !== 0 && (
        <div className="p-3">
          <Notice tone="warn">Debits and credits differ by ₹{rs(Math.abs(d.differencePaise))}. This is expected until the opening balances are confirmed (Accounts → Setup).</Notice>
        </div>
      )}
      <Table minWidth={520} head={<tr><th>Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr>}>
        {d.groups.map((g) => [
          <tr key={g.group} className="bg-paper"><td colSpan={3} className="font-bold">{g.group}</td></tr>,
          ...g.accounts.map((a, i) => (
            <tr key={`${g.group}-${i}`}><td className="pl-6">{a.name}</td><td className="num text-right">{a.dr ? rs(a.dr) : ''}</td><td className="num text-right">{a.cr ? rs(a.cr) : ''}</td></tr>
          )),
        ])}
        <tr className="font-bold"><td>Total</td><td className="num text-right">{rs(d.totalDrPaise)}</td><td className="num text-right">{rs(d.totalCrPaise)}</td></tr>
      </Table>
    </section>
  );
}

// ------------------------------------------------------------------ supplier dues

function SupplierDues({ onPay }: { onPay: (supplierId: number) => void }) {
  const { can } = useSession();
  const toast = useToast();
  const d = useQuery({ queryKey: ['accounts', 'ageing'], queryFn: () => get<{ asOf: string; suppliers: { supplierId: number; name: string; phone: string | null; owePaise: number; buckets: number[]; oldestDue: string | null }[]; totals: { owe: number; b: number[] } }>('/api/reports/supplier-ageing') });
  if (d.isLoading) return <Spinner />;
  if (!d.data) return <Notice tone="bad">{errText(d.error)}</Notice>;
  const t = d.data.totals;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[['We owe', t.owe], ['0–30 days', t.b[0]], ['31–60 days', t.b[1]], ['61–90 days', t.b[2]], ['Over 90 days', t.b[3]]].map(([label, v], i) => (
          <div key={String(label)} className={cx('rounded-[6px] border bg-white px-3 py-2.5', i === 4 && Number(v) > 0 ? 'border-brick' : 'border-line')}>
            <div className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">{label}</div>
            <div className="num mt-0.5 text-[20px] font-extrabold">₹{rs(Number(v))}</div>
          </div>
        ))}
      </div>
      <Panel title={`Suppliers we owe, as on ${fmtDate(d.data.asOf)}`} actions={<Button size="sm" onClick={() => download('/api/reports/supplier-ageing?format=xlsx', 'supplier-ageing.xlsx').catch((e) => toast({ tone: 'bad', text: errText(e) }))}>Download Excel</Button>}>
        {d.data.suppliers.length ? (
          <div className="-m-3">
            <Table head={<tr><th>Supplier</th><th className="text-right">We owe</th><th className="text-right">0–30</th><th className="text-right">31–60</th><th className="text-right">61–90</th><th className="text-right">90+</th><th>Oldest unpaid</th><th /></tr>}>
              {d.data.suppliers.map((s) => (
                <tr key={s.supplierId}>
                  <td className="font-semibold">{s.name} {s.phone && <span className="text-[12px] font-normal text-ink-3">{s.phone}</span>}</td>
                  <td className="num text-right font-bold">{s.owePaise < 0 ? <Badge tone="teal">advance ₹{rs(-s.owePaise)}</Badge> : rs(s.owePaise)}</td>
                  {s.buckets.map((b, i) => (
                    <td key={i} className={cx('num text-right', i === 3 && b > 0 && 'font-bold text-bad')}>{b ? rs(b) : '—'}</td>
                  ))}
                  <td className="num">{s.oldestDue ? fmtDate(s.oldestDue) : ''}</td>
                  <td className="text-right">{can('payments.make') && s.owePaise > 0 && <Button size="sm" onClick={() => onPay(s.supplierId)}>Pay…</Button>}</td>
                </tr>
              ))}
            </Table>
          </div>
        ) : (
          <Empty>We don't owe any supplier.</Empty>
        )}
        <p className="mt-3 text-[12px] text-ink-3">Payments marked against bills settle those bills; other payments settle the oldest bills first.</p>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ cash count

const NOTES = [500, 200, 100, 50, 20, 10, 5, 2, 1];

function CashCount() {
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIst());
  const pos = useQuery({ queryKey: ['accounts', 'cash', date], queryFn: () => get<{ openingPaise: number; inPaise: number; outPaise: number; bookPaise: number; closings: { id: number; at: string; book_paise: number; counted_paise: number; difference_paise: number; note: string | null; user_name: string; adjustment_entry_id: number | null }[] }>(`/api/cash/position?date=${date}`) });
  const [count, setCount] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [bookIt, setBookIt] = useState(false);
  const [busy, setBusy] = useState(false);
  const counted = NOTES.reduce((t, n) => t + n * 100 * (Number(count[n]) || 0), 0);
  const diff = pos.data ? counted - pos.data.bookPaise : 0;

  const save = async () => {
    setBusy(true);
    try {
      const den = Object.fromEntries(NOTES.filter((n) => Number(count[n]) > 0).map((n) => [String(n), Number(count[n])]));
      const r = await post<{ differencePaise: number }>('/api/cash/close', { date, denominations: den, note: note || undefined, bookDifference: bookIt });
      toast({ tone: r.differencePaise === 0 ? 'good' : 'warn', text: r.differencePaise === 0 ? 'Cash matches the books' : `Cash ${r.differencePaise > 0 ? 'excess' : 'short'} ₹${rs(Math.abs(r.differencePaise))} — recorded` });
      setCount({});
      setNote('');
      setBookIt(false);
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const p = pos.data;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Count the cash drawer" actions={<Input type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} className="h-8 w-[150px]" />}>
        {!p ? (
          <Spinner />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {[['Opening', p.openingPaise], ['Cash in', p.inPaise], ['Cash out', p.outPaise], ['Should be', p.bookPaise]].map(([l, v], i) => (
                <div key={String(l)} className={cx('rounded-[6px] px-3 py-2', i === 3 ? 'bg-teal-soft text-teal' : 'bg-paper')}>
                  <div className="text-[11px] font-bold uppercase tracking-[.1em]">{l}</div>
                  <div className="num text-[17px] font-extrabold">₹{rs(Number(v))}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {NOTES.map((n) => (
                <label key={n} className="flex flex-col gap-1 text-[12px] font-semibold text-ink-2">
                  ₹{n} {n >= 10 ? 'notes' : 'coins'}
                  <Input inputMode="numeric" className="num" value={count[n] ?? ''} onChange={(e) => setCount((c) => ({ ...c, [n]: e.target.value.replace(/\D/g, '') }))} placeholder="0" />
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="text-sm">
                Counted <b className="num text-[20px]">₹{rs(counted)}</b>
              </span>
              {counted > 0 && (
                <span className={cx('num text-[15px] font-bold', diff === 0 ? 'text-good' : 'text-bad')}>
                  {diff === 0 ? 'Matches the books' : `${diff > 0 ? 'Excess' : 'Short'} ₹${rs(Math.abs(diff))}`}
                </span>
              )}
            </div>
            {counted > 0 && diff !== 0 && (
              <div className="mt-3 flex flex-col gap-2">
                <Field label="What happened? (optional)">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
                {can('accounts.manage') && <Checkbox label="Book the difference to “Cash Short & Excess” so the cash book matches the drawer" checked={bookIt} onChange={setBookIt} />}
              </div>
            )}
            <div className="mt-4">
              <Button variant="primary" busy={busy} disabled={counted <= 0 && !confirmZero(p.bookPaise)} onClick={() => void save()}>
                Save count
              </Button>
            </div>
          </>
        )}
      </Panel>
      <Panel title="Counts on this day">
        {p?.closings.length ? (
          <div className="-m-3">
            <Table minWidth={480} head={<tr><th>Time</th><th>By</th><th className="text-right">Should be</th><th className="text-right">Counted</th><th className="text-right">Difference</th></tr>}>
              {p.closings.map((c) => (
                <tr key={c.id}>
                  <td className="num">{fmtDateTime(c.at)}</td>
                  <td>{c.user_name}</td>
                  <td className="num text-right">{rs(c.book_paise)}</td>
                  <td className="num text-right">{rs(c.counted_paise)}</td>
                  <td className={cx('num text-right font-bold', c.difference_paise !== 0 && 'text-bad')}>
                    {c.difference_paise === 0 ? '—' : `${c.difference_paise > 0 ? '+' : '−'}${rs(Math.abs(c.difference_paise))}`}
                    {c.adjustment_entry_id && <div className="text-[11px] font-normal text-ink-3">booked</div>}
                    {c.note && <div className="text-[11px] font-normal text-ink-3">{c.note}</div>}
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        ) : (
          <Empty>Not counted yet.</Empty>
        )}
      </Panel>
    </div>
  );
}
const confirmZero = (book: number) => book === 0;

// ------------------------------------------------------------------ setup

function Setup() {
  const toast = useToast();
  const qc = useQueryClient();
  const banks = useQuery({ queryKey: ['accounts', 'banks'], queryFn: () => get<Ledger[]>('/api/ledgers?kind=bank') });
  const heads = useQuery({ queryKey: ['accounts', 'heads'], queryFn: () => get<Ledger[]>('/api/ledgers?kind=expense') });
  const [bank, setBank] = useState({ name: '', accountNo: '', ifsc: '' });
  const [head, setHead] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (body: unknown, done: () => void) => {
    setBusy(true);
    try {
      await post('/api/ledgers', body);
      done();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (l: Ledger) => {
    try {
      await patch(`/api/ledgers/${l.id}`, { active: !l.active });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Bank accounts">
          <div className="flex flex-col divide-y divide-line-3">
            {(banks.data ?? []).map((b) => (
              <div key={b.id} className="flex items-center gap-2 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <b>{b.name}</b> {!b.active && <Badge>hidden</Badge>}
                  <div className="text-[12px] text-ink-3">{[b.details?.accountNo, b.details?.ifsc].filter(Boolean).join(' · ') || 'Default bank account'}</div>
                </div>
                <span className="num">₹{drcr(b.balance_paise)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px_140px_auto]">
            <Input placeholder="e.g. SBI Current A/c" value={bank.name} onChange={(e) => setBank((b) => ({ ...b, name: e.target.value }))} />
            <Input placeholder="A/c no (last 4)" value={bank.accountNo} onChange={(e) => setBank((b) => ({ ...b, accountNo: e.target.value }))} />
            <Input placeholder="IFSC" className="uppercase" value={bank.ifsc} onChange={(e) => setBank((b) => ({ ...b, ifsc: e.target.value }))} />
            <Button busy={busy} disabled={bank.name.trim().length < 2} onClick={() => void add({ name: bank.name, kind: 'bank', details: { accountNo: bank.accountNo, ifsc: bank.ifsc.toUpperCase() } }, () => setBank({ name: '', accountNo: '', ifsc: '' }))}>
              Add bank
            </Button>
          </div>
          <p className="mt-2 text-[12px] text-ink-3">UPI and card money first collects in “UPI Collections” / “Card Collections”. When the bank credits it, record it under Cash ↔ bank.</p>
        </Panel>
        <Panel title="Expense heads">
          <div className="flex flex-wrap gap-2">
            {(heads.data ?? []).filter((h) => h.system_code !== 'round_off').map((h) => (
              <button key={h.id} type="button" onClick={() => !h.system_code && void toggle(h)} title={h.system_code ? 'Used by the app' : h.active ? 'Click to hide' : 'Click to show again'} className={cx('rounded-full border px-3 py-1 text-[13px]', h.active ? 'border-line-2 bg-white' : 'border-dashed border-line-2 text-ink-3 line-through')}>
                {h.name}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Input placeholder="New expense head, e.g. Godown rent" value={head} onChange={(e) => setHead(e.target.value)} />
            <Button busy={busy} disabled={head.trim().length < 2} onClick={() => void add({ name: head, kind: 'expense' }, () => setHead(''))}>
              Add
            </Button>
          </div>
        </Panel>
      </div>
      <OpeningBalances />
    </div>
  );
}

interface Opening {
  openingDate: string;
  locked: boolean;
  ledgers: { id: number; name: string; group_name: string; nature: string; kind: string | null; system_code: string | null; opening_dr_paise: number }[];
  customers: { totalPaise: number; count: number };
  suppliers: { totalPaise: number; count: number };
  stock: { valuePaise: number; items: number };
  capitalPaise: number;
}

function OpeningBalances() {
  const toast = useToast();
  const qc = useQueryClient();
  const o = useQuery({ queryKey: ['accounts', 'opening'], queryFn: () => get<Opening>('/api/opening') });
  const [date, setDate] = useState('');
  const [vals, setVals] = useState<Record<number, { amt: string; side: 'dr' | 'cr' }>>({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!o.data) return;
    setDate(o.data.openingDate);
    setVals(Object.fromEntries(o.data.ledgers.map((l) => [l.id, { amt: l.opening_dr_paise ? (Math.abs(l.opening_dr_paise) / 100).toFixed(2) : '', side: l.opening_dr_paise < 0 || l.nature === 'liability' ? 'cr' : 'dr' }])));
  }, [o.data]);

  if (!o.data) return <Spinner />;
  const d = o.data;
  const editable = d.ledgers.filter((l) => l.system_code !== 'capital');

  const save = async () => {
    setBusy(true);
    try {
      const ledgers = editable.map((l) => {
        const v = vals[l.id];
        const p = v?.amt ? (parseRupees(v.amt) ?? 0) : 0;
        return { ledgerId: l.id, drPaise: v?.side === 'cr' ? -p : p };
      }).filter((x, i) => x.drPaise !== editable[i]!.opening_dr_paise);
      const r = await put<Opening>('/api/opening', { openingDate: date || undefined, ledgers });
      qc.setQueryData(['accounts', 'opening'], r);
      toast({ tone: 'good', text: 'Opening balances saved' });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const lock = async () => {
    setBusy(true);
    try {
      const r = await post<Opening>('/api/opening/lock');
      qc.setQueryData(['accounts', 'opening'], r);
      setConfirm(false);
      toast({ tone: 'good', text: 'Opening balances confirmed' });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Opening balances" actions={d.locked ? <Badge tone="good">Confirmed · books start {fmtDate(d.openingDate)}</Badge> : undefined}>
      <p className="mb-3 text-[13px] text-ink-3">
        The balances on the day Store Desk takes over the books (ideally from your CA's trial balance). Customers and suppliers get theirs from Customers / Suppliers or the Excel import; stock from the opening stock entered in Inventory.
      </p>
      <div className="mb-3 max-w-[220px]">
        <Field label="Go-live date">
          <Input type="date" value={date} disabled={d.locked} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <div className="-mx-3">
        <Table minWidth={560} head={<tr><th>Account</th><th>Group</th><th className="text-right">Amount</th><th>Dr / Cr</th></tr>}>
          {editable.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td className="text-ink-3">{l.group_name}</td>
              <td className="text-right">
                <Input aria-label={`${l.name} opening`} disabled={d.locked} inputMode="decimal" className="num ml-auto w-[140px] text-right" value={vals[l.id]?.amt ?? ''} onChange={(e) => setVals((v) => ({ ...v, [l.id]: { side: v[l.id]?.side ?? 'dr', amt: e.target.value } }))} />
              </td>
              <td>
                <Select aria-label={`${l.name} side`} disabled={d.locked} value={vals[l.id]?.side ?? 'dr'} onChange={(e) => setVals((v) => ({ ...v, [l.id]: { amt: v[l.id]?.amt ?? '', side: e.target.value as 'dr' | 'cr' } }))} className="w-[90px]">
                  <option value="dr">Dr</option>
                  <option value="cr">Cr</option>
                </Select>
              </td>
            </tr>
          ))}
          <tr className="bg-paper"><td>Customers owe us ({d.customers.count})</td><td className="text-ink-3">Sundry Debtors</td><td className="num text-right">{rs(d.customers.totalPaise)}</td><td>Dr</td></tr>
          <tr className="bg-paper"><td>We owe suppliers ({d.suppliers.count})</td><td className="text-ink-3">Sundry Creditors</td><td className="num text-right">{rs(d.suppliers.totalPaise)}</td><td>Cr</td></tr>
          <tr className="bg-paper"><td>Opening stock at cost ({d.stock.items} items)</td><td className="text-ink-3">Stock-in-Hand</td><td className="num text-right">{rs(d.stock.valuePaise)}</td><td>Dr</td></tr>
          <tr className="font-bold"><td>Capital Account (worked out)</td><td className="text-ink-3">Capital Account</td><td className="num text-right">{rs(Math.abs(d.capitalPaise))}</td><td>{d.capitalPaise >= 0 ? 'Cr' : 'Dr'}</td></tr>
        </Table>
      </div>
      {!d.locked && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button busy={busy} onClick={() => void save()}>
            Save
          </Button>
          <Button variant="primary" disabled={!d.openingDate} onClick={() => setConfirm(true)}>
            Confirm and lock…
          </Button>
        </div>
      )}
      <ConfirmTyped open={confirm} onClose={() => setConfirm(false)} title="Confirm opening balances" word="CONFIRM" busy={busy} onConfirm={() => void lock()} confirmLabel="Confirm and lock">
        After this the opening balances can't be changed — corrections are made with a journal entry. Capital will be ₹{rs(Math.abs(d.capitalPaise))} {d.capitalPaise >= 0 ? 'Cr' : 'Dr'}.
      </ConfirmTyped>
    </Panel>
  );
}

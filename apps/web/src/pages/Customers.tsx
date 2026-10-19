import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, parseRupees } from '@kph/core';
import { ApiError, get, patch, post, qs } from '../lib/api';
import { MODE_LABEL, csvCell, downloadText, fmtDate, uuid } from '../lib/format';
import { useOverride } from '../lib/override';
import { useSession } from '../lib/session';
import type { CustomerRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, cx, useDebounced, useToast } from '../components/ui';
import { InvoiceModal } from './Sales';

const money = (p: number) => `₹${formatPaise(p)}`;

export function Customers() {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const s = useDebounced(search);
  const list = useQuery({ queryKey: ['customers', s, dueOnly], queryFn: () => get<CustomerRow[]>(`/api/customers${qs({ search: s, withBalanceOnly: dueOnly || undefined })}`) });
  const [editing, setEditing] = useState<CustomerRow | 'new' | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const rows = list.data ?? [];
  const due = rows.reduce((a, c) => a + Math.max(0, c.balance_paise), 0);

  const exportCsv = () => {
    const head = ['Name', 'Phone', 'GSTIN', 'Address', 'Credit limit', 'Balance due', 'Total purchases', 'Bills'];
    const lines = rows.map((c) => [c.name, c.phone, c.gstin, c.address, c.credit_limit_paise != null ? formatPaise(c.credit_limit_paise) : '', formatPaise(c.balance_paise), formatPaise(c.total_purchases_paise), c.bill_count].map(csvCell).join(','));
    downloadText('customers.csv', [head.join(','), ...lines].join('\n'));
  };

  return (
    <Page>
      <PageTitle
        telugu="కస్టమర్లు"
        title="Customers"
        sub={<span className="num">{rows.length} customers · {money(due)} due in this view</span>}
        actions={
          <>
            <Button onClick={exportCsv} disabled={!rows.length}>
              Export
            </Button>
            {can('customers.manage') && (
              <Button variant="primary" onClick={() => setEditing('new')}>
                + Add customer
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Input aria-label="Search customers" placeholder="Search name or phone…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-[240px] flex-1" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-teal" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />
          Only customers with a balance
        </label>
      </div>
      <div className="overflow-hidden rounded-[6px] border border-line bg-white">
        <Table
          head={
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th className="text-right">Total purchases</th>
              <th className="text-right">Balance due</th>
              <th className="text-right">Credit limit</th>
              <th>Last bill</th>
            </tr>
          }
        >
          {rows.map((c) => (
            <tr key={c.id} className="cursor-pointer hover:bg-paper" onClick={() => setOpenId(c.id)}>
              <td>
                <button type="button" className="font-bold underline-offset-2 hover:underline">
                  {c.name}
                </button>
                {c.address && <div className="text-xs text-ink-3">{c.address}</div>}
              </td>
              <td className="num">{c.phone ?? '—'}</td>
              <td className="num text-right">{money(c.total_purchases_paise)}</td>
              <td className={cx('num text-right font-bold', c.balance_paise > 0 ? 'text-warn' : c.balance_paise < 0 ? 'text-good' : 'text-ink-3')}>
                {c.balance_paise < 0 ? `${money(-c.balance_paise)} advance` : money(c.balance_paise)}
              </td>
              <td className={cx('num text-right', c.credit_limit_paise != null && c.balance_paise > c.credit_limit_paise && 'font-bold text-bad')}>{c.credit_limit_paise != null ? money(c.credit_limit_paise) : '—'}</td>
              <td className="num text-ink-3">{c.last_bill_at ? fmtDate(c.last_bill_at) : '—'}</td>
            </tr>
          ))}
        </Table>
        {list.isLoading && (
          <div className="flex items-center gap-2 p-6 text-ink-3">
            <Spinner /> Loading…
          </div>
        )}
        {!list.isLoading && rows.length === 0 && <Empty>No customers found.</Empty>}
      </div>
      <CustomerForm open={editing != null} customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      <CustomerDetail id={openId} onClose={() => setOpenId(null)} onEdit={(c) => setEditing(c)} />
    </Page>
  );
}

function CustomerForm({ open, customer, onClose }: { open: boolean; customer: CustomerRow | null; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = can('settings.manage');
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF({
      name: customer?.name ?? '',
      phone: customer?.phone ?? '',
      gstin: customer?.gstin ?? '',
      address: customer?.address ?? '',
      limit: customer?.credit_limit_paise != null ? formatPaise(customer.credit_limit_paise).replace(/,/g, '') : '',
      notes: customer?.notes ?? '',
      opening: '',
    });
  }, [open, customer]);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    setError(null);
    const body: Record<string, unknown> = { name: f.name, phone: f.phone || null, gstin: f.gstin || null, address: f.address || null, notes: f.notes || null };
    if (admin) {
      body.creditLimitPaise = f.limit?.trim() ? parseRupees(f.limit) : null;
      if (f.limit?.trim() && body.creditLimitPaise == null) return setError('Credit limit is not a valid amount');
      if (!customer && f.opening?.trim()) {
        const o = parseRupees(f.opening);
        if (o == null) return setError('Opening balance is not a valid amount');
        body.openingBalancePaise = o;
      }
    }
    setBusy(true);
    try {
      if (customer) await patch(`/api/customers/${customer.id}`, body);
      else await post('/api/customers', body);
      toast({ tone: 'good', text: `Saved ${f.name}` });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      await qc.invalidateQueries({ queryKey: ['customer'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={customer ? 'Edit customer' : 'Add customer'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" busy={busy} disabled={(f.name ?? '').trim().length < 2} onClick={submit}>
            Save customer
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
        <Field label="Name" className="sm:col-span-2">
          <Input value={f.name ?? ''} onChange={set('name')} autoFocus />
        </Field>
        <Field label="Phone">
          <Input value={f.phone ?? ''} onChange={set('phone')} inputMode="tel" />
        </Field>
        <Field label="GSTIN (for business customers)">
          <Input value={f.gstin ?? ''} onChange={set('gstin')} />
        </Field>
        <Field label="Area / address" className="sm:col-span-2">
          <Input value={f.address ?? ''} onChange={set('address')} />
        </Field>
        {admin && (
          <Field label="Credit limit (₹)" hint="Blank = no limit set">
            <Input value={f.limit ?? ''} onChange={set('limit')} inputMode="decimal" />
          </Field>
        )}
        {admin && !customer && (
          <Field label="Opening balance (₹ they already owe)" hint="For dues from before Store Desk">
            <Input value={f.opening ?? ''} onChange={set('opening')} inputMode="decimal" />
          </Field>
        )}
        <Field label="Notes" className="sm:col-span-2">
          <Input value={f.notes ?? ''} onChange={set('notes')} />
        </Field>
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

interface Statement {
  customer: CustomerRow;
  openingPaise: number;
  entries: { id: number; vdate: string; vtype: string; narration: string; dr_paise: number; cr_paise: number; running_paise: number }[];
  invoices: { id: number; number: string; invoice_date: string; payment_mode: string; total_paise: number; status: string }[];
  receipts: { id: number; number: string; receipt_date: string; mode: string; amount_paise: number; reference: string | null; status: string; user_name: string }[];
}

function CustomerDetail({ id, onClose, onEdit }: { id: number | null; onClose: () => void; onEdit: (c: CustomerRow) => void }) {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => get<Statement>(`/api/customers/${id}`), enabled: id != null });
  const [tab, setTab] = useState<'statement' | 'bills' | 'payments'>('statement');
  const [payOpen, setPayOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const d = q.data;
  const c = d?.customer;
  return (
    <>
      <Modal
        open={id != null && !payOpen && invoiceId == null}
        onClose={onClose}
        title={c?.name ?? 'Customer'}
        width={900}
        footer={
          c && (
            <>
              {can('customers.manage') && (
                <Button className="mr-auto" onClick={() => (onClose(), onEdit(c))}>
                  Edit details
                </Button>
              )}
              <Button onClick={() => window.print()}>Print statement</Button>
              {can('payments.receive') && (
                <Button variant="primary" onClick={() => setPayOpen(true)}>
                  Receive payment
                </Button>
              )}
            </>
          )
        }
      >
        {!d || !c ? (
          <div className="flex items-center gap-2 text-ink-3">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat k="Balance due" v={c.balance_paise < 0 ? `${money(-c.balance_paise)} adv.` : money(c.balance_paise)} tone={c.balance_paise > 0 ? 'warn' : undefined} />
              <Stat k="Credit limit" v={c.credit_limit_paise != null ? money(c.credit_limit_paise) : 'Not set'} />
              <Stat k="Total purchases" v={money(c.total_purchases_paise)} />
              <Stat k="Bills" v={String(c.bill_count)} />
            </div>
            <div className="text-ink-3">{[c.phone, c.address, c.gstin && `GSTIN ${c.gstin}`].filter(Boolean).join(' · ')}</div>
            <div role="tablist" className="flex gap-1 border-b border-line">
              {(
                [
                  ['statement', 'Statement'],
                  ['bills', `Bills (${d.invoices.length})`],
                  ['payments', `Payments (${d.receipts.length})`],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx('-mb-px h-10 px-3 text-sm', tab === k ? 'border-b-[3px] border-brick font-bold' : 'text-ink-3')}>
                  {label}
                </button>
              ))}
            </div>
            {tab === 'statement' && (
              <div className="overflow-hidden rounded-[6px] border border-line">
                <Table
                  minWidth={640}
                  head={
                    <tr>
                      <th>Date</th>
                      <th>Details</th>
                      <th className="text-right">Debit (bill)</th>
                      <th className="text-right">Credit (paid)</th>
                      <th className="text-right">Balance</th>
                    </tr>
                  }
                >
                  <tr>
                    <td />
                    <td className="text-ink-3">Opening balance</td>
                    <td />
                    <td />
                    <td className="num text-right">{money(d.openingPaise)}</td>
                  </tr>
                  {d.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="num whitespace-nowrap">{fmtDate(e.vdate)}</td>
                      <td>{e.narration}</td>
                      <td className="num text-right">{e.dr_paise ? money(e.dr_paise) : ''}</td>
                      <td className="num text-right">{e.cr_paise ? money(e.cr_paise) : ''}</td>
                      <td className="num text-right font-semibold">{money(e.running_paise)}</td>
                    </tr>
                  ))}
                </Table>
                {d.entries.length === 0 && <Empty>No credit bills or payments yet. Cash/UPI/card bills don’t change the balance.</Empty>}
              </div>
            )}
            {tab === 'bills' && (
              <div className="overflow-hidden rounded-[6px] border border-line">
                <Table
                  minWidth={520}
                  head={
                    <tr>
                      <th>Bill</th>
                      <th>Date</th>
                      <th>Payment</th>
                      <th className="text-right">Total</th>
                    </tr>
                  }
                >
                  {d.invoices.map((i) => (
                    <tr key={i.id} className="cursor-pointer hover:bg-paper" onClick={() => setInvoiceId(i.id)}>
                      <td className="num font-semibold">
                        {i.number} {i.status === 'cancelled' && <Badge tone="bad">Cancelled</Badge>}
                      </td>
                      <td className="num">{fmtDate(i.invoice_date)}</td>
                      <td>{MODE_LABEL[i.payment_mode]}</td>
                      <td className="num text-right font-bold">{money(i.total_paise)}</td>
                    </tr>
                  ))}
                </Table>
                {d.invoices.length === 0 && <Empty>No bills yet.</Empty>}
              </div>
            )}
            {tab === 'payments' && (
              <div className="overflow-hidden rounded-[6px] border border-line">
                <Table
                  minWidth={560}
                  head={
                    <tr>
                      <th>Receipt</th>
                      <th>Date</th>
                      <th>Mode</th>
                      <th>Reference</th>
                      <th className="text-right">Amount</th>
                    </tr>
                  }
                >
                  {d.receipts.map((r) => (
                    <tr key={r.id}>
                      <td className="num font-semibold">
                        {r.number} {r.status === 'cancelled' && <Badge tone="bad">Cancelled</Badge>}
                      </td>
                      <td className="num">{fmtDate(r.receipt_date)}</td>
                      <td>{MODE_LABEL[r.mode]}</td>
                      <td className="text-ink-3">
                        {r.reference ?? '—'} · {r.user_name}
                      </td>
                      <td className="num text-right font-bold">{money(r.amount_paise)}</td>
                    </tr>
                  ))}
                </Table>
                {d.receipts.length === 0 && <Empty>No payments received yet.</Empty>}
              </div>
            )}
          </div>
        )}
      </Modal>
      {c && <ReceivePayment open={payOpen} customer={c} onClose={() => setPayOpen(false)} />}
      <InvoiceModal id={invoiceId} onClose={() => setInvoiceId(null)} />
    </>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: 'warn' }) {
  return (
    <div className={cx('rounded-[4px] px-3 py-2', tone === 'warn' ? 'bg-warn-soft text-warn-ink' : 'bg-concrete')}>
      <div className="text-[11px]">{k}</div>
      <div className="num text-base font-extrabold">{v}</div>
    </div>
  );
}

function ReceivePayment({ open, customer, onClose }: { open: boolean; customer: CustomerRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('cash');
  const [reference, setReference] = useState('');
  const [ref] = useState(() => ({ clientRef: uuid() }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setAmount(customer.balance_paise > 0 ? formatPaise(customer.balance_paise).replace(/,/g, '') : '');
      setMode('cash');
      setReference('');
      setError(null);
      ref.clientRef = uuid();
    }
  }, [open, customer, ref]);
  const paise = parseRupees(amount);
  const submit = async () => {
    if (paise == null || paise <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ number: string; balancePaise: number }>('/api/receipts', { clientRef: ref.clientRef, customerId: customer.id, mode, amountPaise: paise, reference: reference || undefined });
      toast({ tone: 'good', text: `Receipt ${r.number}: ${money(paise)} received from ${customer.name}. Balance now ${money(r.balancePaise)}.` });
      await qc.invalidateQueries({ queryKey: ['customer'] });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save payment');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Receive payment"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={paise == null || paise <= 0} onClick={submit}>
            Save payment
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          From <b>{customer.name}</b> · balance due <b className="num">{money(customer.balance_paise)}</b>
        </div>
        <Field label="Amount (₹)">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus className="num h-12 text-xl font-bold" />
        </Field>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            {['cash', 'upi', 'card', 'bank', 'cheque'].map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference (UPI ref, cheque no.)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        {paise != null && paise > customer.balance_paise && customer.balance_paise >= 0 && <Notice tone="warn">This is more than the balance due. The extra is kept as an advance.</Notice>}
        {error && <Notice tone="bad">{error}</Notice>}
        <p className="text-xs text-ink-3">Payments are recorded against the customer’s account (on account). Linking to specific bills comes in Phase 4.</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}


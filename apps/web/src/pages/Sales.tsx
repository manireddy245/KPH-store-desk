import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, formatPercent, formatQty } from '@kph/core';
import { ApiError, get, post, qs } from '../lib/api';
import { MODE_LABEL, csvCell, daysAgoIst, downloadText, fmtDate, fmtDateTime, todayIst } from '../lib/format';
import { useOverride } from '../lib/override';
import { useSession } from '../lib/session';
import type { InvoiceFull, InvoiceListRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, useDebounced, useToast } from '../components/ui';

export function Sales() {
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(daysAgoIst(6));
  const [to, setTo] = useState(todayIst());
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState('');
  const s = useDebounced(search);
  const list = useQuery({
    queryKey: ['invoices', from, to, s, status, mode],
    queryFn: () => get<InvoiceListRow[]>(`/api/invoices${qs({ from, to, search: s, status, paymentMode: mode })}`),
  });
  const openId = params.get('open') ? Number(params.get('open')) : null;
  const rows = list.data ?? [];
  const posted = rows.filter((r) => r.status === 'posted');
  const total = posted.reduce((a, r) => a + r.total_paise, 0);

  const exportCsv = () => {
    const head = ['Number', 'Date', 'Customer', 'Phone', 'Payment', 'Items', 'Discount', 'Total', 'Status', 'Billed by', 'Counter'];
    const lines = rows.map((r) => [r.number, r.invoice_date, r.customer_name ?? 'Walk-in', r.customer_phone ?? '', MODE_LABEL[r.payment_mode], r.item_count, formatPaise(r.discount_paise), formatPaise(r.total_paise), r.status, r.user_name, r.device_name ?? ''].map(csvCell).join(','));
    downloadText(`sales-${from}-to-${to}.csv`, [head.join(','), ...lines].join('\n'));
  };

  return (
    <Page>
      <PageTitle telugu="అమ్మకాలు" title="Sales" sub={<span className="num">{posted.length} bills · ₹{formatPaise(total)} in this view</span>} actions={<Button onClick={exportCsv} disabled={!rows.length}>Export to Excel (CSV)</Button>} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Search" className="min-w-[220px] flex-1">
          <Input placeholder="Bill number, customer name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <Field label="Payment">
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">All</option>
            {Object.entries(MODE_LABEL).slice(0, 4).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="posted">Saved</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </Field>
      </div>
      <div className="overflow-hidden rounded-[6px] border border-line bg-white">
        <Table
          head={
            <tr>
              <th>Bill</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Payment</th>
              <th className="text-right">Items</th>
              <th className="text-right">Total</th>
              <th>Billed by</th>
            </tr>
          }
        >
          {rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-paper" onClick={() => setParams({ open: String(r.id) })}>
              <td className="num font-semibold">
                <button type="button" className="underline-offset-2 hover:underline">
                  {r.number}
                </button>
                {r.status === 'cancelled' && (
                  <span className="ml-2">
                    <Badge tone="bad">Cancelled</Badge>
                  </span>
                )}
              </td>
              <td className="num text-ink-3">{fmtDateTime(r.at)}</td>
              <td>
                {r.customer_name ?? <span className="text-ink-3">Walk-in</span>}
                {r.customer_phone && <span className="text-xs text-ink-3"> · {r.customer_phone}</span>}
              </td>
              <td>{MODE_LABEL[r.payment_mode]}</td>
              <td className="num text-right">{r.item_count}</td>
              <td className="num text-right font-bold">{r.status === 'cancelled' ? <s className="text-ink-3">₹{formatPaise(r.total_paise)}</s> : `₹${formatPaise(r.total_paise)}`}</td>
              <td className="text-ink-3">
                {r.user_name} · {r.device_name ?? '—'}
              </td>
            </tr>
          ))}
        </Table>
        {list.isLoading && (
          <div className="flex items-center gap-2 p-6 text-ink-3">
            <Spinner /> Loading…
          </div>
        )}
        {!list.isLoading && rows.length === 0 && <Empty>No bills in this period.</Empty>}
      </div>
      <InvoiceModal id={openId} onClose={() => setParams({})} />
    </Page>
  );
}

export function InvoiceModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const askOverride = useOverride();
  const inv = useQuery({ queryKey: ['invoice', id], queryFn: () => get<InvoiceFull>(`/api/invoices/${id}`), enabled: id != null });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = inv.data;

  const doCancel = async () => {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      let overrideToken: string | undefined;
      if (!can('billing.cancel')) {
        const o = await askOverride({
          permission: 'billing.cancel',
          context: { invoiceId: d.id },
          title: `Cancel bill ${d.number}`,
          details: (
            <span className="num">
              ₹{formatPaise(d.total_paise)} · reason: “{reason}”
            </span>
          ),
        });
        if (!o) return;
        overrideToken = o.token;
      }
      await post(`/api/invoices/${d.id}/cancel`, { reason, overrideToken });
      toast({ tone: 'good', text: `Bill ${d.number} cancelled. Stock and accounts have been reversed.` });
      setCancelOpen(false);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['invoice', id] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={id != null && !cancelOpen}
        onClose={onClose}
        title={d ? `Bill ${d.number}` : 'Bill'}
        width={860}
        footer={
          d && (
            <>
              {d.status === 'posted' && (can('billing.cancel') || can('billing.create')) && (
                <Button variant="danger" onClick={() => setCancelOpen(true)}>
                  Cancel bill…
                </Button>
              )}
              <Button variant="dark" onClick={() => window.open(`/print/invoice/${d.id}?auto=1`, '_blank')}>
                Print / save as PDF
              </Button>
            </>
          )
        }
      >
        {!d ? (
          <div className="flex items-center gap-2 text-ink-3">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            {d.status === 'cancelled' && (
              <Notice tone="bad">
                <b>Cancelled</b> {fmtDateTime(d.cancelled_at)} by {d.cancelled_by_name}
                {d.cancel_approved_by_name ? ` (approved by ${d.cancel_approved_by_name})` : ''}. Reason: “{d.cancel_reason}”
              </Notice>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <Info k="Customer" v={d.customer_name ?? 'Walk-in'} sub={[d.customer_phone, d.customer_gstin].filter(Boolean).join(' · ')} />
              <Info k="Date" v={fmtDateTime(d.at)} sub={`Invoice date ${fmtDate(d.invoice_date)}`} />
              <Info k="Payment · billed by" v={MODE_LABEL[d.payment_mode]!} sub={`${d.user_name} · ${d.device_name ?? '—'}`} />
            </div>
            <Table
              minWidth={640}
              head={
                <tr>
                  <th>#</th>
                  <th>Item</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Disc</th>
                  <th className="text-right">Taxable</th>
                  <th className="text-right">GST</th>
                  <th className="text-right">Amount</th>
                </tr>
              }
            >
              {d.lines.map((l) => (
                <tr key={l.line_no}>
                  <td className="num text-ink-3">{l.line_no}</td>
                  <td>
                    <div className="font-semibold">{l.product_name}</div>
                    <div className="text-xs text-ink-3">
                      {l.sku} · HSN {l.hsn ?? '—'}
                      {l.cost_price_paise != null && l.cost_price_paise > 0 && (
                        <span className="num"> · margin ₹{formatPaise(l.taxable_paise - Math.round((l.cost_price_paise * l.qty_milli) / 1000))}</span>
                      )}
                    </div>
                  </td>
                  <td className="num text-right">
                    {formatQty(l.qty_milli)} {l.unit_code}
                  </td>
                  <td className="num text-right">{formatPaise(l.rate_paise)}</td>
                  <td className="num text-right">{l.discount_bp ? `${formatPercent(l.discount_bp)}%` : '—'}</td>
                  <td className="num text-right">{formatPaise(l.taxable_paise)}</td>
                  <td className="num text-right text-ink-3">{formatPaise(l.cgst_paise + l.sgst_paise + l.igst_paise)}</td>
                  <td className="num text-right font-bold">{formatPaise(l.total_paise)}</td>
                </tr>
              ))}
            </Table>
            <div className="num ml-auto grid w-full max-w-[300px] grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <span className="text-ink-3">Taxable value</span>
              <span className="text-right">₹{formatPaise(d.taxable_paise)}</span>
              <span className="text-ink-3">CGST</span>
              <span className="text-right">₹{formatPaise(d.cgst_paise)}</span>
              <span className="text-ink-3">SGST</span>
              <span className="text-right">₹{formatPaise(d.sgst_paise)}</span>
              <span className="text-ink-3">Round off</span>
              <span className="text-right">{formatPaise(d.round_off_paise)}</span>
              <span className="headline border-t border-ink pt-1.5 text-base">Total</span>
              <span className="border-t border-ink pt-1.5 text-right text-lg font-extrabold">₹{formatPaise(d.total_paise)}</span>
            </div>
            {d.notes && <div className="text-ink-3">Note: {d.notes}</div>}
          </div>
        )}
      </Modal>
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={`Cancel bill ${d?.number ?? ''}`}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)}>Keep the bill</Button>
            <Button variant="dark" busy={busy} disabled={reason.trim().length < 3} onClick={doCancel}>
              {can('billing.cancel') ? 'Cancel this bill' : 'Ask admin PIN & cancel'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>
            The bill stays in the records marked <b>CANCELLED</b> and its number is not reused. Stock comes back and any credit is removed from the customer’s balance.
          </p>
          <Field label="Reason (required)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer returned all items" autoFocus />
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
      </Modal>
    </>
  );
}

function Info({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-[4px] bg-concrete px-3 py-2">
      <div className="eyebrow">{k}</div>
      <div className="font-semibold">{v}</div>
      {sub && <div className="text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

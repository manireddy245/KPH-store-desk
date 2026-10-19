import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, formatPercent, formatQty } from '@kph/core';
import { ApiError, get, post, qs, store } from '../lib/api';
import { daysAgoIst, fmtDate, fmtDateTime, todayIst } from '../lib/format';
import { useOverride } from '../lib/override';
import { useSession } from '../lib/session';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Modal, Notice, PageTitle, Spinner, Table, useDebounced, useToast } from '../components/ui';

interface PurchaseRow {
  id: number;
  number: string;
  supplier_invoice_no: string;
  supplier_invoice_date: string;
  at: string;
  total_paise: number;
  status: 'posted' | 'cancelled';
  source: 'manual' | 'scan';
  supplier_name: string;
  user_name: string;
  device_name: string | null;
  item_count: number;
}

export function Purchases() {
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(daysAgoIst(30));
  const [to, setTo] = useState(todayIst());
  const [search, setSearch] = useState('');
  const s = useDebounced(search);
  const list = useQuery({ queryKey: ['purchases', from, to, s], queryFn: () => get<PurchaseRow[]>(`/api/purchases${qs({ from, to, search: s })}`) });
  const rows = list.data ?? [];
  const total = rows.filter((r) => r.status === 'posted').reduce((a, r) => a + r.total_paise, 0);
  const openId = params.get('open') ? Number(params.get('open')) : null;

  return (
    <Page>
      <PageTitle
        telugu="కొనుగోళ్లు"
        title="Purchases"
        sub={<span className="num">{rows.length} supplier bills · ₹{formatPaise(total)} in this view</span>}
        actions={
          <>
            <Link to="/purchases/new?manual=1" className="inline-flex h-10 items-center rounded-[6px] border border-line-2 bg-white px-4 text-sm font-semibold hover:bg-paper">
              Enter by hand
            </Link>
            <Link to="/purchases/new" className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-brick px-4 text-sm font-bold text-white hover:bg-brick-dark">
              <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
              Scan a supplier bill
            </Link>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Bill date from">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Search" className="min-w-[220px] flex-1">
          <Input placeholder="Supplier, their bill no. or our number" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
      </div>
      <div className="overflow-hidden rounded-[6px] border border-line bg-white">
        <Table
          head={
            <tr>
              <th>Our no.</th>
              <th>Supplier</th>
              <th>Their bill</th>
              <th className="text-right">Items</th>
              <th className="text-right">Total</th>
              <th>Entered by</th>
            </tr>
          }
        >
          {rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-paper" onClick={() => setParams({ open: String(r.id) })}>
              <td className="num font-semibold">
                {r.number} {r.source === 'scan' && <Badge tone="teal">Scanned</Badge>} {r.status === 'cancelled' && <Badge tone="bad">Cancelled</Badge>}
              </td>
              <td>{r.supplier_name}</td>
              <td className="num">
                {r.supplier_invoice_no} <span className="text-ink-3">· {fmtDate(r.supplier_invoice_date)}</span>
              </td>
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
        {!list.isLoading && rows.length === 0 && <Empty>No supplier bills in this period. Scan one to add stock.</Empty>}
      </div>
      <PurchaseModal id={openId} onClose={() => setParams({})} />
    </Page>
  );
}

interface PurchaseFull {
  id: number;
  number: string;
  supplier_name: string;
  supplier_gstin: string | null;
  supplier_invoice_no: string;
  supplier_invoice_date: string;
  at: string;
  supply_type: string;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  freight_paise: number;
  round_off_paise: number;
  total_paise: number;
  status: 'posted' | 'cancelled';
  cancel_reason: string | null;
  cancelled_by_name: string | null;
  cancelled_at: string | null;
  source: string;
  scan_id: number | null;
  page_count: number;
  user_name: string;
  device_name: string | null;
  notes: string | null;
  lines: { line_no: number; product_name: string; sku: string; description: string | null; qty_milli: number; unit_code: string; unit_cost_paise: number; taxable_paise: number; gst_rate_bp: number; total_paise: number }[];
}

function PurchaseModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const askOverride = useOverride();
  const q = useQuery({ queryKey: ['purchase', id], queryFn: () => get<PurchaseFull>(`/api/purchases/${id}`), enabled: id != null });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = q.data;

  const openPage = async (n: number) => {
    if (!d?.scan_id) return;
    const res = await fetch(`/api/purchases/scans/${d.scan_id}/pages/${n}`, { headers: { 'x-device-token': store.deviceToken ?? '', authorization: `Bearer ${store.sessionToken}` } });
    if (!res.ok) return toast({ tone: 'bad', text: 'Could not open the scanned page' });
    window.open(URL.createObjectURL(await res.blob()), '_blank');
  };

  const doCancel = async () => {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      let overrideToken: string | undefined;
      if (!can('billing.cancel')) {
        const o = await askOverride({ permission: 'billing.cancel', context: { purchaseId: d.id }, title: `Cancel purchase ${d.number}`, details: <span className="num">₹{formatPaise(d.total_paise)} · “{reason}”</span> });
        if (!o) return;
        overrideToken = o.token;
      }
      await post(`/api/purchases/${d.id}/cancel`, { reason, overrideToken });
      toast({ tone: 'good', text: `${d.number} cancelled. The stock has been taken off again.` });
      setCancelOpen(false);
      await qc.invalidateQueries({ queryKey: ['purchase'] });
      await qc.invalidateQueries({ queryKey: ['purchases'] });
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
        title={d ? `Purchase ${d.number}` : 'Purchase'}
        width={880}
        footer={
          d && (
            <>
              {d.page_count > 0 &&
                Array.from({ length: d.page_count }, (_, i) => (
                  <Button key={i} onClick={() => void openPage(i + 1)} className={i === 0 ? 'mr-auto' : ''}>
                    View scanned page {i + 1}
                  </Button>
                ))}
              {d.status === 'posted' && (
                <Button variant="danger" onClick={() => setCancelOpen(true)}>
                  Cancel purchase…
                </Button>
              )}
            </>
          )
        }
      >
        {!d ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            {d.status === 'cancelled' && (
              <Notice tone="bad">
                Cancelled {fmtDateTime(d.cancelled_at)} by {d.cancelled_by_name}: “{d.cancel_reason}”
              </Notice>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <Info k="Supplier" v={d.supplier_name} sub={d.supplier_gstin ?? undefined} />
              <Info k="Their bill" v={d.supplier_invoice_no} sub={fmtDate(d.supplier_invoice_date)} />
              <Info k="Entered" v={fmtDateTime(d.at)} sub={`${d.user_name} · ${d.device_name ?? '—'} · ${d.source === 'scan' ? 'scanned' : 'typed'}`} />
            </div>
            <Table
              minWidth={640}
              head={
                <tr>
                  <th>#</th>
                  <th>Product</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Cost / unit</th>
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
                    {l.description && <div className="text-xs text-ink-3">On bill: {l.description}</div>}
                  </td>
                  <td className="num text-right">
                    {formatQty(l.qty_milli)} {l.unit_code}
                  </td>
                  <td className="num text-right">{formatPaise(l.unit_cost_paise)}</td>
                  <td className="num text-right">{formatPaise(l.taxable_paise)}</td>
                  <td className="num text-right">{formatPercent(l.gst_rate_bp)}%</td>
                  <td className="num text-right font-bold">{formatPaise(l.total_paise)}</td>
                </tr>
              ))}
            </Table>
            <div className="num ml-auto grid w-full max-w-[300px] grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <span className="text-ink-3">Taxable value</span>
              <span className="text-right">₹{formatPaise(d.taxable_paise)}</span>
              {d.igst_paise > 0 ? (
                <>
                  <span className="text-ink-3">IGST</span>
                  <span className="text-right">₹{formatPaise(d.igst_paise)}</span>
                </>
              ) : (
                <>
                  <span className="text-ink-3">CGST</span>
                  <span className="text-right">₹{formatPaise(d.cgst_paise)}</span>
                  <span className="text-ink-3">SGST</span>
                  <span className="text-right">₹{formatPaise(d.sgst_paise)}</span>
                </>
              )}
              {d.freight_paise > 0 && (
                <>
                  <span className="text-ink-3">Freight / loading</span>
                  <span className="text-right">₹{formatPaise(d.freight_paise)}</span>
                </>
              )}
              <span className="text-ink-3">Round off</span>
              <span className="text-right">{formatPaise(d.round_off_paise)}</span>
              <span className="headline border-t border-ink pt-1.5 text-base">Total</span>
              <span className="border-t border-ink pt-1.5 text-right text-lg font-extrabold">₹{formatPaise(d.total_paise)}</span>
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={`Cancel ${d?.number ?? ''}`}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)}>Keep it</Button>
            <Button variant="dark" busy={busy} disabled={reason.trim().length < 3} onClick={doCancel}>
              {can('billing.cancel') ? 'Cancel purchase' : 'Ask admin PIN & cancel'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>Use this only if the bill was entered by mistake. The items are taken off stock again and the supplier’s balance is reduced. Goods sent back to the supplier will be handled as purchase returns in Phase 2.</p>
          <Field label="Reason (required)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
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

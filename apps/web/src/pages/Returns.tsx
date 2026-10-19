import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatPaise, formatQty, mulDivRound, parseQty } from '@kph/core';
import { ApiError, post } from '../lib/api';
import { MODE_LABEL, uuid } from '../lib/format';
import { useOverride } from '../lib/override';
import { useSession } from '../lib/session';
import type { InvoiceFull } from '../lib/types';
import { Button, Checkbox, Field, Input, Modal, Notice, Select, Table, cx, useToast } from '../components/ui';

/** Sales return → credit note. Pick lines and quantities from the original bill. */
export function SalesReturnModal({ invoice, open, onClose }: { invoice: InvoiceFull | null; open: boolean; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const askOverride = useOverride();
  const [qty, setQty] = useState<Record<number, string>>({});
  const [restock, setRestock] = useState<Record<number, boolean>>({});
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<string>('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientRef, setClientRef] = useState(uuid());

  useEffect(() => {
    if (!open || !invoice) return;
    setQty({});
    setRestock(Object.fromEntries(invoice.lines.map((l) => [l.id, true])));
    setReason('');
    setRefund(invoice.customer_id ? 'account' : 'cash');
    setError(null);
    setClientRef(uuid());
  }, [open, invoice]);

  const rows = useMemo(
    () =>
      (invoice?.lines ?? []).map((l) => {
        const left = l.qty_milli - (l.returned_qty_milli ?? 0);
        const q = qty[l.id]?.trim() ? parseQty(qty[l.id]!) : 0;
        const valid = q != null && q >= 0 && q <= left;
        // estimate (the server works out the exact figure; the last part of a line takes exactly what is left)
        const est = q && valid ? (q === left ? l.amount_paise - mulDivRound(l.amount_paise, l.returned_qty_milli ?? 0, l.qty_milli) : mulDivRound(l.amount_paise, q, l.qty_milli)) : 0;
        return { l, left, q, valid, est };
      }),
    [invoice, qty],
  );
  const chosen = rows.filter((r) => r.q && r.valid);
  const estimate = chosen.reduce((s, r) => s + r.est, 0);
  const bad = rows.some((r) => !r.valid);

  const submit = async () => {
    if (!invoice) return;
    setBusy(true);
    setError(null);
    try {
      let overrideToken: string | undefined;
      if (!can('returns.create')) {
        const o = await askOverride({
          permission: 'returns.create',
          context: { invoiceId: invoice.id },
          title: `Sales return on ${invoice.number}`,
          details: (
            <span className="num">
              About ₹{formatPaise(estimate)} · {refund === 'account' ? 'credit to account' : `refund by ${MODE_LABEL[refund]}`} · “{reason}”
            </span>
          ),
        });
        if (!o) return;
        overrideToken = o.token;
      }
      const r = await post<{ id: number; number: string; totalPaise: number }>(`/api/invoices/${invoice.id}/returns`, {
        clientRef,
        reason,
        refundMode: refund,
        overrideToken,
        lines: chosen.map((x) => ({ invoiceLineId: x.l.id, qtyMilli: x.q!, restock: restock[x.l.id] ?? true })),
      });
      toast({
        tone: 'good',
        text: (
          <>
            Credit note <b className="num">{r.number}</b>: ₹{formatPaise(r.totalPaise)} {refund === 'account' ? 'credited to the customer’s account' : `to refund by ${MODE_LABEL[refund]}`}.
          </>
        ),
        action: { label: 'Print', onClick: () => window.open(`/print/credit-note/${r.id}?auto=1`, '_blank') },
      });
      await qc.invalidateQueries({ queryKey: ['invoice'] });
      await qc.invalidateQueries({ queryKey: ['invoices'] });
      await qc.invalidateQueries({ queryKey: ['credit-notes'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the return');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open && !!invoice}
      onClose={onClose}
      title={`Return items — ${invoice?.number ?? ''}`}
      width={860}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" busy={busy} disabled={!chosen.length || bad || reason.trim().length < 3} onClick={submit}>
            {can('returns.create') ? 'Save return' : 'Ask admin PIN & save'}
          </Button>
        </>
      }
    >
      {invoice && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-ink-3">Type how many of each item came back. Untick “back to stock” for damaged goods — they are written off with a note. The original bill stays as it is; a credit note is issued.</p>
          <div className="overflow-hidden rounded-[6px] border border-line">
            <Table
              minWidth={640}
              head={
                <tr>
                  <th>Item</th>
                  <th className="text-right">Sold</th>
                  <th className="text-right">Can return</th>
                  <th className="text-right">Returning</th>
                  <th>Back to stock</th>
                  <th className="text-right">≈ Amount</th>
                </tr>
              }
            >
              {rows.map((r) => (
                <tr key={r.l.id} className={cx(r.left === 0 && 'opacity-50')}>
                  <td className="font-semibold">{r.l.product_name}</td>
                  <td className="num text-right">
                    {formatQty(r.l.qty_milli)} {r.l.unit_code}
                  </td>
                  <td className="num text-right">{formatQty(r.left)}</td>
                  <td className="text-right">
                    <input
                      aria-label={`Quantity of ${r.l.product_name} returned`}
                      inputMode="decimal"
                      disabled={r.left === 0}
                      value={qty[r.l.id] ?? ''}
                      placeholder="0"
                      onChange={(e) => setQty({ ...qty, [r.l.id]: e.target.value })}
                      className={cx('num h-9 w-24 rounded-[6px] border px-2 text-right', r.valid ? 'border-line-2' : 'border-bad')}
                    />
                  </td>
                  <td>
                    <Checkbox label="" checked={restock[r.l.id] ?? true} onChange={(v) => setRestock({ ...restock, [r.l.id]: v })} disabled={r.left === 0} />
                  </td>
                  <td className="num text-right">{r.est ? formatPaise(r.est) : '—'}</td>
                </tr>
              ))}
            </Table>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Reason (required)">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. extra bags not used at site" />
            </Field>
            <Field label="Money back">
              <Select value={refund} onChange={(e) => setRefund(e.target.value)}>
                {invoice.customer_id && <option value="account">Credit to {invoice.customer_name}’s account</option>}
                <option value="cash">Cash refund</option>
                <option value="upi">UPI refund</option>
                <option value="bank">Bank transfer</option>
                <option value="card">Card reversal</option>
              </Select>
            </Field>
          </div>
          <div className="num text-right text-base">
            Credit note about <b>₹{formatPaise(estimate)}</b> <span className="text-xs text-ink-3">(exact amount shown after saving)</span>
          </div>
          {bad && <Notice tone="bad">A quantity is more than can still be returned, or not a number.</Notice>}
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
      )}
    </Modal>
  );
}

/** Purchase return → debit note. Quantities are in the base unit (what is in stock). */
export function PurchaseReturnModal({
  purchase,
  open,
  onClose,
}: {
  purchase: { id: number; number: string; supplier_name: string; lines: { id?: number; line_no: number; product_name: string; qty_milli: number; unit_code: string; total_paise: number; returned_milli?: number }[] } | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setQty({});
      setReason('');
      setError(null);
    }
  }, [open]);
  const rows = (purchase?.lines ?? []).map((l) => {
    const left = l.qty_milli - (l.returned_milli ?? 0);
    const q = qty[l.line_no]?.trim() ? parseQty(qty[l.line_no]!) : 0;
    return { l, left, q, valid: q != null && q >= 0 && q <= left };
  });
  const chosen = rows.filter((r) => r.q && r.valid);
  const submit = async () => {
    if (!purchase) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ number: string; totalPaise: number }>(`/api/purchases/${purchase.id}/returns`, { reason, lines: chosen.map((x) => ({ purchaseLineId: x.l.id, baseQtyMilli: x.q! })) });
      toast({ tone: 'good', text: `Debit note ${r.number}: ₹${formatPaise(r.totalPaise)} less owed to ${purchase.supplier_name}. Stock reduced.` });
      await qc.invalidateQueries({ queryKey: ['purchase'] });
      await qc.invalidateQueries({ queryKey: ['debit-notes'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the return');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open && !!purchase}
      onClose={onClose}
      title={`Return to supplier — ${purchase?.number ?? ''}`}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" busy={busy} disabled={!chosen.length || rows.some((r) => !r.valid) || reason.trim().length < 3} onClick={submit}>
            Save return
          </Button>
        </>
      }
    >
      {purchase && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-ink-3">The goods leave stock and {purchase.supplier_name}’s balance goes down by their value and GST. A debit note is issued.</p>
          <div className="overflow-hidden rounded-[6px] border border-line">
            <Table
              minWidth={520}
              head={
                <tr>
                  <th>Item</th>
                  <th className="text-right">Bought</th>
                  <th className="text-right">Can return</th>
                  <th className="text-right">Returning</th>
                </tr>
              }
            >
              {rows.map((r) => (
                <tr key={r.l.line_no}>
                  <td className="font-semibold">{r.l.product_name}</td>
                  <td className="num text-right">
                    {formatQty(r.l.qty_milli)} {r.l.unit_code}
                  </td>
                  <td className="num text-right">{formatQty(r.left)}</td>
                  <td className="text-right">
                    <input
                      aria-label={`Quantity of ${r.l.product_name} going back`}
                      inputMode="decimal"
                      value={qty[r.l.line_no] ?? ''}
                      placeholder="0"
                      onChange={(e) => setQty({ ...qty, [r.l.line_no]: e.target.value })}
                      className={cx('num h-9 w-24 rounded-[6px] border px-2 text-right', r.valid ? 'border-line-2' : 'border-bad')}
                    />
                  </td>
                </tr>
              ))}
            </Table>
          </div>
          <Field label="Reason (required)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 3 tins leaking, wrong shade" />
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
      )}
    </Modal>
  );
}

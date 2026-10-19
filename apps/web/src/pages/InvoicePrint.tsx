import { useEffect, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { amountInWords, formatPaise, formatPercent, formatQty, stateName, taxSummaryByHsn } from '@kph/core';
import { get } from '../lib/api';
import { MODE_LABEL, fmtDate, fmtDateTime } from '../lib/format';
import type { InvoiceFull } from '../lib/types';
import { Button, LogoMark, Spinner, cx } from '../components/ui';

/**
 * A4 tax invoice and credit note. Provisional layout until the shop sends its
 * preferred format. The max-discount hint is never shown here.
 * ?copies=3 prints Original / Duplicate / Triplicate; ?auto=1 opens the print dialog.
 */

type Labels = 'en' | 'te-en';
const T: Record<string, string> = {
  'TAX INVOICE': 'పన్ను బిల్లు',
  'CREDIT NOTE': 'క్రెడిట్ నోట్',
  'Bill to': 'కొనుగోలుదారు',
  'Invoice no.': 'బిల్లు నెం.',
  'Credit note no.': 'క్రెడిట్ నోట్ నెం.',
  Date: 'తేదీ',
  'Place of supply': 'సరఫరా స్థలం',
  Item: 'వస్తువు',
  Qty: 'పరిమాణం',
  Rate: 'ధర',
  Amount: 'మొత్తం',
  Total: 'మొత్తం',
  'Amount in words': 'అక్షరాలలో',
  'Authorised signatory': 'అధీకృత సంతకం',
  Terms: 'నిబంధనలు',
};
const COPIES = ['Original for recipient', 'Duplicate for transporter', 'Triplicate for supplier'];

interface CreditNoteFull {
  id: number;
  number: string;
  note_date: string;
  at: string;
  invoice_number: string;
  invoice_date: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_gstin: string | null;
  customer_address: string | null;
  place_of_supply: string;
  supply_type: 'intra' | 'inter';
  reason: string;
  refund_mode: string;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  round_off_paise: number;
  total_paise: number;
  status: string;
  user_name: string;
  device_name: string | null;
  lines: { line_no: number; product_name: string; hsn: string | null; unit_code: string; qty_milli: number; rate_paise: number; taxable_paise: number; gst_rate_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; restocked: boolean }[];
  store: InvoiceFull['store'];
}

interface Doc {
  kind: 'invoice' | 'credit_note';
  title: string;
  number: string;
  at: string;
  cancelled: boolean;
  customer: { name: string | null; address: string | null; phone: string | null; gstin: string | null };
  pos: string;
  supply: 'intra' | 'inter';
  extra: [string, string][];
  lines: { no: number; name: string; hsn: string | null; qty: string; rate: string; disc: string; taxable: number; gst: number; amount: number; cgst: number; sgst: number; igst: number; qtyMilli: number; note?: string }[];
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
  discount: number;
  footer: string;
  store: InvoiceFull['store'];
}

function fromInvoice(d: InvoiceFull): Doc {
  return {
    kind: 'invoice',
    title: 'TAX INVOICE',
    number: d.number,
    at: d.at,
    cancelled: d.status === 'cancelled',
    customer: { name: d.customer_name, address: d.customer_address, phone: d.customer_phone, gstin: d.customer_gstin },
    pos: d.place_of_supply,
    supply: d.supply_type ?? 'intra',
    extra: [
      ['Payment', MODE_LABEL[d.payment_mode] ?? d.payment_mode],
      ['Reverse charge', 'No'],
      ...(d.transport?.ewb_no ? ([['E-way bill', `${d.transport.ewb_no}${d.transport.ewb_date ? ` · ${fmtDate(d.transport.ewb_date)}` : ''}`]] as [string, string][]) : []),
      ...(d.transport?.vehicle_no ? ([['Vehicle', d.transport.vehicle_no]] as [string, string][]) : []),
    ],
    lines: d.lines.map((l) => ({
      no: l.line_no,
      name: l.product_name,
      hsn: l.hsn,
      qty: `${formatQty(l.qty_milli)} ${l.unit_code}`,
      rate: `${formatPaise(l.rate_paise)}${l.rate_mode === 'incl' ? '*' : ''}`,
      disc: l.discount_bp ? `${formatPercent(l.discount_bp)}%` : '—',
      taxable: l.taxable_paise,
      gst: l.gst_rate_bp,
      amount: l.amount_paise ?? l.total_paise,
      cgst: l.cgst_paise,
      sgst: l.sgst_paise,
      igst: l.igst_paise,
      qtyMilli: l.qty_milli,
    })),
    taxable: d.taxable_paise,
    cgst: d.cgst_paise,
    sgst: d.sgst_paise,
    igst: d.igst_paise,
    roundOff: d.round_off_paise,
    total: d.total_paise,
    discount: d.discount_paise,
    footer: `Billed by ${d.user_name} · ${d.device_name ?? '—'}`,
    store: d.store,
  };
}

function fromCreditNote(d: CreditNoteFull): Doc {
  return {
    kind: 'credit_note',
    title: 'CREDIT NOTE',
    number: d.number,
    at: d.at,
    cancelled: d.status === 'cancelled',
    customer: { name: d.customer_name, address: d.customer_address, phone: d.customer_phone, gstin: d.customer_gstin },
    pos: d.place_of_supply,
    supply: d.supply_type,
    extra: [
      ['Against invoice', `${d.invoice_number} of ${fmtDate(d.invoice_date)}`],
      ['Reason', d.reason],
      ['Refund', d.refund_mode === 'account' ? 'Credited to account' : (MODE_LABEL[d.refund_mode] ?? d.refund_mode)],
    ],
    lines: d.lines.map((l) => ({
      no: l.line_no,
      name: l.product_name,
      hsn: l.hsn,
      qty: `${formatQty(l.qty_milli)} ${l.unit_code}`,
      rate: formatPaise(l.rate_paise),
      disc: '',
      taxable: l.taxable_paise,
      gst: l.gst_rate_bp,
      amount: l.total_paise,
      cgst: l.cgst_paise,
      sgst: l.sgst_paise,
      igst: l.igst_paise,
      qtyMilli: l.qty_milli,
      note: l.restocked ? undefined : 'damaged',
    })),
    taxable: d.taxable_paise,
    cgst: d.cgst_paise,
    sgst: d.sgst_paise,
    igst: d.igst_paise,
    roundOff: d.round_off_paise,
    total: d.total_paise,
    discount: 0,
    footer: `Issued by ${d.user_name} · ${d.device_name ?? '—'}`,
    store: d.store,
  };
}

export function InvoicePrint() {
  return <DocPrint kind="invoice" />;
}
export function CreditNotePrint() {
  return <DocPrint kind="credit_note" />;
}

function DocPrint({ kind }: { kind: 'invoice' | 'credit_note' }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const q = useQuery({
    queryKey: [kind === 'invoice' ? 'invoice' : 'credit-note', Number(id)],
    queryFn: async () => (kind === 'invoice' ? fromInvoice(await get<InvoiceFull>(`/api/invoices/${id}`)) : fromCreditNote(await get<CreditNoteFull>(`/api/credit-notes/${id}`))),
  });
  const d = q.data;
  const copies = Math.min(3, Math.max(1, Number(params.get('copies') ?? 1)));

  useEffect(() => {
    if (d && params.get('auto')) {
      document.title = d.number.replace(/\//g, '-');
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [d, params]);

  if (!d)
    return (
      <div className="flex items-center gap-2 p-10 text-ink-3">
        <Spinner /> Loading…
      </div>
    );

  return (
    <div className="min-h-screen bg-concrete print:bg-white">
      <style>{`@page { size: A4; margin: 12mm; } @media print { .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; min-height: auto !important; padding: 0 !important; break-after: page; } .sheet:last-child { break-after: auto; } }`}</style>
      <div className="no-print mx-auto flex max-w-[794px] flex-wrap items-center justify-between gap-2 px-2 py-3">
        <span className="text-sm text-ink-3">Use “Save as PDF” in the print window to make a PDF.</span>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3].map((n) => (
            <a key={n} href={`?copies=${n}`} className={cx('inline-flex h-10 items-center rounded-[6px] border px-3 text-sm font-semibold', n === copies ? 'border-teal bg-teal text-white' : 'border-line-2 bg-white')}>
              {n} {n === 1 ? 'copy' : 'copies'}
            </a>
          ))}
          <Button onClick={() => window.close()}>Close</Button>
          <Button variant="dark" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      {Array.from({ length: copies }, (_, i) => (
        <Sheet key={i} d={d} copyLabel={COPIES[i]!} />
      ))}
    </div>
  );
}

function Sheet({ d, copyLabel }: { d: Doc; copyLabel: string }) {
  const labels: Labels = d.store.labels ?? 'en';
  const L = (en: string): ReactNode =>
    labels === 'te-en' && T[en] ? (
      <>
        {en} <span className="telugu font-normal text-ink-3">/ {T[en]}</span>
      </>
    ) : (
      en
    );
  const hsn = taxSummaryByHsn(d.lines.map((l) => ({ hsn: l.hsn, gstRateBp: l.gst, qtyMilli: l.qtyMilli, taxablePaise: l.taxable, cgstPaise: l.cgst, sgstPaise: l.sgst, igstPaise: l.igst })));
  const nameParts = d.store.name.match(/^(\S+)\s+(.*)$/);
  const inter = d.supply === 'inter';
  const hasIncl = d.lines.some((l) => l.rate.endsWith('*'));

  return (
    <div className="sheet relative mx-auto mb-8 flex min-h-[1123px] w-[794px] flex-col gap-3.5 bg-white px-11 py-10 text-[10pt] shadow-lg">
      {d.cancelled && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="rotate-[-24deg] rounded border-4 border-bad px-6 py-2 text-6xl font-extrabold tracking-widest text-bad/40">CANCELLED</span>
        </div>
      )}
      <div className="flex items-start justify-between gap-5 border-b-[3px] border-brick pb-3.5">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <LogoMark size={62} title={d.store.name} />
            <span className="flex flex-col leading-[1.02]">
              <span className="text-[26pt] font-extrabold tracking-[.02em]" style={{ fontStretch: '75%' }}>
                {(nameParts?.[1] ?? d.store.name).toUpperCase()}
              </span>
              <span className="text-[7.5pt] font-semibold tracking-[.3em] text-ink-2">{(nameParts?.[2] ?? '').toUpperCase().replace(' AND ', ' & ')}</span>
            </span>
          </div>
          <div className="text-[9pt] leading-[1.45] text-ink-2">
            {d.store.address}
            <br />
            {d.store.phone && <>Phone {d.store.phone} · </>}GSTIN <b className="text-ink">{d.store.gstin || '—'}</b> · State: {d.store.stateName} ({d.store.stateCode})
          </div>
        </div>
        <div className="text-right">
          <div className="text-[20pt] font-extrabold tracking-[.04em]" style={{ fontStretch: '75%' }}>
            {d.title}
          </div>
          {labels === 'te-en' && T[d.title] && <div className="telugu text-[10pt] font-semibold text-brick">{T[d.title]}</div>}
          <div className="text-[8.5pt] text-ink-3">{copyLabel}</div>
          {d.customer.gstin && <div className="mt-1 inline-block rounded-[3px] bg-ink px-1.5 text-[8pt] font-bold text-white">B2B</div>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[8pt] font-bold uppercase tracking-[.14em] text-ink-3">{L('Bill to')}</div>
          <div className="text-[11pt] font-bold">{d.customer.name ?? 'Walk-in customer'}</div>
          {d.customer.address && <div>{d.customer.address}</div>}
          {d.customer.phone && <div>Phone {d.customer.phone}</div>}
          {d.customer.gstin && (
            <div>
              GSTIN <b>{d.customer.gstin}</b> · State {stateName(d.customer.gstin.slice(0, 2))} ({d.customer.gstin.slice(0, 2)})
            </div>
          )}
        </div>
        <div className="num grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-0.5">
          <span className="text-ink-3">{L(d.kind === 'invoice' ? 'Invoice no.' : 'Credit note no.')}</span>
          <b>{d.number}</b>
          <span className="text-ink-3">{L('Date')}</span>
          <span>{fmtDateTime(d.at)}</span>
          <span className="text-ink-3">{L('Place of supply')}</span>
          <span>
            {stateName(d.pos)} ({d.pos})
          </span>
          {d.extra.map(([k, v]) => (
            <span key={k} className="contents">
              <span className="text-ink-3">{k}</span>
              <span>{v}</span>
            </span>
          ))}
        </div>
      </div>

      <table className="w-full border-collapse [&_td]:border-b [&_td]:border-line [&_td]:px-1.5 [&_td]:py-1.5 [&_td]:align-top [&_th]:border-y-[1.5px] [&_th]:border-ink [&_th]:px-1.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:align-bottom [&_th]:text-[8pt] [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-[.04em]">
        <thead>
          <tr>
            <th>#</th>
            <th>{L('Item')}</th>
            <th>HSN</th>
            <th className="!text-right">{L('Qty')}</th>
            <th className="!text-right">{L('Rate')}</th>
            {d.kind === 'invoice' && <th className="!text-right">Disc</th>}
            <th className="!text-right">Taxable</th>
            <th className="!text-right">GST</th>
            <th className="!text-right">{L('Amount')}</th>
          </tr>
        </thead>
        <tbody className="num text-[9.5pt]">
          {d.lines.map((l) => (
            <tr key={l.no}>
              <td>{l.no}</td>
              <td>
                {l.name}
                {l.note && <span className="text-ink-3"> ({l.note})</span>}
              </td>
              <td>{l.hsn}</td>
              <td className="text-right">{l.qty}</td>
              <td className="text-right">{l.rate}</td>
              {d.kind === 'invoice' && <td className="text-right">{l.disc}</td>}
              <td className="text-right">{formatPaise(l.taxable)}</td>
              <td className="text-right">{formatPercent(l.gst)}%</td>
              <td className="text-right">{formatPaise(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasIncl && <div className="-mt-2 text-[8pt] text-ink-3">* rate includes GST</div>}

      <div className="flex justify-between gap-6">
        <div className="min-w-0 flex-1">
          <table className="num border-collapse text-[8.5pt] [&_td]:border-b [&_td]:border-line [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-y-[1.5px] [&_th]:border-ink [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_th]:text-[7.5pt] [&_th]:font-bold [&_th]:uppercase">
            <thead>
              <tr>
                <th>HSN</th>
                <th className="!text-right">Taxable</th>
                <th className="!text-right">Rate</th>
                {inter ? (
                  <th className="!text-right">IGST</th>
                ) : (
                  <>
                    <th className="!text-right">CGST</th>
                    <th className="!text-right">SGST</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {hsn.map((s) => (
                <tr key={`${s.hsn}-${s.gstRateBp}`}>
                  <td>{s.hsn}</td>
                  <td className="text-right">{formatPaise(s.taxablePaise)}</td>
                  <td className="text-right">{formatPercent(s.gstRateBp)}%</td>
                  {inter ? (
                    <td className="text-right">{formatPaise(s.igstPaise)}</td>
                  ) : (
                    <>
                      <td className="text-right">{formatPaise(s.cgstPaise)}</td>
                      <td className="text-right">{formatPaise(s.sgstPaise)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3">
            <span className="text-ink-3">{L('Amount in words')}:</span> <b>{amountInWords(d.total)}</b>
          </div>
        </div>
        <div className="num grid w-[250px] grid-cols-[1fr_auto] content-start gap-x-3 gap-y-1">
          {d.discount > 0 && (
            <>
              <span className="text-ink-3">Discount given</span>
              <span className="text-right">{formatPaise(d.discount)}</span>
            </>
          )}
          <span className="text-ink-3">Taxable value</span>
          <span className="text-right">{formatPaise(d.taxable)}</span>
          {inter ? (
            <>
              <span className="text-ink-3">IGST</span>
              <span className="text-right">{formatPaise(d.igst)}</span>
            </>
          ) : (
            <>
              <span className="text-ink-3">CGST</span>
              <span className="text-right">{formatPaise(d.cgst)}</span>
              <span className="text-ink-3">SGST</span>
              <span className="text-right">{formatPaise(d.sgst)}</span>
            </>
          )}
          <span className="text-ink-3">Round off</span>
          <span className="text-right">{formatPaise(d.roundOff)}</span>
          <span className="border-t-[1.5px] border-ink pt-1.5 text-[14pt] font-extrabold" style={{ fontStretch: '75%' }}>
            {d.kind === 'invoice' ? 'TOTAL' : 'CREDIT'}
          </span>
          <span className="border-t-[1.5px] border-ink pt-1.5 text-right text-[14pt] font-extrabold">₹{formatPaise(d.total)}</span>
        </div>
      </div>

      <div className="mt-auto flex items-end justify-between gap-6 border-t border-line pt-3">
        <div className="max-w-[420px] text-[8.5pt] text-ink-2">
          {d.kind === 'invoice' && d.store.terms && (
            <>
              <b className="text-ink">{L('Terms')}:</b> {d.store.terms}
            </>
          )}
          <div className="mt-1.5 text-ink-3">{d.footer} · Computer-generated document</div>
        </div>
        <div className="text-center text-[9pt]">
          <div className="h-10" />
          <div className="border-t border-ink pt-1">
            For {d.store.name}
            <br />
            {L('Authorised signatory')}
          </div>
        </div>
      </div>
    </div>
  );
}

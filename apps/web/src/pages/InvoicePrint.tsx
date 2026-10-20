import { useEffect, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { amountInWords, formatPaise, formatPercent, formatQty, stateName } from '@kph/core';
import { get } from '../lib/api';
import { MODE_LABEL, fmtDate, fmtDateTime } from '../lib/format';
import type { InvoiceFull } from '../lib/types';
import { Button, LogoMark, Spinner, cx } from '../components/ui';

/**
 * A4 tax invoice and credit note, as approved by the owner (Claude Design "KPH Tax Invoice"):
 * GST rate and amount on every line, ship-to, the delivery boxes when filled in, and the
 * "Authorised dealers for" brand row. The max-discount hint is never shown here.
 * ?copies=3 prints Original / Duplicate / Triplicate; ?auto=1 opens the print dialog.
 */

type Labels = 'en' | 'te-en';
const T: Record<string, string> = {
  'TAX INVOICE': 'పన్ను బిల్లు',
  'CREDIT NOTE': 'క్రెడిట్ నోట్',
  'Bill to': 'కొనుగోలుదారు',
  'Ship to': 'సరుకు పంపే చోటు',
  Item: 'వస్తువు',
  Qty: 'పరిమాణం',
  Rate: 'ధర',
  Amount: 'మొత్తం',
  'Amount in words': 'అక్షరాలలో',
  'Authorised signatory': 'అధీకృత సంతకం',
  Terms: 'నిబంధనలు',
};
const COPIES = ['Original for recipient', 'Duplicate for transporter', 'Triplicate for supplier'];

/** Brands the shop deals in, shown at the foot of the bill. Logos come from each company's own website. */
type Brand =
  | { name: string; src: string; h: number; mono?: boolean }
  /** Logo files with white space around the artwork: show only the artwork (box), at the image size and offset given. */
  | { name: string; src: string; crop: { w: number; h: number; imgW: number; imgH: number; x: number; y: number } }
  | { name: string; word: string; sub: string };
const BRANDS: Brand[] = [
  // UltraTech and Birla White (square marks) both 36px tall; Asian Paints (a wide wordmark) as wide as its space allows
  { name: 'UltraTech Cement', src: '/brands/ultratech.jpeg', crop: { w: 37, h: 36, imgW: 52, imgH: 43.7, x: 7.5, y: 3.8 } },
  { name: 'Asian Paints', src: '/brands/asianpaints.png', crop: { w: 126, h: 25, imgW: 126, imgH: 46.7, x: 0, y: 14.5 } },
  { name: 'Birla Opus', src: '/brands/birlaopus.svg', h: 30 },
  { name: 'Birla White', src: '/brands/birlawhite.svg', crop: { w: 39.5, h: 36, imgW: 59.2, imgH: 59.2, x: 11.3, y: 11.3 } },
  { name: 'JSW Steel', src: '/brands/jsw.svg', h: 28 },
  { name: 'Legrand', src: '/brands/legrand.png', h: 20, mono: true },
  { name: 'Ultra Volt', word: 'ULTRA VOLT', sub: 'WIRES & CABLES' },
  { name: 'Birla Pivot', src: '/brands/birlapivot.webp', h: 30 },
  { name: 'Astral Pipes', src: '/brands/astral.png', h: 28, mono: true },
  { name: 'Sudhakar Pipes', word: 'SUDHAKAR', sub: 'PIPES' },
];

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

interface DocLine {
  no: number;
  name: string;
  code: string | null;
  service: boolean;
  qtyMilli: number;
  unit: string;
  rate: string | null;
  disc: string;
  taxable: number;
  gst: number;
  cgst: number;
  sgst: number;
  igst: number;
  amount: number;
  note?: string;
}

interface Doc {
  kind: 'invoice' | 'credit_note';
  title: string;
  number: string;
  at: string;
  cancelled: boolean;
  customer: { name: string | null; address: string | null; phone: string | null; gstin: string | null; pan: string | null };
  shipTo: { name: string | null; address: string | null; contact: string | null; phone: string | null } | null;
  pos: string;
  supply: 'intra' | 'inter';
  facts: [string, string][];
  /** The delivery boxes: only those with something in them. */
  boxes: [string, string][];
  lines: DocLine[];
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

const filled = (pairs: [string, string | null | undefined][]) => pairs.filter((p): p is [string, string] => !!p[1]?.trim());

function fromInvoice(d: InvoiceFull): Doc {
  const x = d.details;
  const ship = x && (x.ship_to_name || x.ship_to_address || x.ship_to_contact || x.ship_to_phone) ? { name: x.ship_to_name, address: x.ship_to_address, contact: x.ship_to_contact, phone: x.ship_to_phone } : null;
  return {
    kind: 'invoice',
    title: 'TAX INVOICE',
    number: d.number,
    at: d.at,
    cancelled: d.status === 'cancelled',
    customer: { name: d.customer_name, address: d.customer_address, phone: d.customer_phone, gstin: d.customer_gstin, pan: x?.customer_pan ?? null },
    shipTo: ship,
    pos: d.place_of_supply,
    supply: d.supply_type ?? 'intra',
    facts: filled([
      ['Payment', MODE_LABEL[d.payment_mode] ?? d.payment_mode],
      ['Reverse charge', 'No'],
      ['E-way bill', d.transport?.ewb_no ? `${d.transport.ewb_no.replace(/(\d{4})(?=\d)/g, '$1 ')}${d.transport.ewb_date ? ` · ${fmtDate(d.transport.ewb_date)}` : ''}` : null],
      ['Vehicle', d.transport?.vehicle_no ?? null],
    ]),
    boxes: filled([
      ['Delivery note', x?.delivery_note || (d.challans?.length ? d.challans.join(', ') : null)],
      ['Reference', x?.reference || (d.quotation ? `${d.quotation.number} · ${fmtDate(d.quotation.quote_date)}` : null)],
      ['Other references', x?.other_references],
      ['Dispatched through', x?.dispatched_through],
      ['Destination', x?.destination || d.transport?.to_place],
      ['Terms of delivery', x?.terms_of_delivery],
    ]),
    lines: d.lines.map((l) => ({
      no: l.line_no,
      name: l.product_name,
      code: l.hsn,
      service: !!l.is_service || !!l.hsn?.startsWith('99'),
      qtyMilli: l.qty_milli,
      unit: l.unit_code,
      rate: `${formatPaise(l.rate_paise)}${l.rate_mode === 'incl' ? '*' : ''}`,
      disc: l.discount_bp ? `${formatPercent(l.discount_bp)}%` : '—',
      taxable: l.taxable_paise,
      gst: l.gst_rate_bp,
      cgst: l.cgst_paise,
      sgst: l.sgst_paise,
      igst: l.igst_paise,
      amount: l.amount_paise ?? l.total_paise,
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
    customer: { name: d.customer_name, address: d.customer_address, phone: d.customer_phone, gstin: d.customer_gstin, pan: null },
    shipTo: null,
    pos: d.place_of_supply,
    supply: d.supply_type,
    facts: filled([
      ['Against bill', `${d.invoice_number} of ${fmtDate(d.invoice_date)}`],
      ['Reason', d.reason],
      ['Refund', d.refund_mode === 'account' ? 'Credited to account' : (MODE_LABEL[d.refund_mode] ?? d.refund_mode)],
    ]),
    boxes: [],
    lines: d.lines.map((l) => ({
      no: l.line_no,
      name: l.product_name,
      code: l.hsn,
      service: !!l.hsn?.startsWith('99'),
      qtyMilli: l.qty_milli,
      unit: l.unit_code,
      rate: formatPaise(l.rate_paise),
      disc: '',
      taxable: l.taxable_paise,
      gst: l.gst_rate_bp,
      cgst: l.cgst_paise,
      sgst: l.sgst_paise,
      igst: l.igst_paise,
      amount: l.total_paise,
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
      const t = setTimeout(() => window.print(), 600);
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
      <style>{`@page { size: A4; margin: 10mm; } @media print { .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; min-height: 277mm !important; padding: 0 !important; break-after: page; } .sheet:last-child { break-after: auto; } }`}</style>
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

/** "1.525 ton · 100 bag · 3 coil": goods only, per unit, in the order they appear. */
function totalQuantity(lines: DocLine[]) {
  const by = new Map<string, number>();
  for (const l of lines) if (!l.service) by.set(l.unit, (by.get(l.unit) ?? 0) + l.qtyMilli);
  return [...by].map(([u, q]) => `${formatQty(q)} ${u}`).join(' · ');
}

const MUTED = 'text-[#6b675f]';

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
  const nameParts = d.store.name.match(/^(\S+)\s+(.*)$/);
  const inter = d.supply === 'inter';
  const hasIncl = d.lines.some((l) => l.rate?.endsWith('*'));
  const tax = d.cgst + d.sgst + d.igst;
  const qty = totalQuantity(d.lines);
  const isInvoice = d.kind === 'invoice';
  const th = 'px-1 py-[5px] text-[10px] font-semibold text-ink-2 align-bottom';
  const td = 'px-1 py-[5px] text-right align-top whitespace-nowrap';
  const sep = 'border-l border-[#e4e0d8]';

  return (
    <div className="sheet relative mx-auto mb-8 flex min-h-[1123px] w-[794px] flex-col gap-2.5 bg-white px-11 pb-9 pt-[38px] text-[12.5px] leading-[1.4] text-ink shadow-lg [font-variant-numeric:tabular-nums]">
      {d.cancelled && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="rotate-[-24deg] rounded border-4 border-bad px-6 py-2 text-6xl font-extrabold tracking-widest text-bad/40">CANCELLED</span>
        </div>
      )}

      {/* header */}
      <div className="flex items-start justify-between gap-6 border-b-2 border-brick pb-2.5">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <LogoMark size={58} title={d.store.name} />
            <span className="flex flex-col leading-none">
              <span className="text-[30px] font-extrabold tracking-[.02em]" style={{ fontStretch: '75%' }}>
                {(nameParts?.[1] ?? d.store.name).toUpperCase()}
              </span>
              <span className="mt-[3px] text-[10px] font-semibold tracking-[.32em] text-ink-2">{(nameParts?.[2] ?? '').toUpperCase().replace(' AND ', ' & ')}</span>
            </span>
          </div>
          <div className="text-[12px] leading-[1.5] text-ink-2">
            {d.store.address}
            <br />
            {d.store.phone && <>Phone {d.store.phone} · </>}GSTIN <b className="text-ink">{d.store.gstin || '—'}</b> · State code {d.store.stateCode}
          </div>
        </div>
        <div className="flex flex-col items-end gap-[3px] text-right">
          <span className="text-[24px] font-extrabold leading-none tracking-[.05em]" style={{ fontStretch: '75%' }}>
            {d.title}
          </span>
          {labels === 'te-en' && T[d.title] && <span className="telugu text-[11px] font-semibold text-brick">{T[d.title]}</span>}
          <span className={cx('text-[12px]', MUTED)}>{copyLabel}</span>
          <span className="mt-2 text-[15px] font-bold">{d.number}</span>
          <span className="text-[12px] text-ink-2">{fmtDateTime(d.at)}</span>
        </div>
      </div>

      {/* bill to / ship to / facts */}
      <div className="grid grid-cols-3 gap-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-bold text-brick">{L('Bill to')}</span>
          <span className="text-[14px] font-bold">{d.customer.name ?? 'Walk-in customer'}</span>
          {d.customer.address && <span>{d.customer.address}</span>}
          {d.customer.phone && <span>Phone {d.customer.phone}</span>}
          {d.customer.gstin && (
            <span>
              GSTIN <b>{d.customer.gstin}</b>
            </span>
          )}
          {d.customer.pan && (
            <span>
              PAN <b>{d.customer.pan}</b>
            </span>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          {d.shipTo && (
            <>
              <span className="text-[12px] font-bold text-brick">{L('Ship to')}</span>
              {d.shipTo.name && <span className="text-[14px] font-bold">{d.shipTo.name}</span>}
              {d.shipTo.address && <span>{d.shipTo.address}</span>}
              {(d.shipTo.contact || d.shipTo.phone) && <span>{[d.shipTo.contact, d.shipTo.phone].filter(Boolean).join(' · ')}</span>}
            </>
          )}
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-3 gap-y-[3px]">
          <span className={MUTED}>Place of supply</span>
          <span>
            {stateName(d.pos)} ({d.pos})
          </span>
          {d.facts.map(([k, v]) => (
            <span key={k} className="contents">
              <span className={MUTED}>{k}</span>
              <span>{v}</span>
            </span>
          ))}
        </div>
      </div>

      {/* delivery boxes, only when filled in */}
      {d.boxes.length > 0 && (
        <div className="grid grid-cols-3 gap-x-6 gap-y-1.5 rounded-[6px] bg-[#f5f3ee] px-3.5 py-2">
          {d.boxes.map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <span className={cx('text-[12px]', MUTED)}>{k}</span>
              <span className="font-semibold">{v}</span>
            </div>
          ))}
        </div>
      )}

      {/* items, with GST on every line */}
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr>
            <th rowSpan={2} className={cx(th, 'w-[18px] border-b-[1.5px] border-ink text-left')}>
              #
            </th>
            <th rowSpan={2} className={cx(th, 'border-b-[1.5px] border-ink text-left')}>
              {L('Item')}
            </th>
            <th rowSpan={2} className={cx(th, 'border-b-[1.5px] border-ink text-right')}>
              {L('Qty')}
            </th>
            <th rowSpan={2} className={cx(th, 'border-b-[1.5px] border-ink text-right')}>
              {L('Rate')}
            </th>
            {isInvoice && (
              <th rowSpan={2} className={cx(th, 'border-b-[1.5px] border-ink text-right')}>
                Disc
              </th>
            )}
            <th rowSpan={2} className={cx(th, 'border-b-[1.5px] border-ink text-right')}>
              Taxable value
            </th>
            {inter ? (
              <th colSpan={2} className={cx(th, sep, 'border-b border-[#e4e0d8] text-center')}>
                IGST
              </th>
            ) : (
              <>
                <th colSpan={2} className={cx(th, sep, 'border-b border-[#e4e0d8] text-center')}>
                  CGST
                </th>
                <th colSpan={2} className={cx(th, sep, 'border-b border-[#e4e0d8] text-center')}>
                  SGST
                </th>
              </>
            )}
            <th rowSpan={2} className={cx(th, sep, 'border-b-[1.5px] border-ink text-right')}>
              {L('Amount')}
            </th>
          </tr>
          <tr>
            {(inter ? [1] : [1, 2]).map((k) => (
              <SubHeads key={k} th={th} sep={sep} />
            ))}
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.no} className="border-b border-[#e4e0d8]">
              <td className="px-1 py-[5px] align-top">{l.no}</td>
              <td className="px-1 py-[5px]">
                <div className="font-semibold">
                  {l.name}
                  {l.note && <span className={cx('font-normal', MUTED)}> ({l.note})</span>}
                </div>
                {l.code && <div className={MUTED}>{(l.service ? 'SAC ' : 'HSN ') + l.code}</div>}
              </td>
              <td className={td}>{l.service && l.qtyMilli === 1000 ? '' : `${formatQty(l.qtyMilli)} ${l.unit}`}</td>
              <td className={td}>
                {l.service && l.qtyMilli === 1000 ? (
                  ''
                ) : (
                  <>
                    {l.rate}
                    <div className={MUTED}>per {l.unit}</div>
                  </>
                )}
              </td>
              {isInvoice && <td className={cx(td, l.disc === '—' && MUTED)}>{l.disc}</td>}
              <td className={td}>{formatPaise(l.taxable)}</td>
              {inter ? (
                <>
                  <td className={cx(td, sep, 'text-ink-2')}>{formatPercent(l.gst)}%</td>
                  <td className={td}>{formatPaise(l.igst)}</td>
                </>
              ) : (
                <>
                  <td className={cx(td, sep, 'text-ink-2')}>{formatPercent(l.gst / 2)}%</td>
                  <td className={td}>{formatPaise(l.cgst)}</td>
                  <td className={cx(td, sep, 'text-ink-2')}>{formatPercent(l.gst / 2)}%</td>
                  <td className={td}>{formatPaise(l.sgst)}</td>
                </>
              )}
              <td className={cx(td, sep, 'font-semibold')}>{formatPaise(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-b-[1.5px] border-ink font-bold">
            <td className="px-1 py-1.5" />
            <td className="px-1 py-1.5">Total</td>
            <td colSpan={isInvoice ? 3 : 2} className="whitespace-nowrap px-1 py-1.5 text-right font-semibold">
              {qty}
            </td>
            <td className="px-1 py-1.5 text-right">{formatPaise(d.taxable)}</td>
            {inter ? (
              <td colSpan={2} className={cx('px-1 py-1.5 text-right', sep)}>
                {formatPaise(d.igst)}
              </td>
            ) : (
              <>
                <td colSpan={2} className={cx('px-1 py-1.5 text-right', sep)}>
                  {formatPaise(d.cgst)}
                </td>
                <td colSpan={2} className={cx('px-1 py-1.5 text-right', sep)}>
                  {formatPaise(d.sgst)}
                </td>
              </>
            )}
            <td className={cx('px-1 py-1.5 text-right', sep)}>{formatPaise(d.taxable + tax)}</td>
          </tr>
        </tfoot>
      </table>
      {hasIncl && <div className={cx('-mt-1.5 text-[10px]', MUTED)}>* rate includes GST</div>}

      {/* words + totals */}
      <div className="flex items-start justify-between gap-7">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div>
            <div className={cx('text-[12px]', MUTED)}>{L('Amount in words')}</div>
            <b>{amountInWords(d.total)}</b>
          </div>
        </div>
        <div className="grid w-[230px] grid-cols-[minmax(0,1fr)_auto] content-start gap-x-3 gap-y-[5px]">
          {d.discount > 0 && (
            <>
              <span className={MUTED}>Discount given</span>
              <span className="text-right">{formatPaise(d.discount)}</span>
            </>
          )}
          <span className={MUTED}>Taxable value</span>
          <span className="text-right">{formatPaise(d.taxable)}</span>
          {inter ? (
            <>
              <span className={MUTED}>IGST</span>
              <span className="text-right">{formatPaise(d.igst)}</span>
            </>
          ) : (
            <>
              <span className={MUTED}>CGST</span>
              <span className="text-right">{formatPaise(d.cgst)}</span>
              <span className={MUTED}>SGST</span>
              <span className="text-right">{formatPaise(d.sgst)}</span>
            </>
          )}
          <span className={MUTED}>Round off</span>
          <span className="text-right">{d.roundOff < 0 ? '−' : ''}{formatPaise(Math.abs(d.roundOff))}</span>
          <div className="col-span-2 mt-1.5 flex items-baseline justify-between border-y-[1.5px] border-ink pb-1.5 pt-2">
            <span className="text-[13px] font-bold tracking-[.08em]">{isInvoice ? 'TOTAL' : 'CREDIT'}</span>
            <span className="text-[22px] font-extrabold" style={{ fontStretch: '75%' }}>
              ₹{formatPaise(d.total)}
            </span>
          </div>
        </div>
      </div>

      {/* terms + signature */}
      <div className="mt-auto flex items-end justify-between gap-7 border-t border-[#e4e0d8] pt-3">
        <div className="max-w-[400px] text-[12px] leading-[1.5] text-ink-2">
          {isInvoice && d.store.terms && (
            <>
              <b className="text-ink">{L('Terms')}</b> · {d.store.terms}
            </>
          )}
          <div className={cx('mt-1', MUTED)}>{d.footer} · Computer-generated {isInvoice ? 'invoice' : 'document'}</div>
        </div>
        <div className="flex w-[240px] flex-col">
          <span>For</span>
          <div className="h-9" />
          <div className="flex flex-col border-t border-ink pt-[5px] text-center">
            <span className="text-[12px] font-bold uppercase tracking-[.03em]">{d.store.name}</span>
            <span className={cx('text-[12px]', MUTED)}>{L('Authorised signatory')}</span>
          </div>
        </div>
      </div>

      {/* brands we deal in */}
      {d.store.showBrands !== false && (
        <div className="flex flex-col gap-2 border-t-2 border-brick pt-2.5">
          <span className={cx('text-center text-[12px] font-semibold tracking-[.14em]', MUTED)}>AUTHORISED DEALERS FOR</span>
          <div className="grid grid-cols-5 items-center justify-items-center gap-x-[18px] gap-y-2">
            {BRANDS.map((b) =>
              'crop' in b ? (
                <div key={b.name} style={{ width: b.crop.w, height: b.crop.h, overflow: 'hidden' }}>
                  <img src={b.src} alt={b.name} style={{ width: b.crop.imgW, height: b.crop.imgH, maxWidth: 'none', marginLeft: -b.crop.x, marginTop: -b.crop.y }} />
                </div>
              ) : 'src' in b ? (
                <img key={b.name} src={b.src} alt={b.name} style={{ height: b.h, width: 'auto', maxWidth: 120, filter: b.mono ? 'brightness(0)' : undefined }} />
              ) : (
                <div key={b.name} className="flex flex-col items-center leading-none">
                  <span className="text-[16px] font-extrabold tracking-[.02em] text-ink-2">{b.word}</span>
                  <span className={cx('mt-[3px] text-[8px] font-semibold tracking-[.2em]', MUTED)}>{b.sub}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SubHeads({ th, sep }: { th: string; sep: string }) {
  return (
    <>
      <th className={cx(th, sep, 'border-b-[1.5px] border-ink text-right')}>Rate</th>
      <th className={cx(th, 'border-b-[1.5px] border-ink text-right')}>Amount</th>
    </>
  );
}

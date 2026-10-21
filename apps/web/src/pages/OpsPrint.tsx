import { useEffect } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { amountInWords, formatPaise, formatQty } from '@kph/core';
import { get } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Button, LogoMark, Spinner } from '../components/ui';

/** A4 print pages for quotations and delivery challans, on the shop letterhead. */

interface Store {
  name: string;
  address: string;
  phone: string;
  gstin: string;
  terms?: string;
  labels: 'en' | 'te-en';
}

/** noGstin: quotations don't show the shop's GST number (owner's choice). */
function Letterhead({ store, title, telugu, sub, noGstin }: { store: Store; title: string; telugu?: string; sub: string; noGstin?: boolean }) {
  const name = /^(\S+)\s+(.*)$/.exec(store.name);
  return (
    <div className="flex items-start justify-between gap-5 border-b-[3px] border-brick pb-3.5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <LogoMark size={54} title={store.name} />
          <span className="flex flex-col leading-[1.02]">
            <span className="text-[22pt] font-extrabold tracking-[.02em]" style={{ fontStretch: '75%' }}>
              {(name?.[1] ?? store.name).toUpperCase()}
            </span>
            <span className="text-[7.5pt] font-semibold tracking-[.3em] text-ink-2">{(name?.[2] ?? '').toUpperCase().replace(' AND ', ' & ')}</span>
          </span>
        </div>
        <div className="text-[9pt] leading-[1.45] text-ink-2">
          {store.address}
          {store.phone && <> · Phone {store.phone}</>}
          {store.gstin && !noGstin && <> · GSTIN {store.gstin}</>}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[18pt] font-extrabold tracking-[.04em]" style={{ fontStretch: '75%' }}>
          {title}
        </div>
        {store.labels === 'te-en' && telugu && <div className="telugu text-[10pt] font-semibold text-brick">{telugu}</div>}
        <div className="num text-[9pt] text-ink-3">{sub}</div>
      </div>
    </div>
  );
}

function Sheet({ children, doc }: { children: React.ReactNode; doc: string }) {
  useEffect(() => {
    document.title = doc.replace(/\//g, '-');
  }, [doc]);
  return (
    <div className="min-h-screen bg-concrete py-4">
      <style>{`@page { size: A4; margin: 12mm; } @media print { .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; padding: 0 !important; } }`}</style>
      <div className="no-print mx-auto flex max-w-[794px] justify-end px-2 pb-3">
        <Button variant="dark" onClick={() => window.print()}>
          Print / save as PDF
        </Button>
      </div>
      <div className="sheet mx-auto flex w-[794px] flex-col gap-3.5 bg-white px-11 py-10 text-[10pt] shadow-lg">{children}</div>
    </div>
  );
}

const TABLE = 'w-full border-collapse text-[9pt] [&_td]:border-b [&_td]:border-line-3 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-b-2 [&_th]:border-ink [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left';

interface QuoteDoc {
  number: string;
  quote_date: string;
  valid_until: string;
  display_name: string | null;
  display_phone: string | null;
  display_address: string | null;
  site: string | null;
  template: string | null;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  round_off_paise: number;
  total_paise: number;
  notes: string | null;
  status: string;
  lines: { line_no: number; stage: string | null; product_name: string; unit_code: string; qty_milli: number; rate_paise: number; rate_mode: string; discount_bp: number; gst_rate_bp: number; amount_paise: number }[];
  store: Store;
}

export function QuotePrint() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['ops', 'quote-print', id], queryFn: () => get<QuoteDoc>(`/api/quotes/${id}`) });
  const d = q.data;
  if (!d) return <div className="p-10"><Spinner /></div>;
  const stages = d.template === 'full_house' ? [...new Set(d.lines.map((l) => l.stage ?? 'Other'))] : [null];
  const rs = (p: number) => formatPaise(p);
  return (
    <Sheet doc={d.number}>
      <Letterhead store={d.store} title={d.template === 'full_house' ? 'ESTIMATE' : 'QUOTATION'} telugu="అంచనా" sub={`${d.number} · ${fmtDate(d.quote_date)}`} noGstin />
      <div className="flex justify-between gap-4">
        <div>
          <div className="text-[11pt] font-bold">{d.display_name ?? '—'}</div>
          {d.display_address && <div>{d.display_address}</div>}
          {d.display_phone && <div>Phone {d.display_phone}</div>}
          {d.site && <div>Site: {d.site}</div>}
        </div>
        <div className="num text-right">
          <div>
            Valid till <b>{fmtDate(d.valid_until)}</b>
          </div>
          {d.status !== 'open' && <div className="font-bold text-bad">{d.status.toUpperCase()}</div>}
        </div>
      </div>
      <table className={TABLE}>
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th className="!text-right">Qty</th>
            <th className="!text-right">Rate</th>
            <th className="!text-right">Disc %</th>
            <th className="!text-right">GST %</th>
            <th className="!text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="num">
          {stages.map((st) => {
            const ls = d.lines.filter((l) => st == null || (l.stage ?? 'Other') === st);
            const sub = ls.reduce((t, l) => t + l.amount_paise, 0);
            return [
              st && (
                <tr key={`h-${st}`}>
                  <td colSpan={7} className="!border-b-0 pt-2 text-[9pt] font-bold uppercase tracking-[.1em] text-brick">
                    {st}
                  </td>
                </tr>
              ),
              ...ls.map((l) => (
                <tr key={l.line_no}>
                  <td>{l.line_no}</td>
                  <td>{l.product_name}</td>
                  <td className="text-right">
                    {formatQty(l.qty_milli)} {l.unit_code}
                  </td>
                  <td className="text-right">
                    {rs(l.rate_paise)}
                    {l.rate_mode === 'incl' && '*'}
                  </td>
                  <td className="text-right">{l.discount_bp ? (l.discount_bp / 100).toFixed(2) : ''}</td>
                  <td className="text-right">{l.gst_rate_bp / 100}</td>
                  <td className="text-right">{rs(l.amount_paise)}</td>
                </tr>
              )),
              st && (
                <tr key={`s-${st}`}>
                  <td colSpan={6} className="text-right text-ink-3">
                    {st} subtotal
                  </td>
                  <td className="text-right font-bold">{rs(sub)}</td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      <div className="flex justify-end">
        <div className="num grid w-[260px] grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
          <span>Taxable value</span>
          <span className="text-right">{rs(d.taxable_paise)}</span>
          {d.igst_paise ? (
            <>
              <span>IGST</span>
              <span className="text-right">{rs(d.igst_paise)}</span>
            </>
          ) : (
            <>
              <span>CGST</span>
              <span className="text-right">{rs(d.cgst_paise)}</span>
              <span>SGST</span>
              <span className="text-right">{rs(d.sgst_paise)}</span>
            </>
          )}
          <span>Round off</span>
          <span className="text-right">{rs(d.round_off_paise)}</span>
          <span className="border-t border-ink pt-1 font-extrabold">Total</span>
          <span className="border-t border-ink pt-1 text-right text-[12pt] font-extrabold">₹{rs(d.total_paise)}</span>
        </div>
      </div>
      <div className="text-[9pt]">{amountInWords(d.total_paise)}</div>
      <div className="mt-4 border-t border-line pt-3 text-[9pt] text-ink-2">
        This is a quotation, not a bill. Prices and stock are confirmed at the time of billing.{d.lines.some((l) => l.rate_mode === 'incl') && ' * rate includes GST.'}
        {d.notes && <div className="mt-1">Note: {d.notes}</div>}
      </div>
    </Sheet>
  );
}

interface ChallanDoc {
  number: string;
  delivery_date: string;
  invoice_number: string;
  invoice_date: string;
  customer_name: string;
  customer_gstin: string | null;
  site_address: string | null;
  contact_phone: string | null;
  vehicle_no: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  charge_paise: number;
  notes: string | null;
  lines: { line_no: number; product_name: string; hsn: string | null; unit_code: string; qty_milli: number }[];
  store: Store;
}

export function ChallanPrint() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['ops', 'challan', id], queryFn: () => get<ChallanDoc>(`/api/deliveries/${id}`) });
  const d = q.data;
  if (!d) return <div className="p-10"><Spinner /></div>;
  return (
    <Sheet doc={d.number}>
      <Letterhead store={d.store} title="DELIVERY CHALLAN" telugu="డెలివరీ చలాన్" sub={`${d.number} · ${fmtDate(d.delivery_date)}`} />
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[8pt] font-bold uppercase tracking-[.14em] text-ink-3">Deliver to</div>
          <div className="text-[11pt] font-bold">{d.customer_name}</div>
          {d.site_address && <div>{d.site_address}</div>}
          {d.contact_phone && <div>Phone {d.contact_phone}</div>}
          {d.customer_gstin && <div>GSTIN {d.customer_gstin}</div>}
        </div>
        <div className="num grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-0.5">
          <span className="text-ink-3">Against bill</span>
          <b>
            {d.invoice_number} · {fmtDate(d.invoice_date)}
          </b>
          <span className="text-ink-3">Vehicle</span>
          <b>{d.vehicle_no ?? '—'}</b>
          <span className="text-ink-3">Driver</span>
          <span>{[d.driver_name, d.driver_phone].filter(Boolean).join(' · ') || '—'}</span>
          {d.charge_paise > 0 && (
            <>
              <span className="text-ink-3">Delivery charge</span>
              <span>₹{formatPaise(d.charge_paise)}</span>
            </>
          )}
        </div>
      </div>
      <table className={TABLE}>
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th>HSN</th>
            <th className="!text-right">Quantity</th>
          </tr>
        </thead>
        <tbody className="num">
          {d.lines.map((l, i) => (
            <tr key={l.line_no}>
              <td>{i + 1}</td>
              <td>{l.product_name}</td>
              <td>{l.hsn}</td>
              <td className="text-right font-bold">
                {formatQty(l.qty_milli)} {l.unit_code}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.notes && <div className="text-[9pt]">Note: {d.notes}</div>}
      <div className="mt-12 grid grid-cols-2 gap-10 text-[9pt]">
        <div className="border-t border-ink pt-1">Received the above goods in good condition — name, signature, date</div>
        <div className="border-t border-ink pt-1 text-right">For {d.store.name}</div>
      </div>
    </Sheet>
  );
}

interface PODoc {
  number: string;
  created_at: string;
  expected_on: string | null;
  status: string;
  supplier_name: string;
  supplier_phone: string | null;
  supplier_address: string | null;
  supplier_gstin: string | null;
  notes: string | null;
  lines: { product_id: number; name: string; sku: string; unit_code: string; qty_milli: number }[];
  store: Store;
}

export function PurchaseOrderPrint() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['stock', 'po-print', id], queryFn: () => get<PODoc>(`/api/purchase-orders/${id}`) });
  const d = q.data;
  if (!d) return <div className="p-10"><Spinner /></div>;
  return (
    <Sheet doc={d.number}>
      <Letterhead store={d.store} title="PURCHASE ORDER" telugu="కొనుగోలు ఆర్డర్" sub={`${d.number} · ${fmtDate(d.created_at.slice(0, 10))}`} />
      <div>
        <div className="text-[8pt] font-bold uppercase tracking-[.14em] text-ink-3">To</div>
        <div className="text-[11pt] font-bold">{d.supplier_name}</div>
        {d.supplier_address && <div>{d.supplier_address}</div>}
        {d.supplier_phone && <div>Phone {d.supplier_phone}</div>}
        {d.supplier_gstin && <div>GSTIN {d.supplier_gstin}</div>}
      </div>
      <table className={TABLE}>
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th>Code</th>
            <th className="!text-right">Quantity</th>
          </tr>
        </thead>
        <tbody className="num">
          {d.lines.map((l, i) => (
            <tr key={l.product_id}>
              <td>{i + 1}</td>
              <td>{l.name}</td>
              <td>{l.sku}</td>
              <td className="text-right font-bold">
                {formatQty(l.qty_milli)} {l.unit_code}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.expected_on && <div>Please deliver by {fmtDate(d.expected_on)}.</div>}
      {d.notes && <div>Note: {d.notes}</div>}
      <div className="mt-12 text-right text-[9pt]">For {d.store.name}</div>
    </Sheet>
  );
}

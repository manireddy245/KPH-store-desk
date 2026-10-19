import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { amountInWords, formatPaise, formatPercent, formatQty, taxSummaryByRate } from '@kph/core';
import { get } from '../lib/api';
import { MODE_LABEL, fmtDateTime } from '../lib/format';
import type { InvoiceFull } from '../lib/types';
import { Button, LogoMark, Spinner } from '../components/ui';

/**
 * A4 tax invoice. Provisional layout until the shop sends its preferred format.
 * The max-discount hint is never shown here.
 */
export function InvoicePrint() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ['invoice', Number(id)], queryFn: () => get<InvoiceFull>(`/api/invoices/${id}`) });
  const d = q.data;

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
        <Spinner /> Loading bill…
      </div>
    );

  const summary = taxSummaryByRate(d.lines.map((l) => ({ ...l, qtyMilli: l.qty_milli, ratePaise: l.rate_paise, discountBp: l.discount_bp, gstRateBp: l.gst_rate_bp, grossPaise: l.gross_paise, discountPaise: l.discount_paise, taxablePaise: l.taxable_paise, cgstPaise: l.cgst_paise, sgstPaise: l.sgst_paise, igstPaise: l.igst_paise, totalPaise: l.total_paise })));
  const nameParts = d.store.name.match(/^(\S+)\s+(.*)$/);

  return (
    <div className="min-h-screen bg-concrete print:bg-white">
      <style>{`@page { size: A4; margin: 12mm; } @media print { .sheet { box-shadow: none !important; margin: 0 !important; width: auto !important; min-height: auto !important; padding: 0 !important; } }`}</style>
      <div className="no-print mx-auto flex max-w-[794px] items-center justify-between gap-2 px-2 py-3">
        <span className="text-sm text-ink-3">Use “Save as PDF” in the print window to make a PDF.</span>
        <div className="flex gap-2">
          <Button onClick={() => window.close()}>Close</Button>
          <Button variant="dark" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      <div className="sheet relative mx-auto mb-8 flex min-h-[1123px] w-[794px] flex-col gap-3.5 bg-white px-11 py-10 text-[10pt] shadow-lg">
        {d.status === 'cancelled' && (
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
              TAX INVOICE
            </div>
            <div className="telugu text-[10pt] font-semibold text-brick">పన్ను బిల్లు</div>
            <div className="text-[8.5pt] text-ink-3">Original for recipient</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[8pt] font-bold tracking-[.14em] text-ink-3">BILL TO</div>
            <div className="text-[11pt] font-bold">{d.customer_name ?? 'Walk-in customer'}</div>
            {d.customer_address && <div>{d.customer_address}</div>}
            {d.customer_phone && <div>Phone {d.customer_phone}</div>}
            {d.customer_gstin && <div>GSTIN {d.customer_gstin}</div>}
          </div>
          <div className="num grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-0.5">
            <span className="text-ink-3">Invoice no.</span>
            <b>{d.number}</b>
            <span className="text-ink-3">Date</span>
            <span>{fmtDateTime(d.at)}</span>
            <span className="text-ink-3">Place of supply</span>
            <span>
              {d.store.stateName} ({d.place_of_supply})
            </span>
            <span className="text-ink-3">Payment</span>
            <span>{MODE_LABEL[d.payment_mode]}</span>
          </div>
        </div>

        <table className="w-full border-collapse [&_td]:border-b [&_td]:border-line [&_td]:px-1.5 [&_td]:py-1.5 [&_td]:align-top [&_th]:border-y-[1.5px] [&_th]:border-ink [&_th]:px-1.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[8.5pt] [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-[.06em]">
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th>HSN</th>
              <th className="!text-right">Qty</th>
              <th className="!text-right">Rate</th>
              <th className="!text-right">Disc</th>
              <th className="!text-right">Taxable</th>
              <th className="!text-right">GST</th>
              <th className="!text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="num text-[9.5pt]">
            {d.lines.map((l) => (
              <tr key={l.line_no}>
                <td>{l.line_no}</td>
                <td>{l.product_name}</td>
                <td>{l.hsn}</td>
                <td className="text-right">
                  {formatQty(l.qty_milli)} {l.unit_code}
                </td>
                <td className="text-right">{formatPaise(l.rate_paise)}</td>
                <td className="text-right">{l.discount_bp ? `${formatPercent(l.discount_bp)}%` : '—'}</td>
                <td className="text-right">{formatPaise(l.taxable_paise)}</td>
                <td className="text-right">{formatPercent(l.gst_rate_bp)}%</td>
                <td className="text-right">{formatPaise(l.total_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-between gap-6">
          <div className="flex-1">
            <table className="num border-collapse text-[9pt] [&_td]:border-b [&_td]:border-line [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-y-[1.5px] [&_th]:border-ink [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_th]:text-[8pt] [&_th]:font-bold [&_th]:uppercase">
              <thead>
                <tr>
                  <th>GST rate</th>
                  <th className="!text-right">Taxable</th>
                  <th className="!text-right">CGST</th>
                  <th className="!text-right">SGST</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.gstRateBp}>
                    <td>
                      {formatPercent(s.gstRateBp)}% ({formatPercent(s.gstRateBp / 2)} + {formatPercent(s.gstRateBp / 2)})
                    </td>
                    <td className="text-right">{formatPaise(s.taxablePaise)}</td>
                    <td className="text-right">{formatPaise(s.cgstPaise)}</td>
                    <td className="text-right">{formatPaise(s.sgstPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3">
              <span className="text-ink-3">Amount in words:</span> <b>{amountInWords(d.total_paise)}</b>
            </div>
          </div>
          <div className="num grid w-[250px] grid-cols-[1fr_auto] content-start gap-x-3 gap-y-1">
            {d.discount_paise > 0 && (
              <>
                <span className="text-ink-3">Discount given</span>
                <span className="text-right">{formatPaise(d.discount_paise)}</span>
              </>
            )}
            <span className="text-ink-3">Taxable value</span>
            <span className="text-right">{formatPaise(d.taxable_paise)}</span>
            <span className="text-ink-3">CGST</span>
            <span className="text-right">{formatPaise(d.cgst_paise)}</span>
            <span className="text-ink-3">SGST</span>
            <span className="text-right">{formatPaise(d.sgst_paise)}</span>
            <span className="text-ink-3">Round off</span>
            <span className="text-right">{formatPaise(d.round_off_paise)}</span>
            <span className="border-t-[1.5px] border-ink pt-1.5 text-[14pt] font-extrabold" style={{ fontStretch: '75%' }}>
              TOTAL
            </span>
            <span className="border-t-[1.5px] border-ink pt-1.5 text-right text-[14pt] font-extrabold">₹{formatPaise(d.total_paise)}</span>
          </div>
        </div>

        <div className="mt-auto flex items-end justify-between gap-6 border-t border-line pt-3">
          <div className="max-w-[420px] text-[8.5pt] text-ink-2">
            {d.store.terms && (
              <>
                <b className="text-ink">Terms:</b> {d.store.terms}
              </>
            )}
            <div className="mt-1.5 text-ink-3">
              Billed by {d.user_name} · {d.device_name ?? '—'} · Computer-generated invoice
            </div>
          </div>
          <div className="text-center text-[9pt]">
            <div className="h-10" />
            <div className="border-t border-ink pt-1">
              For {d.store.name}
              <br />
              Authorised signatory
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

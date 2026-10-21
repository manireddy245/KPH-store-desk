import { useEffect, useState } from 'react';
import { ApiError, put } from '../lib/api';
import { Button, Field, Input, Modal, Notice, cx, useToast } from './ui';

/**
 * Extra details printed on a bill, all optional: ship-to (site), customer PAN and the
 * delivery boxes. Anything left blank is simply not printed.
 */
export interface BillDetails {
  shipToName?: string;
  shipToAddress?: string;
  shipToContact?: string;
  shipToPhone?: string;
  customerPan?: string;
  deliveryNote?: string;
  reference?: string;
  otherReferences?: string;
  dispatchedThrough?: string;
  destination?: string;
  termsOfDelivery?: string;
  saleBy?: string;
}

/** The details as saved on a bill (database column names). */
export interface BillDetailsRow {
  ship_to_name: string | null;
  ship_to_address: string | null;
  ship_to_contact: string | null;
  ship_to_phone: string | null;
  customer_pan: string | null;
  delivery_note: string | null;
  reference: string | null;
  other_references: string | null;
  dispatched_through: string | null;
  destination: string | null;
  terms_of_delivery: string | null;
  sale_by?: string | null;
}

export const detailsFromRow = (r: BillDetailsRow | null | undefined): BillDetails => ({
  shipToName: r?.ship_to_name ?? '',
  shipToAddress: r?.ship_to_address ?? '',
  shipToContact: r?.ship_to_contact ?? '',
  shipToPhone: r?.ship_to_phone ?? '',
  customerPan: r?.customer_pan ?? '',
  deliveryNote: r?.delivery_note ?? '',
  reference: r?.reference ?? '',
  otherReferences: r?.other_references ?? '',
  dispatchedThrough: r?.dispatched_through ?? '',
  destination: r?.destination ?? '',
  termsOfDelivery: r?.terms_of_delivery ?? '',
  saleBy: r?.sale_by ?? '',
});

/** Only what was filled in, trimmed (PAN in capitals). */
export function cleanDetails(d: BillDetails | undefined): BillDetails | undefined {
  if (!d) return undefined;
  const out: BillDetails = {};
  for (const [k, v] of Object.entries(d) as [keyof BillDetails, string | undefined][]) {
    const t = v?.trim();
    if (t) out[k] = k === 'customerPan' ? t.toUpperCase() : t;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Filled delivery boxes (Sale by has its own box on the billing screen, so it isn't counted). */
export const filledCount = (d: BillDetails | undefined) => Object.entries(d ?? {}).filter(([k, v]) => k !== 'saleBy' && v?.trim()).length;

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function BillDetailsFields({ value, onChange }: { value: BillDetails; onChange: (v: BillDetails) => void }) {
  const set = (k: keyof BillDetails) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const pan = value.customerPan?.trim().toUpperCase() ?? '';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Ship to (site name)" className="sm:col-span-2">
          <Input value={value.shipToName ?? ''} onChange={set('shipToName')} placeholder="e.g. Apartment site" />
        </Field>
        <Field label="Ship-to address" className="sm:col-span-2">
          <Input value={value.shipToAddress ?? ''} onChange={set('shipToAddress')} placeholder="e.g. Musunur Road, Kavali" />
        </Field>
        <Field label="Contact at site">
          <Input value={value.shipToContact ?? ''} onChange={set('shipToContact')} placeholder="e.g. K. Ramu (mason)" />
        </Field>
        <Field label="Contact phone">
          <Input value={value.shipToPhone ?? ''} onChange={set('shipToPhone')} inputMode="tel" />
        </Field>
        <Field label="Customer PAN" hint={pan && !PAN_RE.test(pan) ? 'PAN is 10 characters, e.g. ABCDE1234F' : undefined}>
          <Input value={value.customerPan ?? ''} onChange={set('customerPan')} maxLength={10} className="uppercase" />
        </Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Delivery note" hint="Blank = the delivery challan number, when there is one">
          <Input value={value.deliveryNote ?? ''} onChange={set('deliveryNote')} />
        </Field>
        <Field label="Reference no. & date" hint="Blank = the quotation the bill came from">
          <Input value={value.reference ?? ''} onChange={set('reference')} />
        </Field>
        <Field label="Other references">
          <Input value={value.otherReferences ?? ''} onChange={set('otherReferences')} />
        </Field>
        <Field label="Dispatched through">
          <Input value={value.dispatchedThrough ?? ''} onChange={set('dispatchedThrough')} placeholder="e.g. Own vehicle, auto, transporter" />
        </Field>
        <Field label="Destination">
          <Input value={value.destination ?? ''} onChange={set('destination')} />
        </Field>
        <Field label="Terms of delivery">
          <Input value={value.termsOfDelivery ?? ''} onChange={set('termsOfDelivery')} placeholder="e.g. Delivered at site" />
        </Field>
      </div>
    </div>
  );
}

/** On the billing screen: folded away until needed. */
export function BillDetailsSection({ value, onChange }: { value: BillDetails; onChange: (v: BillDetails) => void }) {
  const n = filledCount(value);
  const [open, setOpen] = useState(n > 0);
  return (
    <div className="flex flex-col gap-3 rounded-[6px] border border-line bg-white px-4 py-3">
      <button type="button" className="flex items-center justify-between text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="eyebrow">Ship to, PAN &amp; delivery details{n ? ` · ${n} filled` : ''}</span>
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={cx('transition-transform', open && 'rotate-180')}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && <BillDetailsFields value={value} onChange={onChange} />}
    </div>
  );
}

/** After saving: add or correct the details of a bill. */
export function BillDetailsModal({ invoiceId, number, initial, open, onClose, onSaved }: { invoiceId: number; number: string; initial: BillDetailsRow | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<BillDetails>(detailsFromRow(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setV(detailsFromRow(initial));
  }, [open, initial]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // blanks are sent as null so a box can be cleared
      const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x?.trim() ? (k === 'customerPan' ? x.trim().toUpperCase() : x.trim()) : null]));
      await put(`/api/invoices/${invoiceId}/details`, body);
      toast({ tone: 'good', text: `Details saved on ${number}` });
      onSaved();
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
      title={`Ship to & delivery details · ${number}`}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Sale by" hint="Printed on the bill under the shop address">
          <Input value={v.saleBy ?? ''} onChange={(e) => setV({ ...v, saleBy: e.target.value })} />
        </Field>
        <BillDetailsFields value={v} onChange={setV} />
        {error && <Notice tone="bad">{error}</Notice>}
      </div>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, download, get, put } from '../lib/api';
import { formatPaise } from '../lib/format';
import type { EwayStatus } from '../lib/types';
import { Badge, Button, Field, Input, Modal, Notice, Select, Spinner, useToast } from './ui';

/**
 * E-way bill helper for one bill: transport details → download the portal's bulk JSON
 * (or copy the fields) → generate on ewaybillgst.gov.in → type the 12-digit number back here.
 */
export function EwayModal({ invoiceId, open, onClose }: { invoiceId: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['eway', invoiceId], queryFn: () => get<EwayStatus>(`/api/invoices/${invoiceId}/eway`), enabled: open });
  const [f, setF] = useState({ toPlace: '', toPincode: '', distanceKm: '', transMode: 'road', vehicleNo: '', transporterId: '', transporterName: '', ewbNo: '', ewbDate: '', notNeededReason: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState(false);

  useEffect(() => {
    const t = q.data?.transport;
    if (!t) return;
    setF({
      toPlace: t.to_place ?? '',
      toPincode: t.to_pincode ?? '',
      distanceKm: t.distance_km != null ? String(t.distance_km) : '',
      transMode: t.trans_mode,
      vehicleNo: t.vehicle_no ?? '',
      transporterId: t.transporter_id ?? '',
      transporterName: t.transporter_name ?? '',
      ewbNo: t.ewb_no ?? '',
      ewbDate: t.ewb_date ?? '',
      notNeededReason: t.not_needed_reason ?? '',
    });
    setSkip(!!t.not_needed_reason);
  }, [q.data]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = async (then?: 'json') => {
    setBusy(then ?? 'save');
    setError(null);
    try {
      const r = await put<EwayStatus>(`/api/invoices/${invoiceId}/transport`, {
        toPlace: f.toPlace || null,
        toPincode: f.toPincode || null,
        distanceKm: f.distanceKm === '' ? null : Number(f.distanceKm),
        transMode: f.transMode,
        vehicleNo: f.vehicleNo || null,
        transporterId: f.transporterId || null,
        transporterName: f.transporterName || null,
        ewbNo: f.ewbNo || null,
        ewbDate: f.ewbDate || null,
        notNeededReason: skip ? f.notNeededReason || 'Not needed' : null,
      });
      qc.setQueryData(['eway', invoiceId], r);
      qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      if (then === 'json') {
        if (r.missing.length) setError(`Fill these in first: ${r.missing.join('; ')}`);
        else await download(`/api/invoices/${invoiceId}/eway.json`, `eway-bill_${r.number}.json`);
      } else toast({ tone: 'good', text: f.ewbNo ? `E-way bill ${f.ewbNo} saved on ${r.number}` : 'Transport details saved' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  const d = q.data;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={d ? `E-way bill · ${d.number}` : 'E-way bill'}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {!skip && (
            <Button onClick={() => void save('json')} busy={busy === 'json'}>
              Download JSON for the portal
            </Button>
          )}
          <Button variant="primary" onClick={() => void save()} busy={busy === 'save'}>
            Save
          </Button>
        </>
      }
    >
      {!d ? (
        <div className="flex items-center gap-2 text-ink-3">
          <Spinner /> Loading…
        </div>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              Goods value <b className="num">₹{formatPaise(d.valuePaise)}</b>
            </span>
            {d.needed ? <Badge tone="warn">E-way bill needed (over ₹50,000)</Badge> : <Badge>Not needed (₹50,000 or less)</Badge>}
            {d.transport?.ewb_no && <Badge tone="good">EWB {d.transport.ewb_no}</Badge>}
          </div>

          <section className="grid gap-3 sm:grid-cols-3">
            <Field label="Delivery town / place">
              <Input value={f.toPlace} onChange={set('toPlace')} placeholder="e.g. Nellore" />
            </Field>
            <Field label="Delivery PIN code">
              <Input value={f.toPincode} onChange={set('toPincode')} inputMode="numeric" maxLength={6} placeholder="524001" />
            </Field>
            <Field label="Distance (km)" hint="Road distance; the portal checks it against the PIN codes">
              <Input value={f.distanceKm} onChange={set('distanceKm')} inputMode="numeric" />
            </Field>
            <Field label="Mode">
              <Select value={f.transMode} onChange={set('transMode')}>
                <option value="road">Road</option>
                <option value="rail">Rail</option>
                <option value="air">Air</option>
                <option value="ship">Ship</option>
              </Select>
            </Field>
            <Field label="Vehicle number">
              <Input value={f.vehicleNo} onChange={set('vehicleNo')} placeholder="AP39AB1234" className="uppercase" />
            </Field>
            <Field label="Transporter ID (optional)" hint="Their GSTIN / TRANSIN, if a transporter carries it">
              <Input value={f.transporterId} onChange={set('transporterId')} maxLength={15} className="uppercase" />
            </Field>
            <Field label="Transporter name (optional)" className="sm:col-span-3">
              <Input value={f.transporterName} onChange={set('transporterName')} />
            </Field>
          </section>

          {!skip && d.missing.length > 0 && (
            <Notice tone="warn">
              Still needed for the e-way bill: {d.missing.join('; ')}.
            </Notice>
          )}

          <section className="rounded-[6px] bg-paper p-3">
            <div className="mb-2 font-bold">After generating it on ewaybillgst.gov.in</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="E-way bill number (12 digits)">
                <Input value={f.ewbNo} onChange={set('ewbNo')} inputMode="numeric" placeholder="1234 5678 9012" />
              </Field>
              <Field label="E-way bill date">
                <Input type="date" value={f.ewbDate} onChange={set('ewbDate')} />
              </Field>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">The number is printed on the bill and shown in Reports → E-way bills.</p>
          </section>

          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            <span>
              No e-way bill for this bill
              {skip && <Input className="mt-1.5" value={f.notNeededReason} onChange={set('notNeededReason')} placeholder="Why? e.g. customer collected from the shop in their own vehicle" />}
            </span>
          </label>

          {error && <Notice tone="bad">{error}</Notice>}
          <p className="text-[12px] text-ink-3">
            Portal: e-Waybill → <b>Generate Bulk</b> → choose the downloaded JSON. Check the result on the portal before printing it. Store Desk does not send anything to the portal itself.
          </p>
        </div>
      )}
    </Modal>
  );
}

import { useState } from 'react';
import { decodeGstin } from '@kph/core';
import { ApiError, get } from '../lib/api';
import { Button, Field, Input, Notice, Select } from './ui';

/** A business customer's GST details, kept apart from their contact details. */
export interface GstInfo {
  legalName?: string;
  tradeName?: string;
  type?: string;
  status?: string;
  constitution?: string;
  address?: string;
  checked?: boolean;
}

export const gstFromRow = (r: { gst_legal_name?: string | null; gst_trade_name?: string | null; gst_type?: string | null; gst_status?: string | null; gst_constitution?: string | null; gst_address?: string | null } | null | undefined): GstInfo => ({
  legalName: r?.gst_legal_name ?? '',
  tradeName: r?.gst_trade_name ?? '',
  type: r?.gst_type ?? '',
  status: r?.gst_status ?? '',
  constitution: r?.gst_constitution ?? '',
  address: r?.gst_address ?? '',
});

/** For saving: trimmed, blanks as null. */
export const gstBody = (g: GstInfo) => ({
  legalName: g.legalName?.trim() || null,
  tradeName: g.tradeName?.trim() || null,
  type: g.type?.trim() || null,
  status: g.status?.trim() || null,
  constitution: g.constitution?.trim() || null,
  address: g.address?.trim() || null,
  checked: !!g.checked,
});

const TYPES = ['Regular', 'Composition', 'SEZ unit', 'Input Service Distributor', 'Casual taxable person', 'Non-resident'];

/**
 * GSTIN box plus the GST details. Typing a valid GSTIN shows its state, PAN and kind of business at once;
 * "Fetch details" fills legal name, trade name, Regular / Composition, status and address from the GST
 * lookup service (when one is set up in Settings). onFound lets the form fill an empty name / address.
 */
export function GstDetailsFields({
  gstin,
  onGstin,
  gst,
  onGst,
  onFound,
}: {
  gstin: string;
  onGstin: (v: string) => void;
  gst: GstInfo;
  onGst: (g: GstInfo) => void;
  onFound?: (g: GstInfo) => void;
}) {
  const g = gstin.trim().toUpperCase();
  const decoded = decodeGstin(g);
  const bad = g.length > 0 && !decoded;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'bad' | 'warn' | 'good'; text: string } | null>(null);
  const set = (k: keyof GstInfo) => (e: { target: { value: string } }) => onGst({ ...gst, [k]: e.target.value });

  const fetchDetails = async () => {
    if (!decoded) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await get<{ details: Omit<GstInfo, 'checked'> | null; lookup: 'off' | 'done' }>(`/api/gstin/${decoded.gstin}`);
      if (r.lookup === 'off' || !r.details) {
        setMsg({ tone: 'warn', text: 'The GST lookup service is not set up yet (Settings → Shop & billing). Type the details from their bill or the GST portal.' });
        return;
      }
      const d = r.details;
      const next: GstInfo = {
        legalName: d.legalName ?? '',
        tradeName: d.tradeName ?? '',
        type: d.type ?? '',
        status: d.status ?? '',
        constitution: d.constitution ?? decoded.holderType,
        address: d.address ?? '',
        checked: true,
      };
      onGst(next);
      onFound?.(next);
      setMsg({ tone: next.status && !/active/i.test(next.status) ? 'warn' : 'good', text: next.status && !/active/i.test(next.status) ? `Fetched — but this GSTIN is ${next.status}.` : 'Details fetched from GST records.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not fetch the details' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="flex flex-col gap-2.5 rounded-[6px] border border-line bg-paper/60 px-3.5 py-3">
      <legend className="eyebrow px-1">GST details (business customers)</legend>
      <div className="flex items-end gap-2">
        <Field label="GSTIN" className="flex-1" hint={bad ? 'Not a valid GSTIN — check for a typo (15 characters)' : undefined}>
          <Input value={gstin} maxLength={15} onChange={(e) => onGstin(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="Optional, e.g. 37ABCDE1234F1ZZ" className="uppercase" />
        </Field>
        <Button type="button" disabled={!decoded} busy={busy} onClick={() => void fetchDetails()} className="h-10">
          Fetch details
        </Button>
      </div>
      {decoded && (
        <div className="text-[13px] text-ink-2">
          {decoded.stateName} ({decoded.stateCode}) · PAN <b>{decoded.pan}</b> · {decoded.holderType}
        </div>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {decoded && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Legal name">
            <Input value={gst.legalName ?? ''} onChange={set('legalName')} />
          </Field>
          <Field label="Trade name">
            <Input value={gst.tradeName ?? ''} onChange={set('tradeName')} />
          </Field>
          <Field label="Registration type">
            <Select value={gst.type ?? ''} onChange={set('type')}>
              <option value="">—</option>
              {[...new Set([...TYPES, ...(gst.type ? [gst.type] : [])])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Input value={gst.status ?? ''} onChange={set('status')} placeholder="e.g. Active" />
          </Field>
          <Field label="Constitution of business">
            <Input value={gst.constitution ?? ''} onChange={set('constitution')} placeholder={decoded.holderType} />
          </Field>
          <Field label="Registered address (GST)" className="sm:col-span-2">
            <Input value={gst.address ?? ''} onChange={set('address')} />
          </Field>
        </div>
      )}
    </fieldset>
  );
}

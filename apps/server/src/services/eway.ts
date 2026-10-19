import { EWAY_THRESHOLD_PAISE, ewayNeeded, ewayValuePaise, ewbDate, isValidGstin, isValidVehicleNo, normalizeVehicleNo, uqcFor } from '@kph/core';
import type { Q, Sql } from '../db/connect.js';
import { AppError, audit, requirePerm, type Ctx } from './common.js';
import { getSettings } from './settings.js';

/**
 * E-way bill helper. Store Desk does not talk to the e-way bill portal (that needs a GSP
 * account); it prepares everything the portal asks for — on screen to type in, or as the
 * portal's bulk-upload JSON — and keeps the e-way bill number on the bill once you have it.
 */

export interface TransportInput {
  toPlace?: string | null;
  toPincode?: string | null;
  distanceKm?: number | null;
  transMode?: 'road' | 'rail' | 'air' | 'ship';
  vehicleNo?: string | null;
  transporterId?: string | null;
  transporterName?: string | null;
  ewbNo?: string | null;
  ewbDate?: string | null;
  notNeededReason?: string | null;
}

interface TransportRow {
  to_place: string | null;
  to_pincode: string | null;
  distance_km: number | null;
  trans_mode: 'road' | 'rail' | 'air' | 'ship';
  vehicle_no: string | null;
  transporter_id: string | null;
  transporter_name: string | null;
  ewb_no: string | null;
  ewb_date: string | null;
  not_needed_reason: string | null;
  updated_by_name?: string;
  updated_at?: string;
}

const MODE_CODE = { road: '1', rail: '2', air: '3', ship: '4' } as const;

async function loadInvoice(q: Q, id: number) {
  const [inv] = await q<{ id: number; number: string; invoice_date: string; status: string; customer_name: string | null; customer_gstin: string | null; customer_address: string | null; customer_id: number | null; supply_type: 'intra' | 'inter'; place_of_supply: string; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number }[]>`
    select id, number, invoice_date, status, customer_name, customer_gstin, customer_address, customer_id, supply_type, place_of_supply,
           taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise
    from sales_invoices where id = ${id}`;
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  return inv;
}

export async function getTransport(q: Q, invoiceId: number) {
  const [t] = await q<TransportRow[]>`
    select t.to_place, t.to_pincode, t.distance_km, t.trans_mode, t.vehicle_no, t.transporter_id, t.transporter_name, t.ewb_no, t.ewb_date,
           t.not_needed_reason, u.name as updated_by_name, t.updated_at
    from invoice_transport t join users u on u.id = t.updated_by where t.invoice_id = ${invoiceId}`;
  return t ?? null;
}

/** What the e-way bill screen shows: is one needed, what is filled in, what is missing. */
export async function ewayStatus(q: Q, ctx: Ctx, invoiceId: number) {
  requirePerm(ctx, 'billing.create');
  const inv = await loadInvoice(q, invoiceId);
  const transport = await getTransport(q, invoiceId);
  const valuePaise = ewayValuePaise({ taxablePaise: inv.taxable_paise, cgstPaise: inv.cgst_paise, sgstPaise: inv.sgst_paise, igstPaise: inv.igst_paise });
  const missing = await missingFields(q, inv, transport);
  return { invoiceId, number: inv.number, valuePaise, needed: inv.status === 'posted' && valuePaise > 0 && ewayNeeded({ taxablePaise: inv.taxable_paise, cgstPaise: inv.cgst_paise, sgstPaise: inv.sgst_paise, igstPaise: inv.igst_paise }), transport, missing };
}

async function missingFields(q: Q, inv: Awaited<ReturnType<typeof loadInvoice>>, t: TransportRow | null) {
  const s = await getSettings(q);
  const missing: string[] = [];
  if (!isValidGstin(s.storeGstin)) missing.push("The shop's GSTIN (Settings → Shop & billing)");
  if (!/^[1-9]\d{5}$/.test(s.storePincode)) missing.push("The shop's PIN code (Settings → Shop & billing)");
  if (!t?.to_pincode) missing.push('Delivery PIN code');
  if (!t?.to_place) missing.push('Delivery town / place');
  if (t?.distance_km == null) missing.push('Distance in km');
  if ((t?.trans_mode ?? 'road') === 'road' && !t?.vehicle_no && !t?.transporter_id) missing.push('Vehicle number (or the transporter ID, for Part B later)');
  const [noHsn] = await q<{ n: number }[]>`select count(*)::int as n from sales_invoice_lines where invoice_id = ${inv.id} and coalesce(hsn, '') = ''`;
  if (noHsn!.n) missing.push(`HSN code on ${noHsn!.n} item${noHsn!.n > 1 ? 's' : ''} (Inventory)`);
  return missing;
}

export async function saveTransport(sql: Sql, ctx: Ctx, invoiceId: number, input: TransportInput) {
  requirePerm(ctx, 'billing.create');
  const inv = await loadInvoice(sql, invoiceId);
  if (inv.status !== 'posted') throw new AppError(400, 'CANCELLED', 'This bill is cancelled');
  const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  const toPincode = clean(input.toPincode);
  if (toPincode && !/^[1-9]\d{5}$/.test(toPincode)) throw new AppError(400, 'BAD_PIN', 'PIN code is 6 digits');
  const vehicle = clean(input.vehicleNo) ? normalizeVehicleNo(input.vehicleNo!) : null;
  if (vehicle && !isValidVehicleNo(vehicle)) throw new AppError(400, 'BAD_VEHICLE', 'Vehicle number looks wrong — e.g. AP39AB1234');
  const transporterId = clean(input.transporterId)?.toUpperCase() ?? null;
  if (transporterId && !/^[0-9A-Z]{15}$/.test(transporterId)) throw new AppError(400, 'BAD_TRANSPORTER', 'Transporter ID is 15 characters (their GSTIN or TRANSIN)');
  const ewbNo = clean(input.ewbNo)?.replace(/\s/g, '') ?? null;
  if (ewbNo && !/^\d{12}$/.test(ewbNo)) throw new AppError(400, 'BAD_EWB', 'E-way bill number is 12 digits');
  const ewbDateV = clean(input.ewbDate);
  if (ewbDateV && !/^\d{4}-\d{2}-\d{2}$/.test(ewbDateV)) throw new AppError(400, 'BAD_DATE', 'Enter the e-way bill date');
  const distance = input.distanceKm == null ? null : Math.round(input.distanceKm);
  if (distance != null && (distance < 0 || distance > 4000)) throw new AppError(400, 'BAD_DISTANCE', 'Distance must be 0–4000 km');
  const reason = clean(input.notNeededReason);

  await sql`
    insert into invoice_transport (invoice_id, to_place, to_pincode, distance_km, trans_mode, vehicle_no, transporter_id, transporter_name, ewb_no, ewb_date, not_needed_reason, updated_by, updated_at)
    values (${invoiceId}, ${clean(input.toPlace)}, ${toPincode}, ${distance}, ${input.transMode ?? 'road'}, ${vehicle}, ${transporterId}, ${clean(input.transporterName)},
            ${ewbNo}, ${ewbNo ? (ewbDateV ?? inv.invoice_date) : null}, ${reason}, ${ctx.userId}, now())
    on conflict (invoice_id) do update set
      to_place = excluded.to_place, to_pincode = excluded.to_pincode, distance_km = excluded.distance_km, trans_mode = excluded.trans_mode,
      vehicle_no = excluded.vehicle_no, transporter_id = excluded.transporter_id, transporter_name = excluded.transporter_name,
      ewb_no = excluded.ewb_no, ewb_date = excluded.ewb_date, not_needed_reason = excluded.not_needed_reason,
      updated_by = excluded.updated_by, updated_at = now()`;
  await audit(sql, ctx, 'invoice.transport', { entity: 'sales_invoice', entityId: invoiceId, details: { number: inv.number, ewbNo, vehicle, notNeeded: reason } });
  return ewayStatus(sql, ctx, invoiceId);
}

/**
 * The e-way bill portal's bulk-upload JSON ("version 1.0.0621" format) for one bill. Upload it on
 * ewaybillgst.gov.in → e-Waybill → Generate Bulk. Check the result on the portal before printing.
 */
export async function ewayJson(q: Q, ctx: Ctx, invoiceId: number) {
  requirePerm(ctx, 'billing.create');
  const inv = await loadInvoice(q, invoiceId);
  if (inv.status !== 'posted') throw new AppError(400, 'CANCELLED', 'This bill is cancelled');
  const t = await getTransport(q, invoiceId);
  const missing = await missingFields(q, inv, t);
  if (missing.length) throw new AppError(400, 'EWAY_INCOMPLETE', `Fill these in first: ${missing.join('; ')}`, { missing });
  const s = await getSettings(q);
  const lines = await q<{ product_name: string; hsn: string; base_qty_milli: number; unit_code: string; taxable_paise: number; gst_rate_bp: number }[]>`
    select l.product_name, l.hsn, l.base_qty_milli, p.unit_code, l.taxable_paise, l.gst_rate_bp
    from sales_invoice_lines l join products p on p.id = l.product_id where l.invoice_id = ${invoiceId} order by l.line_no`;
  const rs = (p: number) => Math.round(p) / 100;
  const inter = inv.supply_type === 'inter';
  const toState = Number(inv.customer_gstin ? inv.customer_gstin.slice(0, 2) : inv.place_of_supply);
  const addr = (a: string | null) => {
    const parts = (a ?? '').replace(/\s+/g, ' ').trim();
    return [parts.slice(0, 120), parts.slice(120, 240)];
  };
  const [from1, from2] = addr(s.storeAddress);
  const [to1, to2] = addr(inv.customer_address);
  const bill = {
    userGstin: s.storeGstin,
    supplyType: 'O',
    subSupplyType: 1,
    subSupplyDesc: '',
    docType: 'INV',
    docNo: inv.number,
    docDate: ewbDate(inv.invoice_date),
    fromGstin: s.storeGstin,
    fromTrdName: s.storeName,
    fromAddr1: from1,
    fromAddr2: from2,
    fromPlace: s.storePlace,
    fromPincode: Number(s.storePincode),
    actFromStateCode: Number(s.stateCode),
    fromStateCode: Number(s.stateCode),
    toGstin: inv.customer_gstin || 'URP',
    toTrdName: inv.customer_name ?? '',
    toAddr1: to1,
    toAddr2: to2,
    toPlace: t!.to_place,
    toPincode: Number(t!.to_pincode),
    actToStateCode: Number(inv.place_of_supply),
    toStateCode: toState,
    transactionType: 1,
    totalValue: rs(inv.taxable_paise),
    cgstValue: rs(inv.cgst_paise),
    sgstValue: rs(inv.sgst_paise),
    igstValue: rs(inv.igst_paise),
    cessValue: 0,
    cessNonAdvolValue: 0,
    otherValue: rs(inv.total_paise - inv.taxable_paise - inv.cgst_paise - inv.sgst_paise - inv.igst_paise),
    totInvValue: rs(inv.total_paise),
    transporterId: t!.transporter_id ?? '',
    transporterName: t!.transporter_name ?? '',
    transDocNo: '',
    transMode: MODE_CODE[t!.trans_mode],
    transDistance: String(t!.distance_km),
    transDocDate: '',
    vehicleNo: t!.vehicle_no ?? '',
    vehicleType: 'R',
    itemList: lines.map((l, i) => ({
      itemNo: i + 1,
      productName: l.product_name.slice(0, 100),
      productDesc: l.product_name.slice(0, 100),
      hsnCode: Number(l.hsn.replace(/\D/g, '')),
      quantity: l.base_qty_milli / 1000,
      qtyUnit: uqcFor(l.unit_code),
      taxableAmount: rs(l.taxable_paise),
      sgstRate: inter ? 0 : l.gst_rate_bp / 200,
      cgstRate: inter ? 0 : l.gst_rate_bp / 200,
      igstRate: inter ? l.gst_rate_bp / 100 : 0,
      cessRate: 0,
      cessNonAdvol: 0,
    })),
  };
  return { version: '1.0.0621', billLists: [bill] };
}

/** Big bills in a period still without an e-way bill number (and not marked "not needed"). */
export async function ewayPending(q: Q, ctx: Ctx, r: { from: string; to: string }) {
  requirePerm(ctx, 'billing.create');
  const rows = await q<{ id: number; number: string; invoice_date: string; customer_name: string | null; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; ewb_no: string | null; not_needed_reason: string | null; vehicle_no: string | null }[]>`
    select si.id, si.number, si.invoice_date, si.customer_name, si.taxable_paise, si.cgst_paise, si.sgst_paise, si.igst_paise, si.total_paise,
           t.ewb_no, t.not_needed_reason, t.vehicle_no
    from sales_invoices si left join invoice_transport t on t.invoice_id = si.id
    where si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}
      and si.taxable_paise + si.cgst_paise + si.sgst_paise + si.igst_paise > ${EWAY_THRESHOLD_PAISE}
    order by si.id desc`;
  return rows.map((x) => ({ ...x, state: x.ewb_no ? 'done' : x.not_needed_reason ? 'not_needed' : 'pending' }));
}

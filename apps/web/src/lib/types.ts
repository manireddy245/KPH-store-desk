export interface ProductRow {
  id: number;
  sku: string;
  name: string;
  category_id: number | null;
  category_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  unit_code: string;
  hsn: string | null;
  gst_rate_bp: number;
  sale_price_paise: number;
  price_includes_tax: boolean;
  cost_price_paise?: number | null;
  contents_milli: number | null;
  contents_unit: string | null;
  units: ProductUnit[];
  mrp_paise: number | null;
  reorder_level_milli: number | null;
  max_disc_type: 'pct' | 'amt' | null;
  max_disc_value: number | null;
  cat_disc_type: 'pct' | 'amt' | null;
  cat_disc_value: number | null;
  active: boolean;
  qty_milli: number;
  stock_status: 'ok' | 'low' | 'out';
}

export interface ProductUnit {
  unit_code: string;
  factor_num: number;
  factor_den: number;
  for_sale: boolean;
  for_purchase: boolean;
  price_paise: number | null;
}

export interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  gstin: string | null;
  state_code: string;
  address: string | null;
  credit_limit_paise: number | null;
  notes: string | null;
  active: boolean;
  balance_paise: number;
  total_purchases_paise: number;
  bill_count: number;
  last_bill_at: string | null;
}

export interface SupplierRow {
  id: number;
  name: string;
  phone: string | null;
  category: string | null;
  gstin: string | null;
  address: string | null;
  lead_time_days: number | null;
  active: boolean;
  payable_paise: number;
}

export interface InvoiceListRow {
  id: number;
  number: string;
  invoice_date: string;
  at: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  payment_mode: string;
  total_paise: number;
  discount_paise: number;
  status: 'posted' | 'cancelled';
  user_name: string;
  device_name: string | null;
  item_count: number;
}

export interface InvoiceLine {
  line_no: number;
  product_id: number;
  product_name: string;
  sku: string;
  hsn: string | null;
  unit_code: string;
  qty_milli: number;
  rate_paise: number;
  discount_bp: number;
  gross_paise: number;
  discount_paise: number;
  taxable_paise: number;
  gst_rate_bp: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
  amount_paise: number;
  rate_mode: 'excl' | 'incl';
  base_qty_milli: number;
  returned_qty_milli: number;
  id: number;
  cost_price_paise?: number | null;
}

export interface InvoiceFull {
  id: number;
  number: string;
  invoice_date: string;
  at: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_gstin: string | null;
  customer_address: string | null;
  place_of_supply: string;
  supply_type: 'intra' | 'inter';
  credit_notes: { id: number; number: string; note_date: string; total_paise: number; status: string }[];
  payment_mode: string;
  gross_paise: number;
  discount_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  round_off_paise: number;
  total_paise: number;
  status: 'posted' | 'cancelled';
  cancel_reason: string | null;
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  cancel_approved_by_name: string | null;
  notes: string | null;
  user_name: string;
  device_name: string | null;
  lines: InvoiceLine[];
  store: { name: string; address: string; phone: string; gstin: string; stateCode: string; stateName: string; terms: string; labels: 'en' | 'te-en'; place?: string; pincode?: string };
  transport?: Transport | null;
}

export interface Category {
  id: number;
  name: string;
  max_disc_type: 'pct' | 'amt' | null;
  max_disc_value: number | null;
  default_gst_bp: number;
  active: boolean;
  product_count: number;
}

// ------------------------------------------------------------------ assistant

export interface AssistantScan {
  scanId: number;
  pageCount: number;
  supplier: { name: string | null; gstin: string | null; matchedId: number | null; matchedBy: string };
  invoice: { number: string | null; date: string | null; isInterstate: boolean | null };
  lines: {
    description: string;
    hsn: string | null;
    qtyMilli: number | null;
    billUnit: string | null;
    taxablePaise: number | null;
    gstRateBp: number | null;
    match: { kind: 'remembered' | 'sku' | 'name' | 'none'; productId: number | null };
    lastCostPaise: number | null;
    warnings: string[];
  }[];
  freightPaise: number | null;
  grandTotalPaise: number | null;
  notes: string | null;
  duplicateOf: string | null;
}

type CardBase = { status: 'proposed' | 'done' | 'dismissed'; result?: { label: string; link?: string } };
export type AssistantBillCard = CardBase & {
  kind: 'bill';
  customer: Pick<CustomerRow, 'id' | 'name' | 'phone' | 'address' | 'gstin' | 'balance_paise' | 'credit_limit_paise'> | null;
  walkinName: string | null;
  mode: 'cash' | 'upi' | 'card' | 'credit';
  lines: { productId: number; name: string; unitCode: string; qtyMilli: number; stockMilli: number }[];
  warnings: string[];
};
export type AssistantCard =
  | (CardBase & { kind: 'purchase'; scan: AssistantScan })
  | AssistantBillCard
  | (CardBase & { kind: 'stock_adjust'; productId: number; name: string; unitCode: string; currentMilli: number; deltaMilli: number; reason: string })
  | (CardBase & { kind: 'customer'; name: string; phone: string | null; gstin: string | null; address: string | null; warnings: string[] })
  | (CardBase & { kind: 'payment'; customerId: number; name: string; balancePaise: number; amountPaise: number; mode: 'cash' | 'upi' | 'card' | 'bank' | 'cheque' });

export interface AssistantMessage {
  id: number;
  at: string;
  role: 'user' | 'assistant';
  text: string;
  heard: string | null;
  files: { kind: 'image' | 'pdf' | 'audio'; mimeType: string; file: string }[];
  cards: AssistantCard[];
  error: string | null;
}

export interface Transport {
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

export interface EwayStatus {
  invoiceId: number;
  number: string;
  valuePaise: number;
  needed: boolean;
  transport: Transport | null;
  missing: string[];
}

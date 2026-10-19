-- Phase 6A: rate board, quotations, deliveries, cement batches.

-- Products that appear on the daily rate board (cement, steel…) and products whose stock age is tracked.
alter table products add column on_rate_board boolean not null default false;
alter table products add column track_batches boolean not null default false;
update products p set on_rate_board = true, track_batches = (c.name ~* 'cement')
from categories c where c.id = p.category_id and c.name ~* '(cement|steel|tmt)';

-- Batch / packing date as printed on the bags, recorded at purchase.
alter table purchase_lines disable trigger purchase_lines_permanent;
alter table purchase_lines add column batch_code text;
alter table purchase_lines add column packed_on date;
alter table purchase_lines enable trigger purchase_lines_permanent;

-- Quotations / estimates. Not accounting documents: editable while open.
create table quotations (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  quote_date date not null,
  valid_until date not null,
  customer_id int references customers(id),
  customer_name text,
  customer_phone text,
  customer_address text,
  partner_id int references partners(id),
  site text,
  template text check (template in ('full_house')),
  price_mode text not null default 'excl' check (price_mode in ('excl', 'incl')),
  place_of_supply text not null default '37',
  gross_paise bigint not null default 0,
  discount_paise bigint not null default 0,
  taxable_paise bigint not null default 0,
  cgst_paise bigint not null default 0,
  sgst_paise bigint not null default 0,
  igst_paise bigint not null default 0,
  round_off_paise bigint not null default 0,
  total_paise bigint not null default 0,
  status text not null default 'open' check (status in ('open', 'converted', 'cancelled')),
  converted_invoice_id bigint references sales_invoices(id),
  notes text,
  terms text,
  user_id int not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fy_start, seq)
);

create table quotation_lines (
  id bigserial primary key,
  quotation_id bigint not null references quotations(id),
  line_no int not null,
  stage text,
  product_id int not null references products(id),
  product_name text not null,
  unit_code text not null,
  qty_milli bigint not null check (qty_milli > 0),
  rate_paise bigint not null,
  rate_mode text not null default 'excl' check (rate_mode in ('excl', 'incl')),
  discount_bp int not null default 0,
  gst_rate_bp int not null,
  taxable_paise bigint not null,
  total_paise bigint not null,
  amount_paise bigint not null,
  unique (quotation_id, line_no)
);

-- Delivery challans: one bill can go out in several trips.
create table deliveries (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  invoice_id bigint not null references sales_invoices(id),
  delivery_date date not null,
  site_address text,
  contact_phone text,
  vehicle_no text,
  driver_name text,
  driver_phone text,
  charge_paise bigint not null default 0 check (charge_paise >= 0),
  status text not null default 'pending' check (status in ('pending', 'out', 'delivered', 'cancelled')),
  out_at timestamptz,
  delivered_at timestamptz,
  received_by text,
  notes text,
  user_id int not null references users(id),
  created_at timestamptz not null default now(),
  unique (fy_start, seq)
);
create index deliveries_date on deliveries (delivery_date, status);

create table delivery_lines (
  id bigserial primary key,
  delivery_id bigint not null references deliveries(id),
  invoice_line_id bigint not null references sales_invoice_lines(id),
  qty_milli bigint not null check (qty_milli > 0),
  unique (delivery_id, invoice_line_id)
);

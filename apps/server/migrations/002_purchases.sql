-- Purchases (supplier bills), the invoice scanner, and remembered product matches.

-- One row per scan attempt: the photos/PDF are kept on disk for checking later.
create table purchase_scans (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id int references users(id),
  device_id int references devices(id),
  model text,
  page_files text[] not null default '{}',
  page_hashes text[] not null default '{}',
  raw jsonb,
  status text not null default 'read' check (status in ('read', 'failed', 'used')),
  error text,
  purchase_id bigint
);

create table purchase_invoices (
  id bigserial primary key,
  number text not null unique,           -- our own number, e.g. PUR/26-27/000001
  fy_start int not null,
  seq int not null,
  supplier_id int not null references suppliers(id),
  supplier_invoice_no text not null,
  supplier_invoice_date date not null,
  at timestamptz not null default now(),
  supply_type text not null default 'intra' check (supply_type in ('intra', 'inter')),
  taxable_paise bigint not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  freight_paise bigint not null default 0 check (freight_paise >= 0),
  round_off_paise bigint not null default 0,
  total_paise bigint not null,
  source text not null default 'manual' check (source in ('manual', 'scan')),
  scan_id bigint references purchase_scans(id),
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by int references users(id),
  cancel_approved_by int references users(id),
  voucher_id bigint references vouchers(id),
  cancel_voucher_id bigint references vouchers(id),
  notes text,
  user_id int not null references users(id),
  device_id int references devices(id),
  client_ref uuid unique,
  unique (fy_start, seq),
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + freight_paise + round_off_paise)
);
-- The same supplier bill can't be entered twice (unless the first entry was cancelled).
create unique index purchase_invoices_supplier_bill_uq on purchase_invoices (supplier_id, lower(supplier_invoice_no)) where status = 'posted';
create index purchase_invoices_date_idx on purchase_invoices (supplier_invoice_date);

create table purchase_lines (
  id bigserial primary key,
  purchase_id bigint not null references purchase_invoices(id),
  line_no int not null,
  product_id int not null references products(id),
  description text,            -- the item text as printed on the supplier's bill
  hsn text,
  qty_milli bigint not null check (qty_milli > 0),
  unit_code text not null,
  unit_cost_paise bigint not null,
  taxable_paise bigint not null check (taxable_paise >= 0),
  gst_rate_bp int not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null,
  unique (purchase_id, line_no)
);
create index purchase_lines_product_idx on purchase_lines (product_id);

-- "This supplier calls it X; we call it product Y" — learnt from each saved purchase.
create table product_aliases (
  id serial primary key,
  supplier_id int references suppliers(id),
  alias text not null,
  product_id int not null references products(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create unique index product_aliases_uq on product_aliases (coalesce(supplier_id, 0), alias);

create trigger purchase_lines_permanent before update or delete on purchase_lines
  for each row execute function kph_forbid_change();
create trigger purchase_invoices_only_cancel before update or delete on purchase_invoices
  for each row execute function kph_only_cancel();

insert into ledgers (name, group_id, system_code)
select l.name, g.id, l.code from (values
  ('Purchases', 'Purchase Accounts', 'purchases'),
  ('Input CGST', 'Duties & Taxes', 'input_cgst'),
  ('Input SGST', 'Duties & Taxes', 'input_sgst'),
  ('Input IGST', 'Duties & Taxes', 'input_igst'),
  ('Freight Inward', 'Direct Expenses', 'freight_in')
) as l(name, grp, code) join ledger_groups g on g.name = l.grp;

-- Phase 2A: units and conversions, prices including GST, sales/purchase returns, GST month lock.

-- ---------------------------------------------------------------- units
-- Extra units a product can be sold/bought in. 1 unit = factor_num / factor_den base units.
create table product_units (
  id serial primary key,
  product_id int not null references products(id),
  unit_code text not null references units(code),
  factor_num bigint not null check (factor_num > 0),
  factor_den bigint not null default 1 check (factor_den > 0),
  for_sale boolean not null default true,
  for_purchase boolean not null default true,
  price_paise bigint check (price_paise >= 0),   -- own selling price per this unit (same incl/excl mode as the product); null = base price × factor
  unique (product_id, unit_code)
);

-- Pack contents, for reports such as "litres of Birla Opus sold" (paint packs stay separate products).
alter table products add column contents_milli bigint check (contents_milli > 0);
alter table products add column contents_unit text;


-- ---------------------------------------------------------------- sales lines: mode, unit sold, base qty
alter table sales_invoice_lines disable trigger sales_invoice_lines_permanent;
alter table sales_invoice_lines add column rate_mode text not null default 'excl' check (rate_mode in ('excl', 'incl'));
alter table sales_invoice_lines add column factor_num bigint not null default 1;
alter table sales_invoice_lines add column factor_den bigint not null default 1;
alter table sales_invoice_lines add column base_qty_milli bigint;
alter table sales_invoice_lines add column amount_paise bigint;
update sales_invoice_lines set base_qty_milli = qty_milli, amount_paise = total_paise;
alter table sales_invoice_lines alter column base_qty_milli set not null;
alter table sales_invoice_lines alter column amount_paise set not null;
alter table sales_invoice_lines enable trigger sales_invoice_lines_permanent;


-- ---------------------------------------------------------------- purchase lines: unit bought, amount mode
alter table purchase_lines disable trigger purchase_lines_permanent;
alter table purchase_lines add column bill_unit_code text;
alter table purchase_lines add column bill_qty_milli bigint;
alter table purchase_lines add column amount_mode text not null default 'excl' check (amount_mode in ('excl', 'incl'));
update purchase_lines set bill_unit_code = unit_code, bill_qty_milli = qty_milli;
alter table purchase_lines enable trigger purchase_lines_permanent;

-- ---------------------------------------------------------------- sales returns (credit notes)
create table credit_notes (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  note_date date not null,
  at timestamptz not null default now(),
  invoice_id bigint not null references sales_invoices(id),
  customer_id int references customers(id),
  reason text not null check (length(trim(reason)) >= 3),
  refund_mode text not null check (refund_mode in ('account', 'cash', 'upi', 'card', 'bank')),
  supply_type text not null check (supply_type in ('intra', 'inter')),
  taxable_paise bigint not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  round_off_paise bigint not null,
  total_paise bigint not null,
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by int references users(id),
  cancel_approved_by int references users(id),
  voucher_id bigint references vouchers(id),
  cancel_voucher_id bigint references vouchers(id),
  approved_by int references users(id),
  user_id int not null references users(id),
  device_id int references devices(id),
  client_ref uuid unique,
  unique (fy_start, seq),
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + round_off_paise),
  check (refund_mode <> 'account' or customer_id is not null)
);
create index credit_notes_invoice_idx on credit_notes (invoice_id);

create table credit_note_lines (
  id bigserial primary key,
  credit_note_id bigint not null references credit_notes(id),
  line_no int not null,
  invoice_line_id bigint not null references sales_invoice_lines(id),
  product_id int not null references products(id),
  qty_milli bigint not null check (qty_milli > 0),       -- in the unit it was sold in
  base_qty_milli bigint not null check (base_qty_milli > 0),
  restocked boolean not null,
  taxable_paise bigint not null,
  gst_rate_bp int not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null,
  unique (credit_note_id, line_no)
);
create index credit_note_lines_invoice_line_idx on credit_note_lines (invoice_line_id);

-- ---------------------------------------------------------------- purchase returns (debit notes)
create table debit_notes (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  note_date date not null,
  at timestamptz not null default now(),
  purchase_id bigint not null references purchase_invoices(id),
  supplier_id int not null references suppliers(id),
  reason text not null check (length(trim(reason)) >= 3),
  supply_type text not null check (supply_type in ('intra', 'inter')),
  taxable_paise bigint not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null,
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by int references users(id),
  cancel_approved_by int references users(id),
  voucher_id bigint references vouchers(id),
  cancel_voucher_id bigint references vouchers(id),
  user_id int not null references users(id),
  device_id int references devices(id),
  client_ref uuid unique,
  unique (fy_start, seq),
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise)
);

create table debit_note_lines (
  id bigserial primary key,
  debit_note_id bigint not null references debit_notes(id),
  line_no int not null,
  purchase_line_id bigint not null references purchase_lines(id),
  product_id int not null references products(id),
  base_qty_milli bigint not null check (base_qty_milli > 0),
  taxable_paise bigint not null,
  gst_rate_bp int not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null,
  unique (debit_note_id, line_no)
);

create trigger credit_note_lines_permanent before update or delete on credit_note_lines for each row execute function kph_forbid_change();
create trigger debit_note_lines_permanent before update or delete on debit_note_lines for each row execute function kph_forbid_change();
create trigger credit_notes_only_cancel before update or delete on credit_notes for each row execute function kph_only_cancel();
create trigger debit_notes_only_cancel before update or delete on debit_notes for each row execute function kph_only_cancel();

-- ---------------------------------------------------------------- GST month lock
-- Once a month's GSTR-1 is filed, its bills can no longer be cancelled (use a credit note).
create table gst_periods (
  month text primary key check (month ~ '^\d{4}-\d{2}$'),
  filed_at timestamptz,
  filed_by int references users(id),
  note text
);

insert into ledgers (name, group_id, system_code)
select l.name, g.id, l.code from (values
  ('Sales Returns', 'Sales Accounts', 'sales_returns'),
  ('Purchase Returns', 'Purchase Accounts', 'purchase_returns')
) as l(name, grp, code) join ledger_groups g on g.name = l.grp;

update roles set permissions = array_append(permissions, 'returns.create') where id = 'admin' and not ('returns.create' = any(permissions));

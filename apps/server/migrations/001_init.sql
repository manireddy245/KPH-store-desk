-- Kanakapatnam Store Desk — Phase 1 schema
-- Money: bigint paise. Quantity: bigint thousandths of the base unit (milli). Rates: int basis points.

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- people & security
create table roles (
  id text primary key,
  name text not null,
  permissions text[] not null default '{}',
  system boolean not null default false
);

create table users (
  id serial primary key,
  name text not null,
  role_id text not null references roles(id),
  pin_hash text not null,
  active boolean not null default true,
  discount_cap_bp int check (discount_cap_bp between 0 and 10000),
  language text not null default 'en',
  failed_pin_count int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
create unique index users_name_uq on users (lower(name));

create table devices (
  id serial primary key,
  name text not null,
  token_hash text not null unique,
  status text not null check (status in ('pending', 'approved', 'revoked')),
  user_agent text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by int references users(id),
  last_seen_at timestamptz
);

create table sessions (
  token_hash text primary key,
  user_id int not null references users(id),
  device_id int not null references devices(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz
);

-- Admin PIN approvals for things staff can't do themselves. Single use, short-lived.
create table overrides (
  id serial primary key,
  token_hash text not null unique,
  permission text not null,
  approved_by int not null references users(id),
  requested_by int not null references users(id),
  device_id int references devices(id),
  context jsonb not null default '{}',
  reason text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id int references users(id),
  device_id int references devices(id),
  action text not null,
  entity text,
  entity_id text,
  details jsonb not null default '{}',
  reason text,
  approved_by int references users(id)
);
create index audit_log_at_idx on audit_log (at desc);
create index audit_log_action_idx on audit_log (action, at desc);

-- ---------------------------------------------------------------- products & stock
create table units (
  code text primary key,
  name text not null
);

create table categories (
  id serial primary key,
  name text not null,
  max_disc_type text check (max_disc_type in ('pct', 'amt')),
  max_disc_value bigint check (max_disc_value >= 0),
  default_gst_bp int not null default 1800 check (default_gst_bp between 0 and 10000),
  active boolean not null default true,
  check ((max_disc_type is null) = (max_disc_value is null))
);
create unique index categories_name_uq on categories (lower(name));

create table brands (
  id serial primary key,
  name text not null
);
create unique index brands_name_uq on brands (lower(name));

create table products (
  id serial primary key,
  sku text not null,
  name text not null,
  category_id int references categories(id),
  brand_id int references brands(id),
  unit_code text not null references units(code),
  hsn text,
  gst_rate_bp int not null default 1800 check (gst_rate_bp between 0 and 10000),
  sale_price_paise bigint not null default 0 check (sale_price_paise >= 0),
  price_includes_tax boolean not null default false,
  cost_price_paise bigint check (cost_price_paise >= 0),
  mrp_paise bigint check (mrp_paise >= 0),
  reorder_level_milli bigint check (reorder_level_milli >= 0),
  max_disc_type text check (max_disc_type in ('pct', 'amt')),
  max_disc_value bigint check (max_disc_value >= 0),
  barcode text, -- reserved for a later version
  active boolean not null default true,
  is_sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((max_disc_type is null) = (max_disc_value is null))
);
create unique index products_sku_uq on products (lower(sku));
create index products_name_idx on products (lower(name));

create table price_history (
  id bigserial primary key,
  product_id int not null references products(id),
  field text not null,
  old_value bigint,
  new_value bigint,
  user_id int references users(id),
  device_id int references devices(id),
  at timestamptz not null default now()
);

-- The stock ledger. Every change in quantity is a row here; rows are never edited or removed.
create table stock_movements (
  id bigserial primary key,
  product_id int not null references products(id),
  qty_milli bigint not null check (qty_milli <> 0),
  kind text not null check (kind in ('opening', 'purchase', 'sale', 'sale_cancel', 'sale_return',
                                     'purchase_return', 'adjustment', 'audit', 'transfer')),
  ref_type text,
  ref_id bigint,
  unit_cost_paise bigint,
  reason text,
  user_id int references users(id),
  device_id int references devices(id),
  at timestamptz not null default now()
);
create index stock_movements_product_idx on stock_movements (product_id, at);

-- Current quantity: maintained ONLY by the trigger below, from stock_movements.
create table stock_balances (
  product_id int primary key references products(id),
  qty_milli bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- accounts (double entry)
create table ledger_groups (
  id serial primary key,
  name text not null unique,
  nature text not null check (nature in ('asset', 'liability', 'income', 'expense')),
  parent_id int references ledger_groups(id)
);

create table ledgers (
  id serial primary key,
  name text not null,
  group_id int not null references ledger_groups(id),
  system_code text unique,
  party_type text check (party_type in ('customer', 'supplier')),
  party_id int,
  opening_dr_paise bigint not null default 0, -- positive = debit (they owe us), negative = credit
  active boolean not null default true
);

create table vouchers (
  id bigserial primary key,
  vtype text not null check (vtype in ('sales', 'receipt', 'payment', 'purchase', 'journal', 'contra',
                                       'expense', 'credit_note', 'debit_note', 'reversal')),
  vdate date not null,
  narration text,
  ref_type text,
  ref_id bigint,
  reverses_id bigint references vouchers(id),
  user_id int references users(id),
  device_id int references devices(id),
  created_at timestamptz not null default now()
);

create table voucher_lines (
  id bigserial primary key,
  voucher_id bigint not null references vouchers(id),
  ledger_id int not null references ledgers(id),
  dr_paise bigint not null default 0 check (dr_paise >= 0),
  cr_paise bigint not null default 0 check (cr_paise >= 0),
  check ((dr_paise = 0) <> (cr_paise = 0))
);
create index voucher_lines_ledger_idx on voucher_lines (ledger_id);
create index voucher_lines_voucher_idx on voucher_lines (voucher_id);

-- Gapless numbering per document type per financial year.
create table doc_sequences (
  doc_type text not null,
  fy_start int not null,
  next_seq int not null,
  primary key (doc_type, fy_start)
);

-- ---------------------------------------------------------------- parties
create table customers (
  id serial primary key,
  name text not null,
  phone text,
  gstin text,
  address text,
  state_code text not null default '37', -- Andhra Pradesh
  credit_limit_paise bigint check (credit_limit_paise >= 0),
  ledger_id int references ledgers(id),
  notes text,
  active boolean not null default true,
  is_sample boolean not null default false,
  created_at timestamptz not null default now()
);
create index customers_name_idx on customers (lower(name));
create index customers_phone_idx on customers (phone);

create table suppliers (
  id serial primary key,
  name text not null,
  phone text,
  category text,
  gstin text,
  address text,
  lead_time_days int check (lead_time_days >= 0),
  ledger_id int references ledgers(id),
  active boolean not null default true,
  is_sample boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- sales
create table sales_invoices (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  invoice_date date not null,
  at timestamptz not null default now(),
  customer_id int references customers(id),
  customer_name text,
  customer_phone text,
  customer_gstin text,
  customer_address text,
  supply_type text not null default 'intra' check (supply_type in ('intra', 'inter')),
  place_of_supply text not null default '37',
  payment_mode text not null check (payment_mode in ('cash', 'upi', 'card', 'credit')),
  gross_paise bigint not null,
  discount_paise bigint not null,
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
  notes text,
  user_id int not null references users(id),
  device_id int references devices(id),
  client_ref uuid unique,
  unique (fy_start, seq),
  check (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + round_off_paise),
  check (payment_mode <> 'credit' or customer_id is not null)
);
create index sales_invoices_date_idx on sales_invoices (invoice_date);
create index sales_invoices_customer_idx on sales_invoices (customer_id);

create table sales_invoice_lines (
  id bigserial primary key,
  invoice_id bigint not null references sales_invoices(id),
  line_no int not null,
  product_id int not null references products(id),
  product_name text not null,
  sku text not null,
  hsn text,
  unit_code text not null,
  qty_milli bigint not null check (qty_milli > 0),
  rate_paise bigint not null,
  discount_bp int not null,
  max_discount_bp int not null,
  gross_paise bigint not null,
  discount_paise bigint not null,
  taxable_paise bigint not null,
  gst_rate_bp int not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null,
  cost_price_paise bigint,
  override_id int references overrides(id),
  unique (invoice_id, line_no)
);
create index sales_invoice_lines_product_idx on sales_invoice_lines (product_id);

create table receipts (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  receipt_date date not null,
  at timestamptz not null default now(),
  customer_id int not null references customers(id),
  mode text not null check (mode in ('cash', 'upi', 'card', 'bank', 'cheque')),
  amount_paise bigint not null check (amount_paise > 0),
  reference text,
  notes text,
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by int references users(id),
  voucher_id bigint references vouchers(id),
  cancel_voucher_id bigint references vouchers(id),
  user_id int not null references users(id),
  device_id int references devices(id),
  client_ref uuid unique,
  unique (fy_start, seq)
);

-- Half-made bills, saved continuously so nothing is lost on lock, switch user or crash.
create table bill_drafts (
  device_id int not null references devices(id),
  user_id int not null references users(id),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (device_id, user_id)
);

create table backups_log (
  id serial primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('auto', 'manual', 'pre-restore')),
  file text,
  size_bytes bigint,
  ok boolean not null,
  error text
);

-- ================================================================ guards
-- These run inside PostgreSQL, so no app bug can break them.

create function kph_forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'Records in % are permanent: cancel or reverse them instead of editing or deleting', tg_table_name
    using errcode = 'P0001';
end $$;

create trigger stock_movements_permanent before update or delete on stock_movements
  for each row execute function kph_forbid_change();
create trigger vouchers_permanent before update or delete on vouchers
  for each row execute function kph_forbid_change();
create trigger voucher_lines_permanent before update or delete on voucher_lines
  for each row execute function kph_forbid_change();
create trigger audit_log_permanent before update or delete on audit_log
  for each row execute function kph_forbid_change();
create trigger sales_invoice_lines_permanent before update or delete on sales_invoice_lines
  for each row execute function kph_forbid_change();
create trigger price_history_permanent before update or delete on price_history
  for each row execute function kph_forbid_change();

-- Posted documents may only change from posted → cancelled, and nothing else about them may change.
create function kph_only_cancel() returns trigger language plpgsql as $$
declare
  allowed text[] := array['status', 'cancel_reason', 'cancelled_at', 'cancelled_by', 'cancel_approved_by', 'cancel_voucher_id'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Records in % are permanent: cancel them instead of deleting', tg_table_name using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - allowed) <> (to_jsonb(old) - allowed) then
    raise exception 'Posted % cannot be edited; cancel and re-create instead', tg_table_name using errcode = 'P0001';
  end if;
  if old.status = 'cancelled' then
    raise exception 'This document is already cancelled' using errcode = 'P0001';
  end if;
  if new.status = 'cancelled' and (new.cancel_reason is null or length(trim(new.cancel_reason)) < 3) then
    raise exception 'A reason is required to cancel' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger sales_invoices_only_cancel before update or delete on sales_invoices
  for each row execute function kph_only_cancel();
create trigger receipts_only_cancel before update or delete on receipts
  for each row execute function kph_only_cancel();

-- Stock balance follows the stock ledger automatically.
create function kph_apply_stock_movement() returns trigger language plpgsql security definer as $$
begin
  insert into stock_balances (product_id, qty_milli, updated_at)
  values (new.product_id, new.qty_milli, now())
  on conflict (product_id) do update
    set qty_milli = stock_balances.qty_milli + excluded.qty_milli, updated_at = now();
  return new;
end $$;

create trigger stock_movements_apply after insert on stock_movements
  for each row execute function kph_apply_stock_movement();

-- Every voucher must balance (total debit = total credit), checked at commit.
create function kph_check_voucher_balanced() returns trigger language plpgsql as $$
declare
  v_id bigint := new.voucher_id;
  dr bigint;
  cr bigint;
begin
  select coalesce(sum(dr_paise), 0), coalesce(sum(cr_paise), 0) into dr, cr from voucher_lines where voucher_id = v_id;
  if dr <> cr then
    raise exception 'Voucher % does not balance: debit % ≠ credit %', v_id, dr, cr using errcode = 'P0001';
  end if;
  return null;
end $$;

create constraint trigger voucher_lines_balanced after insert on voucher_lines
  deferrable initially deferred for each row execute function kph_check_voucher_balanced();

-- ================================================================ base data
insert into units (code, name) values
  ('pcs', 'Pieces'), ('nos', 'Numbers'), ('bag', 'Bags'), ('kg', 'Kilograms'), ('tonne', 'Tonnes'),
  ('ltr', 'Litres'), ('mtr', 'Metres'), ('ft', 'Feet'), ('coil', 'Coils'), ('box', 'Boxes'),
  ('set', 'Sets'), ('rod', 'Rods'), ('bundle', 'Bundles'), ('pkt', 'Packets'), ('sqft', 'Square feet'),
  ('bucket', 'Buckets'), ('tin', 'Tins'), ('length', 'Lengths');

insert into ledger_groups (name, nature) values
  ('Capital Account', 'liability'),
  ('Cash-in-Hand', 'asset'),
  ('Bank Accounts', 'asset'),
  ('Sundry Debtors', 'asset'),
  ('Sundry Creditors', 'liability'),
  ('Duties & Taxes', 'liability'),
  ('Sales Accounts', 'income'),
  ('Purchase Accounts', 'expense'),
  ('Direct Expenses', 'expense'),
  ('Indirect Expenses', 'expense'),
  ('Indirect Incomes', 'income'),
  ('Stock-in-Hand', 'asset'),
  ('Suspense A/c', 'liability');

insert into ledgers (name, group_id, system_code)
select l.name, g.id, l.code from (values
  ('Cash', 'Cash-in-Hand', 'cash'),
  ('UPI Collections', 'Bank Accounts', 'upi'),
  ('Card Collections', 'Bank Accounts', 'card'),
  ('Bank', 'Bank Accounts', 'bank'),
  ('Cheques in Hand', 'Bank Accounts', 'cheque'),
  ('Sales', 'Sales Accounts', 'sales'),
  ('Output CGST', 'Duties & Taxes', 'output_cgst'),
  ('Output SGST', 'Duties & Taxes', 'output_sgst'),
  ('Output IGST', 'Duties & Taxes', 'output_igst'),
  ('Round Off', 'Indirect Expenses', 'round_off')
) as l(name, grp, code) join ledger_groups g on g.name = l.grp;

insert into roles (id, name, permissions, system) values
  ('admin', 'Admin', array['billing.create','billing.discount_over_limit','billing.cancel','payments.receive',
     'customers.manage','suppliers.manage','products.manage','products.edit_price','products.view_cost',
     'stock.adjust','reports.view','activity.view','settings.manage','users.manage'], true),
  ('counter', 'Counter staff', array['billing.create','payments.receive','customers.manage'], true),
  ('stock', 'Stock staff', array['stock.adjust'], true);

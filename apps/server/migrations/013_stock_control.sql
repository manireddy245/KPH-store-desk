-- Phase 6B: stock audits, stock insights, purchase orders, day-end closing per counter.

-- Target days of stock to keep, per category (reorder suggestions).
alter table categories add column target_days int check (target_days between 1 and 180);

-- Physical stock count.
create table stock_audits (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  title text,
  category_id int references categories(id),
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  user_id int not null references users(id),
  closed_by int references users(id),
  unique (fy_start, seq)
);

create table stock_audit_lines (
  id bigserial primary key,
  audit_id bigint not null references stock_audits(id),
  product_id int not null references products(id),
  system_milli bigint not null,        -- what the books said when it was counted
  counted_milli bigint not null check (counted_milli >= 0),
  reason text check (reason in ('damaged', 'leakage', 'shortage', 'found', 'wrong entry', 'other')),
  note text,
  counted_by int not null references users(id),
  counted_at timestamptz not null default now(),
  adjusted boolean not null default false,
  unique (audit_id, product_id)
);

-- What the owner decided for a slow / dead item.
create table stock_decisions (
  id bigserial primary key,
  product_id int not null references products(id),
  action text not null check (action in ('dont_reorder', 'offer', 'tell_partners', 'return_to_supplier', 'keep')),
  note text,
  at timestamptz not null default now(),
  user_id int not null references users(id)
);
create index stock_decisions_product on stock_decisions (product_id, id desc);

-- Purchase orders (from the reorder list, edited before sending).
create table purchase_orders (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  supplier_id int not null references suppliers(id),
  status text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  expected_on date,
  notes text,
  user_id int not null references users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  closed_at timestamptz,
  unique (fy_start, seq)
);

create table purchase_order_lines (
  id bigserial primary key,
  po_id bigint not null references purchase_orders(id),
  product_id int not null references products(id),
  qty_milli bigint not null check (qty_milli > 0),   -- base units
  note text,
  unique (po_id, product_id)
);

-- Day-end closing for one counter (computer).
create table counter_closings (
  id bigserial primary key,
  close_date date not null,
  device_id int references devices(id),
  expected_cash_paise bigint not null,
  counted_cash_paise bigint not null check (counted_cash_paise >= 0),
  difference_paise bigint not null,
  summary jsonb not null,
  note text,
  user_id int not null references users(id),
  at timestamptz not null default now()
);
create index counter_closings_date on counter_closings (close_date, device_id);
create trigger counter_closings_permanent before update or delete on counter_closings for each row execute function kph_forbid_change();

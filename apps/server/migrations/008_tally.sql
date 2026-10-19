-- Tally export: our account name → the name used in the CA's Tally company, and a log of exports.
create table tally_names (
  ledger_id int primary key references ledgers(id),
  tally_name text not null check (length(trim(tally_name)) between 1 and 200),
  updated_by int not null references users(id),
  updated_at timestamptz not null default now()
);
create unique index tally_names_unique on tally_names (lower(tally_name));

create table tally_exports (
  id bigserial primary key,
  what text not null check (what in ('masters', 'stock_items', 'vouchers')),
  from_date date,
  to_date date,
  voucher_count int not null default 0,
  at timestamptz not null default now(),
  user_id int not null references users(id)
);

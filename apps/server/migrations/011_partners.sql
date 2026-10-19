-- Phase 5: painters, masons and other trade partners — kept apart from customers.

create table partner_types (
  id serial primary key,
  name text not null unique,
  active boolean not null default true,
  sort int not null default 0
);
insert into partner_types (name, sort) values ('Painter', 1), ('Mason', 2), ('Contractor', 3), ('Plumber', 4), ('Electrician', 5), ('Engineer', 6);

-- Reward rules per partner type: a % of the bill (before GST) or an amount per unit sold,
-- optionally only for one category. Rewards are in rupees (paise).
create table partner_reward_rules (
  id serial primary key,
  type_id int not null references partner_types(id),
  category_id int references categories(id),
  mode text not null check (mode in ('percent', 'per_unit')),
  -- percent: basis points of the line amount before GST; per_unit: paise per base unit (bag, ltr, rod…)
  value int not null check (value >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table partners (
  id serial primary key,
  name text not null,
  phone text,
  area text,
  type_id int not null references partner_types(id),
  notes text,
  joined_on date not null default current_date,
  active boolean not null default true,
  -- when the partner also buys on their own account
  customer_id int references customers(id),
  language text check (language in ('te', 'en')),
  is_sample boolean not null default false,
  created_at timestamptz not null default now()
);
create index partners_phone on partners (phone);

create table partner_sites (
  id serial primary key,
  partner_id int not null references partners(id),
  name text not null,
  address text,
  owner_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Which partner brought a bill (and for which site). One partner per bill.
create table invoice_partners (
  invoice_id bigint primary key references sales_invoices(id),
  partner_id int not null references partners(id),
  site_id int references partner_sites(id),
  tagged_by int not null references users(id),
  tagged_at timestamptz not null default now()
);
create index invoice_partners_partner on invoice_partners (partner_id);

-- Reward account: earned on bills (snapshot of the rules at the time), taken back on
-- returns / cancellations, paid out in cash (posted as an expense) or redeemed as gifts.
create table partner_rewards (
  id bigserial primary key,
  partner_id int not null references partners(id),
  kind text not null check (kind in ('earned', 'reversed', 'payout', 'redeemed', 'adjustment')),
  amount_paise bigint not null,   -- + adds to what we owe the partner, − reduces it
  invoice_id bigint references sales_invoices(id),
  credit_note_id bigint references credit_notes(id),
  money_entry_id bigint references money_entries(id),
  -- earned: reward per bill line {"lineId": paise}, so returns take back exactly what was given
  details jsonb not null default '{}',
  note text,
  at timestamptz not null default now(),
  user_id int not null references users(id)
);
create index partner_rewards_partner on partner_rewards (partner_id, id);
create trigger partner_rewards_permanent before update or delete on partner_rewards for each row execute function kph_forbid_change();

-- Dated notes: a timeline per partner, optionally about one bill or site.
create table partner_notes (
  id bigserial primary key,
  partner_id int not null references partners(id),
  invoice_id bigint references sales_invoices(id),
  site_id int references partner_sites(id),
  note text not null check (length(trim(note)) > 0),
  at timestamptz not null default now(),
  user_id int not null references users(id)
);
create trigger partner_notes_permanent before update or delete on partner_notes for each row execute function kph_forbid_change();

-- Paint shade records, so repeat orders match exactly.
create table paint_shades (
  id bigserial primary key,
  partner_id int references partners(id),
  customer_id int references customers(id),
  site_id int references partner_sites(id),
  product_id int references products(id),
  base text,
  tint text,
  shade_code text,
  shade_name text,
  quantity text,
  shade_date date not null default current_date,
  note text,
  user_id int not null references users(id),
  at timestamptz not null default now(),
  check (partner_id is not null or customer_id is not null)
);

insert into ledgers (name, group_id, system_code, kind)
select 'Partner Commission', g.id, 'partner_commission', 'expense' from ledger_groups g where g.name = 'Indirect Expenses';

update roles set permissions = permissions || array['partners.manage', 'partners.rewards']
where id = 'admin' and not ('partners.manage' = any(permissions));
update roles set permissions = permissions || array['partners.manage']
where id = 'counter' and not ('partners.manage' = any(permissions));

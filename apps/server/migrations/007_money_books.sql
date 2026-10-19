-- Phase 3A: bank accounts, supplier payments, expenses, contra, journals, cash closing, opening balances.

-- What a ledger is for, so screens can offer the right ones (pay from: cash/bank; expense heads; ...).
alter table ledgers add column kind text check (kind in ('cash', 'bank', 'clearing', 'expense', 'income', 'capital', 'other'));
alter table ledgers add column details jsonb not null default '{}';   -- bank: account no, IFSC, branch
alter table ledgers add column created_at timestamptz not null default now();
update ledgers set kind = 'cash' where system_code = 'cash';
update ledgers set kind = 'bank' where system_code = 'bank';
update ledgers set kind = 'clearing' where system_code in ('upi', 'card', 'cheque');

insert into ledger_groups (name, nature) values ('Loans (Liability)', 'liability'), ('Fixed Assets', 'asset'), ('Loans & Advances (Asset)', 'asset')
on conflict (name) do nothing;

insert into ledgers (name, group_id, system_code, kind)
select l.name, g.id, l.code, l.kind from (values
  ('Capital Account', 'Capital Account', 'capital', 'capital'),
  ('Opening Stock', 'Stock-in-Hand', 'opening_stock', 'other'),
  ('Bank Charges', 'Indirect Expenses', 'bank_charges', 'expense'),
  ('Cash Short & Excess', 'Indirect Expenses', 'cash_diff', 'expense')
) as l(name, grp, code, kind) join ledger_groups g on g.name = l.grp;

-- Expense heads (rename, add or hide them in Accounts → Expense heads)
insert into ledgers (name, group_id, kind)
select l.name, g.id, 'expense' from (values
  ('Rent', 'Indirect Expenses'),
  ('Salaries & Wages', 'Indirect Expenses'),
  ('Electricity', 'Indirect Expenses'),
  ('Telephone & Internet', 'Indirect Expenses'),
  ('Transport (delivery)', 'Indirect Expenses'),
  ('Loading & Unloading', 'Direct Expenses'),
  ('Repairs & Maintenance', 'Indirect Expenses'),
  ('Tea & Refreshments', 'Indirect Expenses'),
  ('Shop Expenses (misc.)', 'Indirect Expenses')
) as l(name, grp) join ledger_groups g on g.name = l.grp;
update ledgers set kind = 'expense' where system_code in ('freight_in', 'round_off');

-- One record per money entry. Accounting lives in the voucher; this keeps the number, who/what/why.
create table money_entries (
  id bigserial primary key,
  number text not null unique,
  fy_start int not null,
  seq int not null,
  kind text not null check (kind in ('payment', 'expense', 'contra', 'journal')),
  entry_date date not null,
  at timestamptz not null default now(),
  amount_paise bigint not null check (amount_paise > 0),
  supplier_id int references suppliers(id),           -- payment
  ledger_id int references ledgers(id),               -- expense head (expense) / to-ledger (contra)
  from_ledger_id int references ledgers(id),          -- paid from (payment, expense, contra)
  charges_paise bigint not null default 0 check (charges_paise >= 0),   -- contra: bank / card charges
  -- expense with a GST bill
  gst_rate_bp int,
  taxable_paise bigint,
  cgst_paise bigint not null default 0,
  sgst_paise bigint not null default 0,
  igst_paise bigint not null default 0,
  vendor_name text,
  vendor_gstin text,
  vendor_bill_no text,
  reference text,                                     -- cheque / UTR number
  narration text,
  file text,                                          -- photo of the expense bill
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
  unique (kind, fy_start, seq),
  check (kind <> 'payment' or supplier_id is not null)
);
create index money_entries_date on money_entries (entry_date);
create trigger money_entries_only_cancel before update or delete on money_entries for each row execute function kph_only_cancel();

-- Which supplier bills a payment settles. Ignored once the payment is cancelled.
create table payment_allocations (
  id bigserial primary key,
  entry_id bigint not null references money_entries(id),
  purchase_id bigint not null references purchase_invoices(id),
  amount_paise bigint not null check (amount_paise > 0),
  unique (entry_id, purchase_id)
);
create trigger payment_allocations_permanent before update or delete on payment_allocations for each row execute function kph_forbid_change();

-- End-of-day cash count. Several counts a day are allowed; the last one stands.
create table cash_closings (
  id bigserial primary key,
  close_date date not null,
  at timestamptz not null default now(),
  book_paise bigint not null,
  counted_paise bigint not null check (counted_paise >= 0),
  difference_paise bigint not null,
  denominations jsonb not null default '{}',
  note text,
  adjustment_entry_id bigint references money_entries(id),
  user_id int not null references users(id),
  device_id int references devices(id)
);
create trigger cash_closings_permanent before update or delete on cash_closings for each row execute function kph_forbid_change();

update roles set permissions = permissions || array['payments.make', 'expenses.create', 'accounts.manage']
where id = 'admin' and not ('accounts.manage' = any(permissions));

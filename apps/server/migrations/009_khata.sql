-- Phase 4: credit (khata). Credit days and reminder language per customer, payments settled
-- against specific bills, and a log of WhatsApp reminders.
alter table customers add column credit_days int check (credit_days between 0 and 365);
alter table customers add column language text check (language in ('te', 'en'));

-- Which credit bills a receipt settles. Ignored once the receipt is cancelled.
create table receipt_allocations (
  id bigserial primary key,
  receipt_id bigint not null references receipts(id),
  invoice_id bigint not null references sales_invoices(id),
  amount_paise bigint not null check (amount_paise > 0),
  unique (receipt_id, invoice_id)
);
create trigger receipt_allocations_permanent before update or delete on receipt_allocations for each row execute function kph_forbid_change();

create table reminders (
  id bigserial primary key,
  customer_id int not null references customers(id),
  at timestamptz not null default now(),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'call', 'visit', 'sms')),
  language text,
  balance_paise bigint not null,
  overdue_paise bigint not null default 0,
  message text,
  note text,
  user_id int not null references users(id),
  device_id int references devices(id)
);
create index reminders_customer on reminders (customer_id, at desc);

update roles set permissions = array_append(permissions, 'billing.over_credit_limit')
where id = 'admin' and not ('billing.over_credit_limit' = any(permissions));

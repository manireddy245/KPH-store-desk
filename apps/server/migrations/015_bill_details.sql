-- New bill layout: services on bills, and the extra details printed on the bill.

-- Services (loading / unloading, transport, cutting charges…) are sold like products but carry no stock.
alter table products add column is_service boolean not null default false;

-- Details printed on the bill besides the customer: ship-to, customer PAN and the delivery boxes.
-- Kept apart from the bill itself (bills can't be changed once saved), so they can be added or corrected later.
create table invoice_details (
  invoice_id bigint primary key references sales_invoices(id),
  ship_to_name text,
  ship_to_address text,
  ship_to_contact text,
  ship_to_phone text,
  customer_pan text check (customer_pan is null or customer_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  delivery_note text,
  reference text,
  other_references text,
  dispatched_through text,
  destination text,
  terms_of_delivery text,
  updated_by int not null references users(id),
  updated_at timestamptz not null default now()
);

-- Transport and e-way bill details for a sales bill. Kept apart from the bill itself
-- (bills can't be changed once saved); these can be filled in and corrected later.
create table invoice_transport (
  invoice_id bigint primary key references sales_invoices(id),
  to_place text,
  to_pincode text check (to_pincode is null or to_pincode ~ '^[1-9][0-9]{5}$'),
  distance_km int check (distance_km is null or distance_km between 0 and 4000),
  trans_mode text not null default 'road' check (trans_mode in ('road', 'rail', 'air', 'ship')),
  vehicle_no text,
  transporter_id text,
  transporter_name text,
  ewb_no text check (ewb_no is null or ewb_no ~ '^[0-9]{12}$'),
  ewb_date date,
  -- e.g. "customer collected, value split" — when no e-way bill was made for a large bill
  not_needed_reason text,
  updated_by int not null references users(id),
  updated_at timestamptz not null default now()
);

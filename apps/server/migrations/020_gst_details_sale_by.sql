-- GST details of a business customer, kept apart from their contact details
-- (filled from the GST lookup, or typed): legal and trade name, Regular / Composition, status, constitution, address.
alter table customers add column gst_legal_name text;
alter table customers add column gst_trade_name text;
alter table customers add column gst_type text;
alter table customers add column gst_status text;
alter table customers add column gst_constitution text;
alter table customers add column gst_address text;
alter table customers add column gst_checked_at timestamptz;

-- "Sale by" on the printed bill: the salesperson's name typed at billing.
alter table invoice_details add column sale_by text;

-- An item made on the spot at the billing counter (not in the product list yet): HSN etc. to be checked later.
alter table products add column added_at_billing boolean not null default false;

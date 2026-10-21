-- "To order" list: a simple notepad of things to buy. Ticking "Ordered" moves an item to the ordered list.
-- Not a business record (no stock or money), so items can be deleted.
create table order_list (
  id bigserial primary key,
  product_id int references products(id),
  item_text text not null,              -- product name at the time, or free text ("6 mm binding wire")
  qty_milli bigint check (qty_milli > 0),
  unit_code text,
  note text,
  status text not null default 'to_order' check (status in ('to_order', 'ordered')),
  created_by int references users(id),
  created_at timestamptz not null default now(),
  ordered_by int references users(id),
  ordered_at timestamptz
);
create index order_list_status_idx on order_list (status, created_at);

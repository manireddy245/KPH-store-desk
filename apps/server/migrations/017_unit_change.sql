-- A product's stock unit can change after it has stock (bought in tonnes, now counted in rods):
-- the stock is converted with one 'unit_change' movement, so the ledger still adds up to the balance.
alter table stock_movements drop constraint stock_movements_kind_check;
alter table stock_movements add constraint stock_movements_kind_check
  check (kind in ('opening', 'purchase', 'sale', 'sale_cancel', 'sale_return',
                  'purchase_return', 'adjustment', 'audit', 'transfer', 'unit_change'));

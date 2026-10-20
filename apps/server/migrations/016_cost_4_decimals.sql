-- Cost prices with 4 decimals (e.g. ₹57.2034 a kg), still exact whole numbers.
-- Costs move from paise (1/100 rupee) to "cp" = 1/10,000 rupee: every value × 100.
-- Bills, GST, totals and accounts stay in paise (2 decimals).
-- The columns are renamed so any old code using paise fails loudly instead of being 100× off.

-- These tables refuse edits; switch that off for this one-time conversion only.
alter table stock_movements disable trigger stock_movements_permanent;
alter table sales_invoice_lines disable trigger sales_invoice_lines_permanent;
alter table purchase_lines disable trigger purchase_lines_permanent;
alter table price_history disable trigger price_history_permanent;

alter table products rename column cost_price_paise to cost_price_cp;
update products set cost_price_cp = cost_price_cp * 100 where cost_price_cp is not null;

alter table stock_movements rename column unit_cost_paise to unit_cost_cp;
update stock_movements set unit_cost_cp = unit_cost_cp * 100 where unit_cost_cp is not null;

alter table sales_invoice_lines rename column cost_price_paise to cost_price_cp;
update sales_invoice_lines set cost_price_cp = cost_price_cp * 100 where cost_price_cp is not null;

alter table purchase_lines rename column unit_cost_paise to unit_cost_cp;
update purchase_lines set unit_cost_cp = unit_cost_cp * 100;

update price_history set field = 'cost_price_cp', old_value = old_value * 100, new_value = new_value * 100 where field = 'cost_price_paise';

alter table stock_movements enable trigger stock_movements_permanent;
alter table sales_invoice_lines enable trigger sales_invoice_lines_permanent;
alter table purchase_lines enable trigger purchase_lines_permanent;
alter table price_history enable trigger price_history_permanent;

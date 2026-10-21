-- "Shipping charges" for the tick box on the billing screen: a service (GST, no stock) with no fixed
-- price, so the amount is typed on each bill. SAC 996511 = road transport of goods. The GST rate can be
-- changed in Inventory (freight billed with goods usually takes the goods' rate — ask the CA).
insert into products (sku, name, unit_code, hsn, gst_rate_bp, sale_price_paise, is_service)
select 'SHIPPING', 'Shipping charges', 'nos', '996511', 1800, 0, true
where not exists (select 1 from products where lower(sku) = 'shipping');

-- Stock staff enter purchases, so by default they may also add a new supplier.
update roles set permissions = array_append(permissions, 'suppliers.manage')
where id = 'stock' and not ('suppliers.manage' = any(permissions));

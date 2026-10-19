-- Re-applied after every migration run. The app logs in as storedesk_app, which
-- cannot delete or truncate business records and cannot write stock balances directly.
grant usage on schema public to storedesk_app;
grant select, insert, update on all tables in schema public to storedesk_app;
grant usage, select on all sequences in schema public to storedesk_app;
revoke delete, truncate on all tables in schema public from storedesk_app;
grant delete on products, bill_drafts to storedesk_app;
revoke insert, update on stock_balances from storedesk_app;
revoke insert, update on schema_migrations from storedesk_app;

-- Old credits that are not being collected: kept on the books as a record, but left out of
-- reminders, the overdue lists and the dashboard.
alter table customers add column dues_on_hold boolean not null default false;
alter table customers add column hold_note text;

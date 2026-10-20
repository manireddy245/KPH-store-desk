-- Phase 7: backup copies to a second location (encrypted), and the daily summary.
alter table backups_log drop constraint backups_log_kind_check;
alter table backups_log add constraint backups_log_kind_check check (kind in ('auto', 'manual', 'pre-restore', 'copy'));
alter table backups_log add column location text;

-- The day's summary for the owner, made at shop closing (kept, so past days can be looked at).
create table daily_summaries (
  summary_date date primary key,
  made_at timestamptz not null default now(),
  data jsonb not null,
  text_en text not null,
  text_te text not null
);

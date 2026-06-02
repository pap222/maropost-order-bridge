-- Run this once in Supabase -> SQL Editor.
-- Holds live app toggles (currently just auto_mode) so the review page can flip
-- automation on/off without redeploying, and the cron reads it at runtime.

create table if not exists app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Lock it down: only the service_role key (used server-side by the functions)
-- can read/write. No anon/public access.
alter table app_settings enable row level security;

-- Seed the automation flag to OFF (manual review). Safe to re-run.
insert into app_settings (key, value)
values ('auto_mode', '0')
on conflict (key) do nothing;

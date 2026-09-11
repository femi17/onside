-- Mirror of remotely applied migration daily_digest (2026-09-11).
-- Daily habit anchor: per-user morning Telegram digest (today's agent picks + yesterday's result).
-- Opt-out column (default on for linked users), a per-Lagos-day idempotency table, the invoker, and
-- the 07:00 UTC (08:00 Lagos) cron — after the morning agent runs have delivered.
alter table public.profiles add column if not exists daily_digest boolean not null default true;

create table if not exists public.digest_runs (
  day date primary key,
  sent int not null default 0,
  ran_at timestamptz not null default now()
);

create or replace function public.invoke_daily_digest()
returns bigint language sql security definer set search_path to '' as $$
  select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
    ),
    body := jsonb_build_object(),
    timeout_milliseconds := 55000
  );
$$;
revoke execute on function public.invoke_daily_digest() from public, anon, authenticated;
grant execute on function public.invoke_daily_digest() to service_role;

do $$ begin perform cron.unschedule('daily-digest'); exception when others then null; end $$;
select cron.schedule('daily-digest', '0 7 * * *', $$select public.invoke_daily_digest()$$);

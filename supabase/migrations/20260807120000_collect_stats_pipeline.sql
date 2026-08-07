-- Corners/cards data pipeline for the agent engine's stat models (collect-stats edge function).
-- stats_backfill_candidates: finished fixtures with NO fixture_stats row yet, newest first —
-- the collector fetches these in 20-fixture batches and writes corners + cards, so run-strategies
-- can price corners/cards markets with real per-team rates (model self-activates as data accrues).
create or replace function stats_backfill_candidates(p_since timestamptz, p_limit int)
returns table (id bigint)
language sql
security definer
set search_path to ''
as $$
  select f.id
  from public.fixtures f
  left join public.fixture_stats fs on fs.fixture_id = f.id
  where fs.fixture_id is null
    and f.status in ('FT','AET','PEN')
    and f.kickoff_utc >= p_since
  order by f.kickoff_utc desc
  limit p_limit;
$$;

-- same lockdown pattern as the other SECURITY DEFINER ops functions
revoke execute on function stats_backfill_candidates(timestamptz, int) from public, anon, authenticated;
grant execute on function stats_backfill_candidates(timestamptz, int) to service_role;

create or replace function invoke_collect_stats()
returns bigint
language sql
security definer
set search_path to ''
as $$
  select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/collect-stats',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$$;
revoke execute on function invoke_collect_stats() from public, anon, authenticated;
grant execute on function invoke_collect_stats() to service_role;

-- daily at 04:40 UTC, after the 05:10 fixture sync's previous day has fully settled
select cron.schedule('onside-collect-stats', '40 4 * * *', $$select invoke_collect_stats()$$);

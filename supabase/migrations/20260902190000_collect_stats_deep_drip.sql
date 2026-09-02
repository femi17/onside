-- Corner-history deep drip (owner-directed 2026-09-02). Mirror of remotely applied migration
-- `collect_stats_deep_drip`. Corner rules can't be mined on ~18K stat-covered games while
-- results history holds 800K+. collect-stats ALREADY backfills statistics 20-fixtures-per-call,
-- yield-ordered (stats_backfill_candidates ranks leagues by observed corner-return rate) and
-- marks no-stats fixtures attempted-once — so the deep drip is just the existing function
-- invoked harder: every 6 minutes through the 00:00-05:54 UTC quiet window with a 400-day
-- reach (~60 ticks × ~1,000 fixtures ≈ up to 60K fixtures/night at only ~3K API calls).
-- Validated live before scheduling: 50 calls → 1,000 processed, 923 with corners (92% yield).
-- Exhaustion is self-limiting: no candidates → 0 calls.
--
-- NOTE (supervision record): a worktree agent first built a per-fixture backfill edge function
-- for this; its own report surfaced that collect-stats' batched endpoint is 20x cheaper, so
-- that function was never deployed — this drip supersedes it.

create or replace function public.invoke_collect_stats_deep()
returns void
language sql
security definer
set search_path to ''
as $function$
  select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/collect-stats',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
    ),
    body := '{"max_calls": 250, "days_back": 400}'::jsonb,
    timeout_milliseconds := 55000
  );
$function$;

revoke all on function public.invoke_collect_stats_deep() from public;
revoke all on function public.invoke_collect_stats_deep() from anon;
revoke all on function public.invoke_collect_stats_deep() from authenticated;

do $$
begin
  perform cron.unschedule('collect-stats-deep');
exception when others then null;
end $$;
select cron.schedule('collect-stats-deep', '*/6 0-5 * * *', $$select public.invoke_collect_stats_deep()$$);

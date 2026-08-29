-- Daily xG sweep (owner-approved 2026-08-29): after the 04:40 corner/cards collector, a small
-- xg-mode run merges xG/shots/possession into the last 3 days' fixtures that still lack it —
-- covers rows the live poll created (which the normal collector's never-clobber upsert skips)
-- and any late-compiled provider stats. ~10-20 calls/day once the backfill has drained.
select cron.schedule(
  'onside-collect-xg',
  '10 5 * * *',
  $$
  select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/collect-stats',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
    ),
    body := '{"task": "xg", "max_calls": 30, "days_back": 3}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

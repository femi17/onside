-- Paper mode v2 (2026-09-02). Mirror of remotely applied migration `paper_ticks`.
-- The day-one 10-post pg_net burst DNS-starved itself (all ten timed out before a single
-- request left the worker). One tick = one run: invoke_paper_runs() now posts a single
-- {paper:true} and the ENGINE picks the least-recently-run paper strategy; the cron fires ten
-- spaced ticks each morning (09:30-09:57 UTC, every 3 min) so all ten markets run without a
-- burst and without one edge invocation exceeding the idle limit on cold all-league runs.

create or replace function public.invoke_paper_runs()
returns void
language sql
security definer
set search_path to ''
as $function$
  select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/run-strategies',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
    ),
    body := '{"paper": true}'::jsonb,
    timeout_milliseconds := 55000
  );
$function$;

revoke all on function public.invoke_paper_runs() from public;
revoke all on function public.invoke_paper_runs() from anon;
revoke all on function public.invoke_paper_runs() from authenticated;

do $$
begin
  perform cron.unschedule('paper-runs-daily');
exception when others then null;
end $$;
select cron.schedule('paper-runs-daily', '30,33,36,39,42,45,48,51,54,57 9 * * *', $$select public.invoke_paper_runs()$$);

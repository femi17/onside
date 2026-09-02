-- Mirror of remotely applied migration `paper_ticks_overflow` (2026-09-02).
-- The paper roster grew to 12 strategies (1UP joined); the 09:30-09:57 window holds 10 ticks.
-- Two overflow ticks just past 10:00 keep every market running daily instead of rotating over.
do $$
begin
  perform cron.unschedule('paper-runs-daily-2');
exception when others then null;
end $$;
select cron.schedule('paper-runs-daily-2', '0,3 10 * * *', $$select public.invoke_paper_runs()$$);

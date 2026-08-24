-- Daily onboarding-nudge run (10:00 Lagos = 09:00 UTC): send-nudge computes its audiences
-- fresh each day and the api_cache claim makes every user nudge-once-per-kind forever, so
-- the daily tick only ever mails NEW stragglers. Same invoke pattern as the broadcasts.
create or replace function public.invoke_send_nudge()
returns bigint
language sql
security definer
set search_path to ''
as $function$
  select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-nudge',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$function$;
revoke all on function public.invoke_send_nudge() from public, anon, authenticated;
select cron.schedule('send-nudge-daily', '0 9 * * *', 'select public.invoke_send_nudge()');

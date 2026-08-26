-- Friday agent-checkup ritual: 09:00 UTC (10:00 Lagos) — starving-agent diagnosis emails go
-- out before the weekend slate so users can retune while it still matters.
create or replace function public.invoke_agent_checkup()
returns bigint
language sql
security definer
set search_path to ''
as $function$
  select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/agent-checkup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$function$;
revoke all on function public.invoke_agent_checkup() from public, anon, authenticated;
select cron.schedule('agent-checkup-weekly', '0 9 * * 5', 'select public.invoke_agent_checkup()');

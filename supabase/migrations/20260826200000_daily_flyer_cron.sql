-- The morning flyer ritual (owner request): daily-flyer DMs the owner a share-ready results
-- flyer pack (story + feed sizes, rendered fresh by /flyer/results on Vercel) at 08:10 Lagos —
-- after the overnight settlements and the corner reconcile sweep have finished their work.
create or replace function public.invoke_daily_flyer()
returns bigint
language sql
security definer
set search_path to ''
as $function$
  select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/daily-flyer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$function$;
revoke all on function public.invoke_daily_flyer() from public, anon, authenticated;
select cron.schedule('daily-flyer', '10 7 * * *', 'select public.invoke_daily_flyer()');

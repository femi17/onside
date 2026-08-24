-- "Your Week" receipt: audience + numbers for the Sunday-night recap email. A user qualifies
-- with ANY graded activity in the last 7 days (their slips or their agents' picks). Demo is
-- excluded; the owner's real accounts get their recaps like anyone else — it's a product
-- feature, not analytics. Service-role only (emails). Additive.
create or replace function public.recap_targets()
returns table(user_id uuid, email text, slips_graded bigint, slips_won bigint, agents_graded bigint, agents_won bigint)
language sql
stable
security definer
set search_path to ''
as $function$
  with slips as (
    select t.user_id, count(*) g, count(*) filter (where t.status = 'won') w
    from public.tickets t
    where t.status in ('won','lost') and coalesce(t.settled_at, t.created_at) > now() - interval '7 days'
    group by t.user_id
  ),
  agents as (
    select d.user_id, count(*) g, count(*) filter (where d.result = 'won') w
    from public.deliveries d
    where d.result in ('won','lost') and d.delivered_at > now() - interval '7 days'
    group by d.user_id
  )
  select u.id, u.email::text,
         coalesce(s.g, 0), coalesce(s.w, 0), coalesce(a.g, 0), coalesce(a.w, 0)
  from auth.users u
  left join slips s on s.user_id = u.id
  left join agents a on a.user_id = u.id
  where u.deleted_at is null
    and u.email <> 'demo@onside.com.ng'
    and (coalesce(s.g, 0) + coalesce(a.g, 0)) > 0
$function$;
revoke all on function public.recap_targets() from public, anon, authenticated;
grant execute on function public.recap_targets() to service_role;

-- Sunday 21:00 Lagos (20:00 UTC): the week is settled, the receipt goes out
select cron.schedule('send-recap-weekly', '0 20 * * 0',
  $$select net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-recap',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icnRwZXRwZ3NnZ25sY2F6aHFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MjAyMTksImV4cCI6MjEwMDk5NjIxOX0.etTN6LbQ1olV3mMw3VOvIW0C5oGbf68VQyR_-x6vFq4'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )$$);

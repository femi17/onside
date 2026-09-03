-- Mirror of remotely applied migration recap_targets_no_drafts (2026-09-03).
-- recap_targets: draft-strategy deliveries (quick-acca pool rows) were counted in the Sunday
-- receipt's agent numbers — a user whose only touch was generating slips would get a recap
-- claiming their "agents" went e.g. 9/28 on picks they never saw. Same exclusion as every
-- other agent surface (owner-ruled: drafts are not agents).
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
      and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
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

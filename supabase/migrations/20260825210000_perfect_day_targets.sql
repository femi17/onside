-- Perfect-day audience (owner request): an agent whose ENTIRE delivered day settled as won
-- (3+ picks, nothing pending/lost/void) earns the user a congratulation + plan-matched
-- upsell, sent by send-nudge. Looks back 3 days so late settlements still get caught by a
-- later tick; send-nudge claims nudge:perfect:{user}:{day} so each user hears about at most
-- one perfect day per day, best batch first. Internal accounts excluded like nudge_targets.
create or replace function public.perfect_day_targets()
returns table(user_id uuid, email text, plan text, agent text, day date, n bigint)
language sql
stable
security definer
set search_path to ''
as $function$
  select d.user_id, u.email::text, coalesce(p.plan, 'free'),
         coalesce(s.name, 'Your agent'), d.delivered_at::date, count(*)
  from public.deliveries d
  join auth.users u on u.id = d.user_id
  join public.profiles p on p.id = d.user_id
  left join public.strategies s on s.id = d.strategy_id
  where d.delivered_at > now() - interval '3 days'
    and u.deleted_at is null
    and u.email not in ('demo@onside.com.ng', 'oduolafemi17@gmail.com')
  group by d.user_id, u.email, p.plan, s.name, d.delivered_at::date
  having count(*) >= 3
     and count(*) filter (where d.result = 'won') = count(*)
  order by count(*) desc
$function$;
revoke all on function public.perfect_day_targets() from public, anon, authenticated;
grant execute on function public.perfect_day_targets() to service_role;

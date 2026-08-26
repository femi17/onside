-- First-win congratulation audience (owner-ruled: Bobby's 1/1 case): the first time a user's
-- agent lands a graded win — ANY card size — they get one congratulation, ever. This RPC
-- returns users whose FIRST-EVER won delivery settled in the last 7 days (older first wins are
-- stale news), with the winning pick's details for the copy. send-nudge claims
-- nudge:first-win:{user} once ever and skips anyone already celebrated with a perfect-day
-- (the bigger honour covers the smaller). Internal accounts excluded as everywhere.
create or replace function public.first_win_targets()
returns table(user_id uuid, email text, plan text, agent text, game text, market text, score text)
language sql
stable
security definer
set search_path to ''
as $function$
  with firsts as (
    select d.user_id, min(d.settled_at) as first_settle
    from public.deliveries d
    where d.result = 'won' and d.settled_at is not null
    group by d.user_id
    having min(d.settled_at) > now() - interval '7 days'
  )
  select distinct on (d.user_id)
         d.user_id, u.email::text, coalesce(p.plan, 'free'),
         coalesce(s.name, 'Your agent'),
         f.home_team || ' v ' || f.away_team,
         coalesce(nullif(d.market_label, ''), d.market_key),
         coalesce(d.settle_score, f.ft_home::text || '-' || f.ft_away::text)
  from firsts w
  join public.deliveries d on d.user_id = w.user_id and d.result = 'won' and d.settled_at = w.first_settle
  join auth.users u on u.id = d.user_id
  join public.profiles p on p.id = d.user_id
  left join public.strategies s on s.id = d.strategy_id
  join public.fixtures f on f.id = d.fixture_id
  where u.deleted_at is null
    and coalesce(p.is_admin, false) = false
    and u.email not in ('tyewoduola@gmail.com', 'demo@onside.com.ng', 'oduolafemi17@gmail.com')
  order by d.user_id, d.delivered_at
$function$;
revoke all on function public.first_win_targets() from public, anon, authenticated;
grant execute on function public.first_win_targets() to service_role;

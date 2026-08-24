-- My Record — the user's OWN graded truth, the lock-in surface: overall + last-30d record,
-- per-market-family splits (where they win and where they leak money), tracking streak, and
-- this week's slips + agent picks. Read-only aggregates over the caller's rows (auth.uid());
-- purely additive — touches no existing behaviour.
create or replace function public.my_record()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with mine as (
    select t.status, t.market_key, t.created_at, t.settled_at
    from public.tickets t
    where t.user_id = auth.uid()
  ),
  graded as (
    select *, case
      when market_key like '%corner%' then 'Corners'
      when market_key like '%card%' or market_key like '%booking%' then 'Cards'
      when market_key ~ '^(over|under)_' or market_key in ('total_goals_ou','btts','home_to_score','away_to_score','teams_to_score','home_goals_ou','away_goals_ou','odd_even','exact_goals','goal_range','multigoals','btts_2plus') then 'Goals'
      when market_key in ('home_win','away_win','draw','result_1x2','dnb','handicap') or market_key like 'double_chance%' or market_key like '%_1up' or market_key like '%_2up' or market_key like '%never_down' then 'Result'
      else 'Other' end as fam
    from mine where status in ('won','lost')
  ),
  days as (
    select distinct (created_at at time zone 'Africa/Lagos')::date as d from mine
  ),
  streak as (
    -- consecutive Lagos days with at least one tracked bet, ending today or yesterday
    select count(*) as n from (
      select d, row_number() over (order by d desc) - 1 as rn from days
    ) s
    where s.d = ((now() at time zone 'Africa/Lagos')::date - s.rn::int)
       or s.d = ((now() at time zone 'Africa/Lagos')::date - 1 - s.rn::int)
  )
  select jsonb_build_object(
    'all_time', (select jsonb_build_object('graded', count(*), 'won', count(*) filter (where status = 'won')) from graded),
    'last30', (select jsonb_build_object('graded', count(*), 'won', count(*) filter (where status = 'won'))
               from graded where created_at > now() - interval '30 days'),
    'families', (select coalesce(jsonb_agg(jsonb_build_object('family', fam, 'graded', n, 'won', w) order by n desc), '[]'::jsonb)
                 from (select fam, count(*) n, count(*) filter (where status = 'won') w from graded group by fam) f),
    'week_slips', (select jsonb_build_object('graded', count(*), 'won', count(*) filter (where status = 'won'))
                   from graded where coalesce(settled_at, created_at) > now() - interval '7 days'),
    'week_agents', (select jsonb_build_object('graded', count(*), 'won', count(*) filter (where result = 'won'))
                    from public.deliveries d
                    where d.user_id = auth.uid() and d.result in ('won','lost')
                      and d.delivered_at > now() - interval '7 days'),
    'streak_days', (select n from streak),
    'first_tracked', (select min(created_at) from mine)
  );
$function$;
revoke all on function public.my_record() from public, anon;
grant execute on function public.my_record() to authenticated;

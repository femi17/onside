-- Revert Onside School to its pre-2026-09-30 state (owner-requested). Undoes this session's changes:
--   - the >=1.45 real-odds floor + relaxed fallback + `relaxed` column (20260930120000)
--   - the drop-untagged-leagues tier filter (20260930130000)
--   - the obscure South American league blocklist (20260930140000)
-- Restores school_daily_over25() exactly as defined in 20260928160000: the owner's two highest-model-
-- Over-2.5 picks per day (Over 0.5 pool since Sep 7), graded Over 2.5, ranked purely by model prob, no
-- league filters, no odds floor, original return shape (no `relaxed`). DROP first because the current
-- function's return type carries the extra `relaxed` column. The page.tsx postponed-void change is
-- reverted separately in the same commit (buildStrategy back to minN=2, voidPostponed=false).
drop function if exists public.school_daily_over25();
create or replace function public.school_daily_over25()
returns table(
  strategy text, dt date, fixture_id bigint, rnk int, market text, prob numeric,
  home_team text, away_team text, ft_home int, ft_away int, home_goals int, away_goals int,
  status text, elapsed int, updated_at timestamptz, kickoff_utc timestamptz, league text, flag text, tier text
)
language sql
stable
security definer
set search_path to ''
as $function$
  with pool as (
    select distinct on (d.fixture_id, (d.delivered_at at time zone 'Africa/Lagos')::date)
      (d.delivered_at at time zone 'Africa/Lagos')::date as dt,
      d.fixture_id,
      (d.criteria->'reasons'->'model'->>'over25')::numeric as p_o25,
      f.home_team, f.away_team, f.ft_home, f.ft_away, f.home_goals, f.away_goals,
      f.status, f.elapsed, f.updated_at, f.kickoff_utc,
      lg.name as league, lg.flag_url as flag, lg.tier as tier
    from public.deliveries d
    join public.fixtures f on f.id = d.fixture_id
    left join public.leagues lg on lg.id = f.league_id
    where d.user_id = '91a63237-6a50-41bc-950d-7954450e3046'
      and d.market_key = 'over_0_5'
      and (d.delivered_at at time zone 'Africa/Lagos')::date >= date '2026-09-07'
      and (d.criteria->'reasons'->'model'->>'over25') is not null
    order by d.fixture_id, (d.delivered_at at time zone 'Africa/Lagos')::date, d.delivered_at desc
  ),
  o25 as (
    select 'best_over25'::text as strategy, p.dt, p.fixture_id,
      row_number() over (partition by p.dt order by p.p_o25 desc nulls last, p.fixture_id)::int as rnk,
      'over_2_5'::text as market, p.p_o25 as prob,
      p.home_team, p.away_team, p.ft_home, p.ft_away, p.home_goals, p.away_goals,
      p.status, p.elapsed, p.updated_at, p.kickoff_utc, p.league, p.flag, p.tier
    from pool p
  )
  select o.strategy, o.dt, o.fixture_id, o.rnk, o.market, o.prob, o.home_team, o.away_team, o.ft_home, o.ft_away,
         o.home_goals, o.away_goals, o.status, o.elapsed, o.updated_at, o.kickoff_utc, o.league, o.flag, o.tier
  from o25 o where o.rnk <= 2;
$function$;

revoke all on function public.school_daily_over25() from public, anon;
grant execute on function public.school_daily_over25() to authenticated;

-- Onside School IS the Best Over 2.5 double now (owner-ruled 2026-09-28: it won the forward-test, so it
-- becomes the live member bet — the other candidate lines and the old hand-set double are retired).
-- The old member view read the onside_double table; this RPC is the single source for the new line: the
-- owner's two highest-model-Over-2.5 picks per day (from the Over 0.5 signal pool since Sep 7), graded
-- Over 2.5. Same shape school_strategy_legs() returned for best_over25, but callable by MEMBERS too (the
-- lab RPC was admin-only). SECURITY DEFINER so it reads the owner's deliveries; the page gates display
-- (members/admins see today's pick, the funnel shows only the settled record).
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

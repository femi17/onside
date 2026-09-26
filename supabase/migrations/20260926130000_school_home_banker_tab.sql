-- Onside School: add the "Home Banker · double" forward-test tab (owner-directed 2026-09-26).
-- The 2 strongest home favourites each day (by model home-win prob, all leagues), bet as straight
-- home wins. Backtest over Sep 7+: 14-5 / +52% ROI at fair model odds (~+36% at realistic book
-- odds), longest losing streak 2 days. Added to school_strategy_legs so the strategy lab renders it
-- through the same member deck as the other tabs. Additive — existing strategies unchanged.
CREATE OR REPLACE FUNCTION public.school_strategy_legs()
 RETURNS TABLE(strategy text, dt date, fixture_id bigint, rnk integer, market text, prob numeric, home_team text, away_team text, ft_home integer, ft_away integer, home_goals integer, away_goals integer, status text, elapsed integer, updated_at timestamp with time zone, kickoff_utc timestamp with time zone, league text, flag text, tier text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    return;
  end if;

  return query
  with pool as (
    select distinct on (d.fixture_id, (d.delivered_at at time zone 'Africa/Lagos')::date)
      (d.delivered_at at time zone 'Africa/Lagos')::date as dt,
      d.fixture_id,
      (d.criteria->'reasons'->'model'->>'over25')::numeric as p_o25,
      (d.criteria->'reasons'->'model'->>'home')::numeric as p_home,
      ((d.criteria->'reasons'->'model'->>'home')::numeric + (d.criteria->'reasons'->'model'->>'draw')::numeric) as p_dc1x,
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
  ),
  dc as (
    select 'dc1x_treble'::text as strategy, p.dt, p.fixture_id,
      row_number() over (partition by p.dt order by p.p_dc1x desc nulls last, p.fixture_id)::int as rnk,
      'dc_1x'::text as market, p.p_dc1x as prob,
      p.home_team, p.away_team, p.ft_home, p.ft_away, p.home_goals, p.away_goals,
      p.status, p.elapsed, p.updated_at, p.kickoff_utc, p.league, p.flag, p.tier
    from pool p where p.p_dc1x is not null
  ),
  home_banker as (
    select 'home_banker'::text as strategy, p.dt, p.fixture_id,
      row_number() over (partition by p.dt order by p.p_home desc nulls last, p.fixture_id)::int as rnk,
      'home'::text as market, p.p_home as prob,
      p.home_team, p.away_team, p.ft_home, p.ft_away, p.home_goals, p.away_goals,
      p.status, p.elapsed, p.updated_at, p.kickoff_utc, p.league, p.flag, p.tier
    from pool p where p.p_home is not null
  ),
  lock_pool as (
    select p.*, (1/p.p_dc1x) as dc_odd, (1/p.p_home) as home_odd,
      row_number() over (partition by p.dt order by p.p_dc1x desc, p.fixture_id) as rn,
      count(*) over (partition by p.dt) as cnt
    from pool p
    where p.p_dc1x is not null and p.p_home is not null
      and p.tier in ('top','mid','as_top','sa_top','uefa')
      and (1/p.p_dc1x) <= 1.35
  ),
  lock as (
    select 'lock_acca'::text as strategy, lp.dt, lp.fixture_id, lp.rn::int as rnk,
      case when lp.dc_odd < 1.20 and lp.home_odd <= 1.35 then 'home' else 'dc_1x' end as market,
      case when lp.dc_odd < 1.20 and lp.home_odd <= 1.35 then lp.p_home else lp.p_dc1x end as prob,
      lp.home_team, lp.away_team, lp.ft_home, lp.ft_away, lp.home_goals, lp.away_goals,
      lp.status, lp.elapsed, lp.updated_at, lp.kickoff_utc, lp.league, lp.flag, lp.tier
    from lock_pool lp where lp.rn <= 3 and lp.cnt >= 2
  ),
  casc_pool as (
    select p.*, (1/p.p_dc1x) as dc_odd, (1/p.p_home) as home_odd,
      row_number() over (partition by p.dt order by p.p_dc1x desc, p.fixture_id) as rn,
      count(*) over (partition by p.dt) as cnt
    from pool p
    where p.p_dc1x is not null and p.p_home is not null and p.p_o25 is not null
      and (1/p.p_dc1x) <= 1.35
  ),
  casc as (
    select 'lock_cascade'::text as strategy, cp.dt, cp.fixture_id, cp.rn::int as rnk,
      case when cp.dc_odd < 1.20 and cp.home_odd < 1.10 then 'over_2_5'
           when cp.dc_odd < 1.20 then 'home' else 'dc_1x' end as market,
      case when cp.dc_odd < 1.20 and cp.home_odd < 1.10 then cp.p_o25
           when cp.dc_odd < 1.20 then cp.p_home else cp.p_dc1x end as prob,
      cp.home_team, cp.away_team, cp.ft_home, cp.ft_away, cp.home_goals, cp.away_goals,
      cp.status, cp.elapsed, cp.updated_at, cp.kickoff_utc, cp.league, cp.flag, cp.tier
    from casc_pool cp where cp.rn <= 3 and cp.cnt >= 2
  ),
  combo as (
    select distinct on (u.dt, u.fixture_id, u.market)
      'dc_lock_combo'::text as strategy, u.dt, u.fixture_id, u.rnk, u.market, u.prob,
      u.home_team, u.away_team, u.ft_home, u.ft_away, u.home_goals, u.away_goals,
      u.status, u.elapsed, u.updated_at, u.kickoff_utc, u.league, u.flag, u.tier
    from (
      select d.dt, d.fixture_id, d.rnk, d.market, d.prob, d.home_team, d.away_team, d.ft_home, d.ft_away,
             d.home_goals, d.away_goals, d.status, d.elapsed, d.updated_at, d.kickoff_utc, d.league, d.flag, d.tier
      from dc d where d.rnk <= 3
      union all
      select l.dt, l.fixture_id, l.rnk, l.market, l.prob, l.home_team, l.away_team, l.ft_home, l.ft_away,
             l.home_goals, l.away_goals, l.status, l.elapsed, l.updated_at, l.kickoff_utc, l.league, l.flag, l.tier
      from lock l
    ) u
    order by u.dt, u.fixture_id, u.market, u.prob desc
  )
  select o.* from o25 o where o.rnk <= 2
  union all select c.* from dc c where c.rnk <= 3
  union all select hb.* from home_banker hb where hb.rnk <= 2
  union all select l.* from lock l
  union all select cs.* from casc cs
  union all select cb.* from combo cb;
end;
$function$;

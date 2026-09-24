-- Admin-only: the ranked top-N legs PER DAY for the two candidate School lines, with the live fixture
-- data the SchoolRecord needs (scores, status, clock, league). The page assembles these flat rows into
-- SchoolRecord[] and feeds the SELECTED line into the normal SchoolMember view (stake input + swipe deck).
-- Pool = the admin's Over 0.5 picks since Sep 7 (the signal universe). best_over25 = top-2 by model
-- over25 (bet Over 2.5); dc1x_treble = top-3 by model home+draw (bet Double Chance 1X).
create or replace function public.school_strategy_legs()
returns table(
  strategy text, dt date, fixture_id bigint, rnk int, market text, prob numeric,
  home_team text, away_team text, ft_home int, ft_away int, home_goals int, away_goals int,
  status text, elapsed int, updated_at timestamptz, kickoff_utc timestamptz,
  league text, flag text, tier text
)
language plpgsql security definer set search_path to '' as $$
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
    from pool p
    where p.p_dc1x is not null
  )
  select o.strategy, o.dt, o.fixture_id, o.rnk, o.market, o.prob, o.home_team, o.away_team, o.ft_home, o.ft_away,
         o.home_goals, o.away_goals, o.status, o.elapsed, o.updated_at, o.kickoff_utc, o.league, o.flag, o.tier
  from o25 o where o.rnk <= 2
  union all
  select c.strategy, c.dt, c.fixture_id, c.rnk, c.market, c.prob, c.home_team, c.away_team, c.ft_home, c.ft_away,
         c.home_goals, c.away_goals, c.status, c.elapsed, c.updated_at, c.kickoff_utc, c.league, c.flag, c.tier
  from dc c where c.rnk <= 3;
end;
$$;

revoke all on function public.school_strategy_legs() from public, anon;
grant execute on function public.school_strategy_legs() to authenticated;

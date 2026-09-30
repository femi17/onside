-- Onside School — drop the truly untagged (very low tier) leagues from the double's pool (owner-ruled
-- 2026-09-30). The pool farms some fully-obscure leagues (leagues.tier IS NULL: reserve/youth junk, 33
-- leagues). Backtest of removing them: 16-6 / +34.2% ROI — IDENTICAL to keeping everything (16-6 / +34.7%),
-- i.e. a free cleanup. IMPORTANT: this removes ONLY tier IS NULL. We do NOT remove tier='ext' (extended
-- lower divisions) — those look low but are where most Over 2.5 goals come from; cutting ext tanks the
-- record to 9-13 / -20.2% (Over 2.5 hits MORE in looser lower-league football). Everything else unchanged
-- from the >=1.45 odds-floor version (20260930120000).
drop function if exists public.school_daily_over25();
create or replace function public.school_daily_over25()
returns table(
  strategy text, dt date, fixture_id bigint, rnk int, market text, prob numeric,
  home_team text, away_team text, ft_home int, ft_away int, home_goals int, away_goals int,
  status text, elapsed int, updated_at timestamptz, kickoff_utc timestamptz, league text, flag text, tier text,
  relaxed boolean
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
      and lg.tier is not null   -- drop very low tier (fully untagged/obscure leagues); keep ext + all tagged
    order by d.fixture_id, (d.delivered_at at time zone 'Africa/Lagos')::date, d.delivered_at desc
  ),
  priced as (
    select p.*, public.book_median_odd(os.bookmakers, 5, 'Over 2.5') as book_o25
    from pool p
    left join public.odds_snapshot os on os.fixture_id = p.fixture_id
  ),
  daymeta as (
    select dt,
      count(*) filter (where book_o25 >= 1.45) as n_floor,
      bool_or(book_o25 is not null) as any_odds
    from priced group by dt
  ),
  ranked as (
    select pr.*, dm.n_floor, dm.any_odds,
      row_number() over (partition by pr.dt
        order by (pr.book_o25 >= 1.45) desc nulls last, pr.p_o25 desc nulls last, pr.fixture_id) as rk_floor,
      row_number() over (partition by pr.dt
        order by pr.book_o25 desc nulls last, pr.p_o25 desc nulls last, pr.fixture_id) as rk_relaxed
    from priced pr join daymeta dm on dm.dt = pr.dt
  ),
  final as (
    select r.*,
      case when r.n_floor >= 2 then r.rk_floor else r.rk_relaxed end as rnk,
      (r.n_floor < 2 and r.any_odds) as relaxed
    from ranked r
  )
  select 'best_over25'::text as strategy, f.dt, f.fixture_id, f.rnk::int, 'over_2_5'::text as market, f.p_o25 as prob,
         f.home_team, f.away_team, f.ft_home, f.ft_away, f.home_goals, f.away_goals,
         f.status, f.elapsed, f.updated_at, f.kickoff_utc, f.league, f.flag, f.tier, f.relaxed
  from final f where f.rnk <= 2;
$function$;

revoke all on function public.school_daily_over25() from public, anon;
grant execute on function public.school_daily_over25() to authenticated;

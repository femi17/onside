-- Onside School — guarantee the double clears 2.0 (owner-ruled 2026-09-30, "lead by example on Oct 1").
-- Problem: the School double ranks the day's Over-2.5 legs by HIGHEST model probability. Highest prob =
-- most lopsided favourite = CHEAPEST real book line, so the double kept landing under 2.0 (1.05/1.07 legs
-- are dead money — Sep 23 1.68, Sep 26 1.42, Sep 29 1.40). The daily pool always has 7-40 legs sitting in
-- a healthy 1.40-1.90 band, so there is always headroom to clear 2.0 without dropping quality.
--
-- New selection (real book Over 2.5 odds from odds_snapshot, same median source the page prices on):
--   PRIMARY  — only legs with a real book odd >= 1.45 are eligible; take the 2 highest model-prob of those.
--              Two legs at >= 1.45 => combined always >= 2.10. Confidence still leads within the floor.
--   RELAXED  — if fewer than 2 legs clear the floor that day, fall back to the 2 highest-real-odds games
--              available (owner: "take the next-best pair, flagged"); may dip below 2.0, and `relaxed`=true
--              so the page can flag it.
-- Days before odds_snapshot began capturing (no real odds at all) have no odds to select on, so they fall
-- through to prob-desc — IDENTICAL to the old behaviour — and are NOT flagged (relaxed=false there).
-- DISPLAY/record only: this changes WHICH two games the School shows, never grading or settlement.
-- DROP first: the return type gains a `relaxed` column, which create-or-replace can't do in place.
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
    order by d.fixture_id, (d.delivered_at at time zone 'Africa/Lagos')::date, d.delivered_at desc
  ),
  -- real median book Over 2.5 odd per leg (NULL when no book quotes it / no snapshot yet)
  priced as (
    select p.*, public.book_median_odd(os.bookmakers, 5, 'Over 2.5') as book_o25
    from pool p
    left join public.odds_snapshot os on os.fixture_id = p.fixture_id
  ),
  -- per day: how many legs clear the >=1.45 floor, and whether the day has ANY real odds at all
  daymeta as (
    select dt,
      count(*) filter (where book_o25 >= 1.45) as n_floor,
      bool_or(book_o25 is not null) as any_odds
    from priced group by dt
  ),
  ranked as (
    select pr.*, dm.n_floor, dm.any_odds,
      -- floor ranking: qualifying legs first (>=1.45), most-confident within them
      row_number() over (partition by pr.dt
        order by (pr.book_o25 >= 1.45) desc nulls last, pr.p_o25 desc nulls last, pr.fixture_id) as rk_floor,
      -- relaxed ranking: highest real odds first (nulls last => real-odds legs preferred), then confidence
      row_number() over (partition by pr.dt
        order by pr.book_o25 desc nulls last, pr.p_o25 desc nulls last, pr.fixture_id) as rk_relaxed
    from priced pr join daymeta dm on dm.dt = pr.dt
  ),
  final as (
    select r.*,
      case when r.n_floor >= 2 then r.rk_floor else r.rk_relaxed end as rnk,
      -- flag a genuine thin day: odds exist but fewer than 2 cleared the floor (may pay < 2.0).
      -- a day with NO real odds at all is the pre-snapshot history, not a relaxed pick — never flagged.
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

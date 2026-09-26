-- Onside School: add a 6th forward-test tab — "DC 1X + Lock Acca · combined" (owner-directed 2026-09-26).
-- It merges the DC 1X treble's legs (top-3 by model home+draw) with the Lock Acca legs (top-3 tier-tagged
-- favourites, DC odds <= 1.35, safest priced as straight home) into ONE daily slip, deduped by
-- (fixture, market). A postponed/cancelled/abandoned leg is VOIDED (dropped from the slip; the day
-- settles on the remaining legs) — mirrors how a bookie voids a rained-off leg, and lets Sep 13's
-- rained-off FAS v Alianza settle as the win it was on its other legs.
--
-- Both functions are extended additively: the existing tabs' output is byte-for-byte unchanged; this
-- only appends the new strategy. Admin-gated as before (empty for non-admins).

-- ---------------------------------------------------------------------------------------------------
-- Per-tab SUMMARY (record cards): append s4 = dc_lock_combo to the strategies array.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.school_strategy_records()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin boolean; v_default text; s1 jsonb; s2 jsonb; s3 jsonb; s4 jsonb;
  ADMIN constant uuid := '91a63237-6a50-41bc-950d-7954450e3046';
begin
  select coalesce(is_admin,false) into v_admin from public.profiles where id = auth.uid();
  if not v_admin then return '{"strategies":[]}'::jsonb; end if;
  select default_strategy into v_default from public.school_config where id = 1;

  -- Best Over 2.5 double (top-2 by model over25)
  select jsonb_build_object('key','best_over25','name','Best Over 2.5 · double','legs',2,
    'won', count(*) filter (where result='won'), 'lost', count(*) filter (where result='lost'),
    'profit', round(coalesce(sum(case when result='won' then odds-1 else -1 end),0)::numeric,2),
    'days', coalesce(jsonb_agg(jsonb_build_object('day',dt,'result',result,'odds',odds,'games',games) order by dt),'[]'::jsonb))
  into s2 from (
    select dt, jsonb_agg(game order by rn) games, round(exp(sum(ln(1/o25)))::numeric,2) odds,
           (case when bool_and(tot>=3) then 'won' else 'lost' end) result
    from (select *, row_number() over (partition by dt order by o25 desc, fixture_id) rn from (
      select distinct on (d.fixture_id) (d.delivered_at at time zone 'Africa/Lagos')::date dt, d.fixture_id,
        (d.criteria->'reasons'->'model'->>'over25')::numeric o25, f.home_team||' v '||f.away_team game,
        coalesce(f.ft_home,f.home_goals)+coalesce(f.ft_away,f.away_goals) tot, (f.status in ('FT','AET','PEN')) fin
      from public.deliveries d join public.fixtures f on f.id=d.fixture_id
      where d.user_id=ADMIN and d.market_key='over_0_5'
        and (d.delivered_at at time zone 'Africa/Lagos')::date >= date '2026-09-07'
        and (d.criteria->'reasons'->'model'->>'over25') is not null
      order by d.fixture_id, d.delivered_at desc) a) b
    where rn<=2 group by dt having count(*)=2 and bool_and(fin)) c;

  -- DC 1X treble (top-3 by model home+draw)
  select jsonb_build_object('key','dc1x_treble','name','Double Chance 1X · treble','legs',3,
    'won', count(*) filter (where result='won'), 'lost', count(*) filter (where result='lost'),
    'profit', round(coalesce(sum(case when result='won' then odds-1 else -1 end),0)::numeric,2),
    'days', coalesce(jsonb_agg(jsonb_build_object('day',dt,'result',result,'odds',odds,'games',games) order by dt),'[]'::jsonb))
  into s3 from (
    select dt, jsonb_agg(game order by rn) games, round(exp(sum(ln(1/x1)))::numeric,2) odds,
           (case when bool_and(hg>=ag) then 'won' else 'lost' end) result
    from (select *, row_number() over (partition by dt order by x1 desc, fixture_id) rn from (
      select distinct on (d.fixture_id) (d.delivered_at at time zone 'Africa/Lagos')::date dt, d.fixture_id,
        (d.criteria->'reasons'->'model'->>'home')::numeric + (d.criteria->'reasons'->'model'->>'draw')::numeric x1,
        f.home_team||' v '||f.away_team game, coalesce(f.ft_home,f.home_goals) hg, coalesce(f.ft_away,f.away_goals) ag,
        (f.status in ('FT','AET','PEN')) fin
      from public.deliveries d join public.fixtures f on f.id=d.fixture_id
      where d.user_id=ADMIN and d.market_key='over_0_5'
        and (d.delivered_at at time zone 'Africa/Lagos')::date >= date '2026-09-07'
        and (d.criteria->'reasons'->'model'->>'home') is not null
      order by d.fixture_id, d.delivered_at desc) a) b
    where rn<=3 group by dt having count(*)=3 and bool_and(fin)) c;

  -- Onside Double regraded Over 2.5 (the current School line; all-Over-0.5 doubles only)
  select jsonb_build_object('key','school_double','name','Onside Double · O2.5','legs',2,
    'won', count(*) filter (where result='won'), 'lost', count(*) filter (where result='lost'),
    'profit', round(coalesce(sum(case when result='won' then odds-1 else -1 end),0)::numeric,2),
    'days', coalesce(jsonb_agg(jsonb_build_object('day',dt,'result',result,'odds',odds,'games',games) order by dt),'[]'::jsonb))
  into s1 from (
    select dt, jsonb_agg(game order by rnk) games, round(exp(sum(ln(1/nullif(o25,0))))::numeric,2) odds,
           (case when bool_and(tot>=3) then 'won' else 'lost' end) result
    from (
      select od.set_date dt, f.home_team||' v '||f.away_team game,
        coalesce(f.ft_home,f.home_goals)+coalesce(f.ft_away,f.away_goals) tot, (f.status in ('FT','AET','PEN')) fin,
        (d.criteria->'reasons'->'model'->>'over25')::numeric o25, coalesce((leg->>'rank')::int,9) rnk,
        (select bool_and(l->>'market' ilike 'over 0.5%') from jsonb_array_elements(od.legs) l) all_o05
      from public.onside_double od
        cross join lateral jsonb_array_elements(od.legs) leg
        join public.fixtures f on f.id=(leg->>'fixture_id')::bigint
        left join public.deliveries d on d.id=(leg->>'delivery_id')::uuid
      where od.user_id=ADMIN and od.set_date >= date '2026-09-07') z
    where all_o05 group by dt having bool_and(fin)) c;

  -- NEW: DC 1X treble + Lock Acca, merged into one slip per day (deduped by fixture+market).
  -- Postponed/cancelled/abandoned legs are VOIDED (excluded) so the day grades on the rest.
  with pool as (
    select distinct on (d.fixture_id, (d.delivered_at at time zone 'Africa/Lagos')::date)
      (d.delivered_at at time zone 'Africa/Lagos')::date dt, d.fixture_id,
      f.home_team||' v '||f.away_team game,
      (d.criteria->'reasons'->'model'->>'home')::numeric p_home,
      ((d.criteria->'reasons'->'model'->>'home')::numeric + (d.criteria->'reasons'->'model'->>'draw')::numeric) p_dc1x,
      coalesce(f.ft_home,f.home_goals) hg, coalesce(f.ft_away,f.away_goals) ag,
      (f.status in ('FT','AET','PEN')) fin, (f.status in ('PST','CANC','ABD')) voided,
      (l.tier in ('top','mid','as_top','sa_top','uefa')) tier_ok
    from public.deliveries d
    join public.fixtures f on f.id=d.fixture_id
    left join public.leagues l on l.id=f.league_id
    where d.user_id=ADMIN and d.market_key='over_0_5'
      and (d.delivered_at at time zone 'Africa/Lagos')::date >= date '2026-09-07'
      and (d.criteria->'reasons'->'model'->>'over25') is not null
    order by d.fixture_id, (d.delivered_at at time zone 'Africa/Lagos')::date, d.delivered_at desc
  ),
  dc as (
    select dt, fixture_id, game, hg, ag, fin, voided, 'dc_1x'::text market, (1/p_dc1x) odd, (hg>=ag) win,
      row_number() over (partition by dt order by p_dc1x desc nulls last, fixture_id) rnk
    from pool where p_dc1x is not null
  ),
  lock_pool as (
    select p.*, (1/p.p_dc1x) dc_odd, (1/p.p_home) home_odd,
      row_number() over (partition by p.dt order by p.p_dc1x desc, p.fixture_id) rn,
      count(*) over (partition by p.dt) cnt
    from pool p
    where p.p_dc1x is not null and p.p_home is not null and p.tier_ok and (1/p.p_dc1x)<=1.35
  ),
  lock as (
    select dt, fixture_id, game, hg, ag, fin, voided,
      case when dc_odd<1.20 and home_odd<=1.35 then 'home' else 'dc_1x' end market,
      case when dc_odd<1.20 and home_odd<=1.35 then home_odd else dc_odd end odd,
      case when dc_odd<1.20 and home_odd<=1.35 then (hg>ag) else (hg>=ag) end win
    from lock_pool where rn<=3 and cnt>=2
  ),
  legs_raw as (
    select dt,fixture_id,game,market,odd,win,fin,voided from dc where rnk<=3
    union all select dt,fixture_id,game,market,odd,win,fin,voided from lock
  ),
  legs as (
    select distinct on (dt,fixture_id,market) dt,fixture_id,game,market,odd,win,fin,voided
    from legs_raw order by dt,fixture_id,market,odd desc
  ),
  byday as (
    select dt,
      round(exp(sum(ln(odd)) filter (where not voided))::numeric,2) odds,
      jsonb_agg(game order by fixture_id) filter (where not voided) games,
      case when bool_or(win is false and not voided) then 'lost'
           when count(*) filter (where not voided) > 0
                and bool_and(fin) filter (where not voided)
                and bool_and(win) filter (where not voided) then 'won'
           else 'pending' end result
    from legs group by dt
  )
  select jsonb_build_object('key','dc_lock_combo','name','DC 1X + Lock Acca · combined','legs',null,
    'won', count(*) filter (where result='won'), 'lost', count(*) filter (where result='lost'),
    'profit', round(coalesce(sum(case when result='won' then odds-1 when result='lost' then -1 else 0 end) filter (where result in ('won','lost')),0)::numeric,2),
    'days', coalesce(jsonb_agg(jsonb_build_object('day',dt,'result',result,'odds',odds,'games',games) order by dt) filter (where result in ('won','lost')),'[]'::jsonb))
  into s4 from byday;

  return jsonb_build_object('since','2026-09-07','default',coalesce(v_default,'school_double'),
    'strategies', jsonb_build_array(coalesce(s1,'{}'::jsonb), coalesce(s2,'{}'::jsonb), coalesce(s3,'{}'::jsonb), coalesce(s4,'{}'::jsonb)));
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- Per-leg DETAIL: append the 'dc_lock_combo' strategy = dc (top-3) ∪ lock, deduped by fixture+market.
-- (Leg rows carry status, so the caller can render a voided/postponed leg however it likes.)
-- ---------------------------------------------------------------------------------------------------
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
      and (1/p.p_dc1x) <= 1.35    -- ALL leagues, nothing excluded
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
    -- DC 1X treble (top-3) ∪ Lock Acca, deduped by (day, fixture, market)
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
  union all select l.* from lock l
  union all select cs.* from casc cs
  union all select cb.* from combo cb;
end;
$function$;

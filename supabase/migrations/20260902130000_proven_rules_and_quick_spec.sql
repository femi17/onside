-- Proven-rules library + quick-spec groundwork (owner-directed 2026-09-02). Applied remotely
-- as proven_rules_and_quick_spec; this mirror matches the applied SQL.
--
-- 1. proven_rules: per popular market, the backtested filter set with the best Wilson lower
--    bound over ALL settled agent picks carrying form data. Publishing bar: n>=40 AND hit>=75%.
--    Deterministic candidate grid (model % thresholds x form conditions) — recomputed weekly
--    (cron refresh-proven-rules, Mon 04:00 UTC), never free-form mined, so rules can't drift
--    into overfitting. rule_text is the exact plain English the agent rule parser understands;
--    filters is the engine-ready parse. Seeded at apply time: over_1_5 90.3%/359,
--    double_chance_1x 91.5%/47, home_to_score 87.3%/134, double_chance_12 76.9%/242.
-- 2. protect_free_agent v2: status='draft' rows (the generator's quick-spec throwaway agent)
--    re-aim/delete freely on any plan — they never hunt on cron and generator output has its
--    own daily gate. Drafts are EXCLUDED from the delete-cap count so an extra draft row can't
--    unlock deleting a locked real agent.
-- 3. enforce_generated_acca_limit: paid legs cap 5 -> 24 (owner: "let the max be 24");
--    free stays 3 legs / 1 slip per day.

create table if not exists public.proven_rules (
  market_key text primary key,
  market_label text not null,
  rule_text text not null,
  filters jsonb not null,
  n integer not null,
  won integer not null,
  hit numeric(5,1) not null,
  computed_at timestamptz not null default now()
);
alter table public.proven_rules enable row level security;
drop policy if exists proven_rules_read on public.proven_rules;
create policy proven_rules_read on public.proven_rules for select to authenticated using (true);

create or replace function public.refresh_proven_rules()
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  delete from public.proven_rules;

  insert into public.proven_rules (market_key, market_label, rule_text, filters, n, won, hit, computed_at)
  select distinct on (grid.market_key)
    grid.market_key,
    case grid.market_key
      when 'over_1_5' then 'Over 1.5 goals'
      when 'over_2_5' then 'Over 2.5 goals'
      when 'under_3_5' then 'Under 3.5 goals'
      when 'home_to_score' then 'Home team to score'
      when 'away_to_score' then 'Away team to score'
      when 'double_chance_1x' then 'Double chance (1X)'
      when 'double_chance_12' then 'Double chance (12)'
      when 'double_chance_x2' then 'Double chance (X2)'
      when 'btts' then 'Both teams to score'
      when 'home_win' then 'Home win'
      else grid.market_key end,
    'Only games where the model gives my bet at least ' || round(grid.thr * 100) || '% chance'
      || case grid.cond
           when 'plus_blend3' then ' and the two teams combined blend is at least 3.0'
           when 'plus_blend_low24' then ' and the two teams combined blend is at most 2.4'
           when 'plus_home_avg15' then ' and the home team averages at least 1.5 goals per game'
           when 'plus_away_avg15' then ' and the away team averages at least 1.5 goals per game'
           else '' end,
    jsonb_build_array(jsonb_build_object('field','model_prob','op','gte','value',grid.thr,'value2',0))
      || case grid.cond
           when 'plus_blend3' then jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',3.0,'value2',0))
           when 'plus_blend_low24' then jsonb_build_array(jsonb_build_object('field','goals_blend','op','lte','value',2.4,'value2',0))
           when 'plus_home_avg15' then jsonb_build_array(jsonb_build_object('field','home_goals_avg','op','gte','value',1.5,'value2',0))
           when 'plus_away_avg15' then jsonb_build_array(jsonb_build_object('field','away_goals_avg','op','gte','value',1.5,'value2',0))
           else '[]'::jsonb end,
    grid.n, grid.won, round(100.0 * grid.won / grid.n, 1), now()
  from (
    with d as (
      select market_key, result, model_prob,
        (criteria->'reasons'->'home_form'->>'gf')::numeric as hgf, (criteria->'reasons'->'home_form'->>'ga')::numeric as hga,
        (criteria->'reasons'->'home_form'->>'n')::numeric as hn,
        (criteria->'reasons'->'away_form'->>'gf')::numeric as agf, (criteria->'reasons'->'away_form'->>'ga')::numeric as aga,
        (criteria->'reasons'->'away_form'->>'n')::numeric as an
      from public.deliveries
      where result in ('won','lost') and model_prob is not null
        and market_key in ('over_1_5','over_2_5','under_3_5','home_to_score','away_to_score',
                           'double_chance_1x','double_chance_12','double_chance_x2','btts','home_win')
    ),
    x as (
      select market_key, result, model_prob,
        case when hn > 0 then (hgf+hga)/hn end as hblend,
        case when an > 0 then (agf+aga)/an end as ablend,
        case when hn > 0 then hgf/hn end as havg,
        case when an > 0 then agf/an end as aavg
      from d
    )
    select market_key, thr, cond,
           count(*) as n, count(*) filter (where result='won') as won
    from x
    cross join lateral (values (0.75),(0.80),(0.85)) t(thr)
    cross join lateral (values
      ('model_only', model_prob >= thr),
      ('plus_blend3', model_prob >= thr and (hblend+ablend)/2 >= 3.0),
      ('plus_blend_low24', model_prob >= thr and (hblend+ablend)/2 <= 2.4),
      ('plus_home_avg15', model_prob >= thr and havg >= 1.5),
      ('plus_away_avg15', model_prob >= thr and aavg >= 1.5)
    ) c(cond, pass)
    where c.pass
    group by 1,2,3
  ) grid
  where grid.n >= 40 and 100.0 * grid.won / grid.n >= 75
  -- rank by the Wilson lower bound so a 90% on 350 picks outranks a 92% on 45
  order by grid.market_key,
    (((grid.won::float/grid.n) + 1.92/grid.n - 1.96 * sqrt(((grid.won::float/grid.n)*(1-(grid.won::float/grid.n)) + 0.9604/grid.n)/grid.n)) / (1 + 3.8416/grid.n)) desc;
end;
$function$;

revoke all on function public.refresh_proven_rules() from public;
revoke all on function public.refresh_proven_rules() from anon;
revoke all on function public.refresh_proven_rules() from authenticated;

do $$
begin
  perform cron.unschedule('refresh-proven-rules');
exception when others then null;
end $$;
select cron.schedule('refresh-proven-rules', '0 4 * * 1', $$select public.refresh_proven_rules()$$);

select public.refresh_proven_rules();

create or replace function public.protect_free_agent()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_plan text;
  v_cap int;
  v_cnt int;
  v_has_profile boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  select true, plan into v_has_profile, v_plan
  from public.profiles where id = coalesce(old.user_id, new.user_id);
  if not coalesce(v_has_profile, false) then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  if coalesce(v_plan, 'free') <> 'free' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  -- quick-spec rows (status 'draft' — the generator's throwaway agent) re-aim and delete freely
  -- on any plan: they never hunt on cron and the generator has its own daily slip gate. A draft
  -- promoted to running (save-as-agent) falls under the normal rules from then on.
  if coalesce(old.status, '') = 'draft' and (tg_op = 'DELETE' or coalesce(new.status, '') = 'draft') then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    select max_agents into v_cap from public.plan_limits where plan = 'free';
    select count(*) into v_cnt from public.strategies where user_id = old.user_id and coalesce(status, '') <> 'draft';
    if v_cnt > coalesce(v_cap, 1) then return old; end if;
    raise exception 'FREE_AGENT_DELETE_LOCKED: retiring an agent is a Pro feature';
  end if;

  if new.market_key        is distinct from old.market_key
     or new.market_label   is distinct from old.market_label
     or new.custom_market  is distinct from old.custom_market
     or new.markets        is distinct from old.markets
     or new.side           is distinct from old.side
     or new.line           is distinct from old.line
     or new.period         is distinct from old.period
     or new.bet_value      is distinct from old.bet_value
     or new.rule_text      is distinct from old.rule_text
     or new.league_ids     is distinct from old.league_ids
     or new.league_mode    is distinct from old.league_mode
     or new.deliver_at     is distinct from old.deliver_at
     or new.target_day     is distinct from old.target_day
     or new.kickoff_at     is distinct from old.kickoff_at
     or new.kickoff_until  is distinct from old.kickoff_until
     or new.selectivity    is distinct from old.selectivity
     or new.min_edge       is distinct from old.min_edge
     or new.max_per_prediction is distinct from old.max_per_prediction
     or new.learning       is distinct from old.learning
  then
    raise exception 'FREE_AGENT_LOCKED: tuning an agent is a Pro feature';
  end if;
  return new;
end;
$function$;

create or replace function public.enforce_generated_acca_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_plan text;
  v_tz text;
  v_limit integer;
  v_max_legs integer;
  v_count integer;
begin
  if coalesce(new.source, '') <> 'generated' then
    return new;
  end if;

  select plan, coalesce(timezone, 'Africa/Lagos') into v_plan, v_tz from profiles where id = new.user_id;
  v_plan := coalesce(v_plan, 'free');
  v_tz := coalesce(v_tz, 'Africa/Lagos');

  if v_plan in ('pro', 'pro_max') then
    v_limit := null;
    v_max_legs := 24;
  else
    v_limit := 1;
    v_max_legs := 3;
  end if;

  if coalesce(new.leg_count, 0) > v_max_legs then
    raise exception 'GEN_ACCA_LEGS:%:%', v_plan, v_max_legs using errcode = 'check_violation';
  end if;

  if v_limit is not null then
    select count(*) into v_count from accumulators
      where user_id = new.user_id and source = 'generated'
        and (created_at at time zone v_tz)::date = (now() at time zone v_tz)::date;
    if v_count >= v_limit then
      raise exception 'DAILY_GEN_LIMIT:%:%', v_plan, v_limit using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$function$;

-- Mirror of remotely applied migration proven_rules_over25_owner_floor (2026-09-03).
-- Owner ruling: Over 2.5 is to be available for acca-building and agent deployment at combined
-- blend >= 4.5, its best honest backtested cell (73.1% on 947 holdout games). Over 2.5's true
-- ceiling sits below the generic 75% publish bar (goals alone can't do better — the model screen
-- on live agents lifts it further), so publish its best fixtures lab cell down to a 70% floor.
-- Every other market keeps the 75% bar. The library card still shows the real % + n, so nothing
-- is overstated. Only the fixtures-fallback WHERE clause differs from the prior definition.
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
  order by grid.market_key,
    (((grid.won::float/grid.n) + 1.92/grid.n - 1.96 * sqrt(((grid.won::float/grid.n)*(1-(grid.won::float/grid.n)) + 0.9604/grid.n)/grid.n)) / (1 + 3.8416/grid.n)) desc;

  insert into public.proven_rules (market_key, market_label, rule_text, filters, n, won, hit, computed_at, source)
  select distinct on (l.market_key)
    l.market_key,
    case l.market_key
      when 'over_0_5' then 'Over 0.5 goals'
      when 'over_1_5' then 'Over 1.5 goals'
      when 'over_2_5' then 'Over 2.5 goals'
      when 'over_3_5' then 'Over 3.5 goals'
      when 'under_2_5' then 'Under 2.5 goals'
      when 'under_3_5' then 'Under 3.5 goals'
      when 'btts' then 'Both teams to score'
      when 'home_to_score' then 'Home team to score'
      when 'away_to_score' then 'Away team to score'
      when 'home_win' then 'Home win'
      when 'away_win' then 'Away win'
      when 'double_chance_1x' then 'Double chance (1X)'
      when 'double_chance_x2' then 'Double chance (X2)'
      when 'double_chance_12' then 'Double chance (12)'
      else l.market_key end,
    l.rule_text, l.filters,
    l.holdout_n, l.holdout_won, round(100.0 * l.holdout_won / l.holdout_n, 1), now(), 'fixtures'
  from public.rule_lab l
  where l.holdout_n > 0
    and (100.0 * l.holdout_won / l.holdout_n >= 75
         or (l.market_key = 'over_2_5' and 100.0 * l.holdout_won / l.holdout_n >= 70))
    and not exists (select 1 from public.proven_rules p where p.market_key = l.market_key)
  order by l.market_key, l.wilson_lb desc;
end;
$function$;

-- Mirror of remotely applied migration rule_lab_higher_blend_candidates (2026-09-03).
-- Over 2.5 (and Over 3.5) live in the higher-blend range: the holdout hit rate keeps climbing past
-- blend 3.5 (67% -> 70.8% at 4.0 -> 72.8% at 4.5, n>=900 each, 2026-09-03 backtest). The miner only
-- carried candidates up to 3.5, so the lab could never natively surface the Over 2.5 knee — only the
-- daily review routine added it as an adhoc cell (wiped each mine). Add 3.8/4.0/4.2/4.5 (and a
-- blend>=4.0 & home_avg>=1.8 combo) so every Mon+Thu mine tracks them permanently. Additive only
-- (more candidate rows); the single fixtures scan is unchanged, so no extra disk IO.
create or replace function public.mine_rule_lab_inner()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_n integer;
begin
  create temp table _m on commit drop as
  with res as (
    select id, kickoff_utc, home_team_id, away_team_id,
           coalesce(ft_home, home_goals) as hg, coalesce(ft_away, away_goals) as ag
    from public.fixtures
    where status in ('FT','AET','PEN') and home_team_id is not null and away_team_id is not null
      and coalesce(ft_home, home_goals) is not null and coalesce(ft_away, away_goals) is not null
      and kickoff_utc >= now() - interval '24 months'  -- IO diet: recent football is the football rules bet on
  ),
  tg as (
    select id as fid, home_team_id as team_id, kickoff_utc, hg as gf, ag as ga,
           case when hg > ag then 3 when hg = ag then 1 else 0 end as pts,
           (hg > ag)::int as win, true as is_home
    from res
    union all
    select id, away_team_id, kickoff_utc, ag, hg,
           case when ag > hg then 3 when ag = hg then 1 else 0 end,
           (ag > hg)::int, false
    from res
  ),
  form as (
    select fid, is_home,
           sum(gf + ga) over w as tot5, sum(gf) over w as gf5,
           sum(pts) over w as pts5, sum(win) over w as wins5,
           count(*) over w as n5
    from tg
    window w as (partition by team_id order by kickoff_utc, fid rows between 5 preceding and 1 preceding)
  )
  select r.id,
         (r.kickoff_utc < now() - interval '60 days') as is_train,
         r.hg::int as hg, r.ag::int as ag,
         (hf.tot5 + af.tot5) / 10.0 as gb,
         least(hf.tot5, af.tot5) / 5.0 as mgb,
         hf.gf5 / 5.0 as havg, af.gf5 / 5.0 as aavg,
         hf.pts5 / 5.0 as hppg, af.pts5 / 5.0 as appg,
         hf.wins5 as hw5, af.wins5 as aw5
  from res r
  join form hf on hf.fid = r.id and hf.is_home
  join form af on af.fid = r.id and not af.is_home
  where hf.n5 = 5 and af.n5 = 5;

  create temp table _c on commit drop as
  select * from (values
    ('goals_blend_gte_2.4', 'Only games where the two teams combined blend is at least 2.4',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',2.4,'value2',0)),
     'goals_blend', 'gte', 2.4::numeric, null::text, null::numeric),
    ('goals_blend_gte_2.8', 'Only games where the two teams combined blend is at least 2.8',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',2.8,'value2',0)),
     'goals_blend', 'gte', 2.8, null, null),
    ('goals_blend_gte_3.0', 'Only games where the two teams combined blend is at least 3.0',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',3.0,'value2',0)),
     'goals_blend', 'gte', 3.0, null, null),
    ('goals_blend_gte_3.2', 'Only games where the two teams combined blend is at least 3.2',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',3.2,'value2',0)),
     'goals_blend', 'gte', 3.2, null, null),
    ('goals_blend_gte_3.5', 'Only games where the two teams combined blend is at least 3.5',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',3.5,'value2',0)),
     'goals_blend', 'gte', 3.5, null, null),
    ('goals_blend_gte_3.8', 'Only games where the two teams combined blend is at least 3.8',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',3.8,'value2',0)),
     'goals_blend', 'gte', 3.8, null, null),
    ('goals_blend_gte_4.0', 'Only games where the two teams combined blend is at least 4.0',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',4.0,'value2',0)),
     'goals_blend', 'gte', 4.0, null, null),
    ('goals_blend_gte_4.2', 'Only games where the two teams combined blend is at least 4.2',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',4.2,'value2',0)),
     'goals_blend', 'gte', 4.2, null, null),
    ('goals_blend_gte_4.5', 'Only games where the two teams combined blend is at least 4.5',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',4.5,'value2',0)),
     'goals_blend', 'gte', 4.5, null, null),
    ('goals_blend_lte_2.0', 'Only games where the two teams combined blend is at most 2.0',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','lte','value',2.0,'value2',0)),
     'goals_blend', 'lte', 2.0, null, null),
    ('goals_blend_lte_2.2', 'Only games where the two teams combined blend is at most 2.2',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','lte','value',2.2,'value2',0)),
     'goals_blend', 'lte', 2.2, null, null),
    ('goals_blend_lte_2.4', 'Only games where the two teams combined blend is at most 2.4',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','lte','value',2.4,'value2',0)),
     'goals_blend', 'lte', 2.4, null, null),
    ('min_goals_blend_gte_2.0', 'Only games where the lower of the two teams'' blends is at least 2.0',
     jsonb_build_array(jsonb_build_object('field','min_goals_blend','op','gte','value',2.0,'value2',0)),
     'min_goals_blend', 'gte', 2.0, null, null),
    ('min_goals_blend_gte_2.5', 'Only games where the lower of the two teams'' blends is at least 2.5',
     jsonb_build_array(jsonb_build_object('field','min_goals_blend','op','gte','value',2.5,'value2',0)),
     'min_goals_blend', 'gte', 2.5, null, null),
    ('min_goals_blend_gte_3.0', 'Only games where the lower of the two teams'' blends is at least 3.0',
     jsonb_build_array(jsonb_build_object('field','min_goals_blend','op','gte','value',3.0,'value2',0)),
     'min_goals_blend', 'gte', 3.0, null, null),
    ('home_goals_avg_gte_1.2', 'Only games where the home team averages at least 1.2 goals per game',
     jsonb_build_array(jsonb_build_object('field','home_goals_avg','op','gte','value',1.2,'value2',0)),
     'home_goals_avg', 'gte', 1.2, null, null),
    ('home_goals_avg_gte_1.5', 'Only games where the home team averages at least 1.5 goals per game',
     jsonb_build_array(jsonb_build_object('field','home_goals_avg','op','gte','value',1.5,'value2',0)),
     'home_goals_avg', 'gte', 1.5, null, null),
    ('home_goals_avg_gte_1.8', 'Only games where the home team averages at least 1.8 goals per game',
     jsonb_build_array(jsonb_build_object('field','home_goals_avg','op','gte','value',1.8,'value2',0)),
     'home_goals_avg', 'gte', 1.8, null, null),
    ('home_goals_avg_gte_2.0', 'Only games where the home team averages at least 2.0 goals per game',
     jsonb_build_array(jsonb_build_object('field','home_goals_avg','op','gte','value',2.0,'value2',0)),
     'home_goals_avg', 'gte', 2.0, null, null),
    ('away_goals_avg_gte_1.2', 'Only games where the away team averages at least 1.2 goals per game',
     jsonb_build_array(jsonb_build_object('field','away_goals_avg','op','gte','value',1.2,'value2',0)),
     'away_goals_avg', 'gte', 1.2, null, null),
    ('away_goals_avg_gte_1.5', 'Only games where the away team averages at least 1.5 goals per game',
     jsonb_build_array(jsonb_build_object('field','away_goals_avg','op','gte','value',1.5,'value2',0)),
     'away_goals_avg', 'gte', 1.5, null, null),
    ('away_goals_avg_gte_1.8', 'Only games where the away team averages at least 1.8 goals per game',
     jsonb_build_array(jsonb_build_object('field','away_goals_avg','op','gte','value',1.8,'value2',0)),
     'away_goals_avg', 'gte', 1.8, null, null),
    ('home_form_ppg_gte_1.8', 'Only games where the home team averages at least 1.8 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','home_form_ppg','op','gte','value',1.8,'value2',0)),
     'home_form_ppg', 'gte', 1.8, null, null),
    ('home_form_ppg_gte_2.0', 'Only games where the home team averages at least 2.0 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','home_form_ppg','op','gte','value',2.0,'value2',0)),
     'home_form_ppg', 'gte', 2.0, null, null),
    ('home_form_ppg_gte_2.2', 'Only games where the home team averages at least 2.2 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','home_form_ppg','op','gte','value',2.2,'value2',0)),
     'home_form_ppg', 'gte', 2.2, null, null),
    ('away_form_ppg_gte_1.8', 'Only games where the away team averages at least 1.8 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','away_form_ppg','op','gte','value',1.8,'value2',0)),
     'away_form_ppg', 'gte', 1.8, null, null),
    ('away_form_ppg_gte_2.0', 'Only games where the away team averages at least 2.0 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','away_form_ppg','op','gte','value',2.0,'value2',0)),
     'away_form_ppg', 'gte', 2.0, null, null),
    ('home_wins_last5_gte_3', 'Only games where the home team has won at least 3 of their last 5 games',
     jsonb_build_array(jsonb_build_object('field','home_wins_last5','op','gte','value',3,'value2',0)),
     'home_wins_last5', 'gte', 3, null, null),
    ('home_wins_last5_gte_4', 'Only games where the home team has won at least 4 of their last 5 games',
     jsonb_build_array(jsonb_build_object('field','home_wins_last5','op','gte','value',4,'value2',0)),
     'home_wins_last5', 'gte', 4, null, null),
    ('away_wins_last5_gte_3', 'Only games where the away team has won at least 3 of their last 5 games',
     jsonb_build_array(jsonb_build_object('field','away_wins_last5','op','gte','value',3,'value2',0)),
     'away_wins_last5', 'gte', 3, null, null),
    ('away_wins_last5_gte_4', 'Only games where the away team has won at least 4 of their last 5 games',
     jsonb_build_array(jsonb_build_object('field','away_wins_last5','op','gte','value',4,'value2',0)),
     'away_wins_last5', 'gte', 4, null, null),
    ('goals_blend_gte_2.8_home_goals_avg_gte_1.5',
     'Only games where the two teams combined blend is at least 2.8 and the home team averages at least 1.5 goals per game',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',2.8,'value2',0),
                       jsonb_build_object('field','home_goals_avg','op','gte','value',1.5,'value2',0)),
     'goals_blend', 'gte', 2.8, 'home_goals_avg', 1.5),
    ('goals_blend_gte_2.8_home_goals_avg_gte_1.8',
     'Only games where the two teams combined blend is at least 2.8 and the home team averages at least 1.8 goals per game',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',2.8,'value2',0),
                       jsonb_build_object('field','home_goals_avg','op','gte','value',1.8,'value2',0)),
     'goals_blend', 'gte', 2.8, 'home_goals_avg', 1.8),
    ('goals_blend_gte_3.0_home_goals_avg_gte_1.5',
     'Only games where the two teams combined blend is at least 3.0 and the home team averages at least 1.5 goals per game',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',3.0,'value2',0),
                       jsonb_build_object('field','home_goals_avg','op','gte','value',1.5,'value2',0)),
     'goals_blend', 'gte', 3.0, 'home_goals_avg', 1.5),
    ('goals_blend_gte_3.0_home_goals_avg_gte_1.8',
     'Only games where the two teams combined blend is at least 3.0 and the home team averages at least 1.8 goals per game',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',3.0,'value2',0),
                       jsonb_build_object('field','home_goals_avg','op','gte','value',1.8,'value2',0)),
     'goals_blend', 'gte', 3.0, 'home_goals_avg', 1.8),
    ('goals_blend_gte_4.0_home_goals_avg_gte_1.8',
     'Only games where the two teams combined blend is at least 4.0 and the home team averages at least 1.8 goals per game',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','gte','value',4.0,'value2',0),
                       jsonb_build_object('field','home_goals_avg','op','gte','value',1.8,'value2',0)),
     'goals_blend', 'gte', 4.0, 'home_goals_avg', 1.8),
    ('home_form_ppg_gte_2.0_home_goals_avg_gte_1.5',
     'Only games where the home team averages at least 2.0 points per game over their last 5 and the home team averages at least 1.5 goals per game',
     jsonb_build_array(jsonb_build_object('field','home_form_ppg','op','gte','value',2.0,'value2',0),
                       jsonb_build_object('field','home_goals_avg','op','gte','value',1.5,'value2',0)),
     'home_form_ppg', 'gte', 2.0, 'home_goals_avg', 1.5),
    ('home_form_ppg_gte_2.2_home_wins_last5_gte_4',
     'Only games where the home team averages at least 2.2 points per game over their last 5 and the home team has won at least 4 of their last 5 games',
     jsonb_build_array(jsonb_build_object('field','home_form_ppg','op','gte','value',2.2,'value2',0),
                       jsonb_build_object('field','home_wins_last5','op','gte','value',4,'value2',0)),
     'home_form_ppg', 'gte', 2.2, 'home_wins_last5', 4)
  ) as t(cond_key, rule_text, filters, f1, o1, v1, f2, v2);

  delete from public.rule_lab;

  insert into public.rule_lab
    (market_key, cond_key, rule_text, filters, train_n, train_won, holdout_n, holdout_won, wilson_lb, computed_at)
  select g.market_key, g.cond_key, g.rule_text, g.filters, g.tn, g.tw, g.hn, g.hw,
         round(((w.p + 1.92 / g.hn - 1.96 * sqrt((w.p * (1 - w.p) + 0.9604 / g.hn) / g.hn)) / (1 + 3.8416 / g.hn)), 4),
         now()
  from (
    select o.market_key, c.cond_key, c.rule_text, c.filters,
           count(*) filter (where m.is_train)::int as tn,
           count(*) filter (where m.is_train and o.hit)::int as tw,
           count(*) filter (where not m.is_train)::int as hn,
           count(*) filter (where not m.is_train and o.hit)::int as hw
    from _m m
    join _c c on (
      case c.f1
        when 'goals_blend'     then case when c.o1 = 'gte' then m.gb >= c.v1 else m.gb <= c.v1 end
        when 'min_goals_blend' then m.mgb >= c.v1
        when 'home_goals_avg'  then m.havg >= c.v1
        when 'away_goals_avg'  then m.aavg >= c.v1
        when 'home_form_ppg'   then m.hppg >= c.v1
        when 'away_form_ppg'   then m.appg >= c.v1
        when 'home_wins_last5' then m.hw5 >= c.v1
        when 'away_wins_last5' then m.aw5 >= c.v1
      end
      and (c.f2 is null or case c.f2
        when 'home_goals_avg'  then m.havg >= c.v2
        when 'home_wins_last5' then m.hw5 >= c.v2
      end)
    )
    cross join lateral (values
      ('over_0_5',         m.hg + m.ag >= 1),
      ('over_1_5',         m.hg + m.ag >= 2),
      ('over_2_5',         m.hg + m.ag >= 3),
      ('over_3_5',         m.hg + m.ag >= 4),
      ('under_2_5',        m.hg + m.ag <= 2),
      ('under_3_5',        m.hg + m.ag <= 3),
      ('btts',             m.hg >= 1 and m.ag >= 1),
      ('home_to_score',    m.hg >= 1),
      ('away_to_score',    m.ag >= 1),
      ('home_win',         m.hg > m.ag),
      ('away_win',         m.ag > m.hg),
      ('double_chance_1x', m.hg >= m.ag),
      ('double_chance_x2', m.ag >= m.hg),
      ('double_chance_12', m.hg <> m.ag)
    ) o(market_key, hit)
    group by o.market_key, c.cond_key, c.rule_text, c.filters
  ) g
  cross join lateral (select g.hw::numeric / nullif(g.hn, 0) as p) w
  where g.tn >= 1000 and g.hn >= 300;

  select count(*) into v_n from public.rule_lab;
  drop table _m;
  drop table _c;
  return v_n;
end $function$;

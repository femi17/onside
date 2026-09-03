-- Disk IO diet (2026-09-03, after Supabase's Disk IO Budget warning). Mirror of remotely
-- applied migration `disk_io_diet`. The fixtures table (233MB) shows 2.6 BILLION cumulative
-- seq-read rows; the rule-lab mine full-scanned it with large temp spills. Three cuts, ~85% of
-- the lab's IO for ~2% of its statistical power:
-- 1. mine_rule_lab_inner trains on the last 24 MONTHS instead of all history (still 300K+
--    games; holdout was always the last 60 days).
-- 2. The mine runs Mon+Thu 03:15 UTC instead of nightly (60-day windows move slowly).
-- 3. cron.job_run_details (37MB, never pruned) gets a weekly trim.
-- The rule-lab-review routine was also updated: max 3 experiments/day, 24-month window only.

create or replace function public.mine_rule_lab_inner()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_n integer;
begin
  -- ONE scan of the finished-fixtures history: per fixture, both teams' rolling last-5 form
  -- (games strictly before kickoff) via window functions, kept only when BOTH sides have a
  -- full 5-game window. is_train splits on the 60-day holdout cut.
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
         (hf.tot5 + af.tot5) / 10.0 as gb,          -- goals_blend: avg of both teams' (gf+ga)/5
         least(hf.tot5, af.tot5) / 5.0 as mgb,      -- min_goals_blend: the lower team blend
         hf.gf5 / 5.0 as havg, af.gf5 / 5.0 as aavg,
         hf.pts5 / 5.0 as hppg, af.pts5 / 5.0 as appg,
         hf.wins5 as hw5, af.wins5 as aw5
  from res r
  join form hf on hf.fid = r.id and hf.is_home
  join form af on af.fid = r.id and not af.is_home
  where hf.n5 = 5 and af.n5 = 5;

  -- the condition grid: ONLY rule-engine fields, rule_text in the parser's exact idiom,
  -- filters in the engine-ready {field, op, value, value2} shape refresh_proven_rules uses
  create temp table _c on commit drop as
  select * from (values
    -- goals_blend >= X
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
    -- goals_blend <= X
    ('goals_blend_lte_2.0', 'Only games where the two teams combined blend is at most 2.0',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','lte','value',2.0,'value2',0)),
     'goals_blend', 'lte', 2.0, null, null),
    ('goals_blend_lte_2.2', 'Only games where the two teams combined blend is at most 2.2',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','lte','value',2.2,'value2',0)),
     'goals_blend', 'lte', 2.2, null, null),
    ('goals_blend_lte_2.4', 'Only games where the two teams combined blend is at most 2.4',
     jsonb_build_array(jsonb_build_object('field','goals_blend','op','lte','value',2.4,'value2',0)),
     'goals_blend', 'lte', 2.4, null, null),
    -- min_goals_blend >= X (the lower of the two team blends)
    ('min_goals_blend_gte_2.0', 'Only games where the lower of the two teams'' blends is at least 2.0',
     jsonb_build_array(jsonb_build_object('field','min_goals_blend','op','gte','value',2.0,'value2',0)),
     'min_goals_blend', 'gte', 2.0, null, null),
    ('min_goals_blend_gte_2.5', 'Only games where the lower of the two teams'' blends is at least 2.5',
     jsonb_build_array(jsonb_build_object('field','min_goals_blend','op','gte','value',2.5,'value2',0)),
     'min_goals_blend', 'gte', 2.5, null, null),
    ('min_goals_blend_gte_3.0', 'Only games where the lower of the two teams'' blends is at least 3.0',
     jsonb_build_array(jsonb_build_object('field','min_goals_blend','op','gte','value',3.0,'value2',0)),
     'min_goals_blend', 'gte', 3.0, null, null),
    -- home_goals_avg >= X
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
    -- away_goals_avg >= X
    ('away_goals_avg_gte_1.2', 'Only games where the away team averages at least 1.2 goals per game',
     jsonb_build_array(jsonb_build_object('field','away_goals_avg','op','gte','value',1.2,'value2',0)),
     'away_goals_avg', 'gte', 1.2, null, null),
    ('away_goals_avg_gte_1.5', 'Only games where the away team averages at least 1.5 goals per game',
     jsonb_build_array(jsonb_build_object('field','away_goals_avg','op','gte','value',1.5,'value2',0)),
     'away_goals_avg', 'gte', 1.5, null, null),
    ('away_goals_avg_gte_1.8', 'Only games where the away team averages at least 1.8 goals per game',
     jsonb_build_array(jsonb_build_object('field','away_goals_avg','op','gte','value',1.8,'value2',0)),
     'away_goals_avg', 'gte', 1.8, null, null),
    -- home_form_ppg >= X
    ('home_form_ppg_gte_1.8', 'Only games where the home team averages at least 1.8 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','home_form_ppg','op','gte','value',1.8,'value2',0)),
     'home_form_ppg', 'gte', 1.8, null, null),
    ('home_form_ppg_gte_2.0', 'Only games where the home team averages at least 2.0 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','home_form_ppg','op','gte','value',2.0,'value2',0)),
     'home_form_ppg', 'gte', 2.0, null, null),
    ('home_form_ppg_gte_2.2', 'Only games where the home team averages at least 2.2 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','home_form_ppg','op','gte','value',2.2,'value2',0)),
     'home_form_ppg', 'gte', 2.2, null, null),
    -- away_form_ppg >= X
    ('away_form_ppg_gte_1.8', 'Only games where the away team averages at least 1.8 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','away_form_ppg','op','gte','value',1.8,'value2',0)),
     'away_form_ppg', 'gte', 1.8, null, null),
    ('away_form_ppg_gte_2.0', 'Only games where the away team averages at least 2.0 points per game over their last 5',
     jsonb_build_array(jsonb_build_object('field','away_form_ppg','op','gte','value',2.0,'value2',0)),
     'away_form_ppg', 'gte', 2.0, null, null),
    -- wins in the last 5
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
    -- two-condition combos: goal-heavy pairing + a scoring home side (over-family hunters)
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
    -- two-condition combos: in-form homes that score / dominant homes (result-family hunters)
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

  -- conditions x outcomes evaluated in ONE grouped pass over the joined match set: the join
  -- keeps only matches passing each condition, the lateral fans out to the 14 outcomes, and a
  -- single aggregation fills every cell. No per-cell rescans of fixtures.
  insert into public.rule_lab
    (market_key, cond_key, rule_text, filters, train_n, train_won, holdout_n, holdout_won, wilson_lb, computed_at)
  select g.market_key, g.cond_key, g.rule_text, g.filters, g.tn, g.tw, g.hn, g.hw,
         -- Wilson lower bound (z=1.96) on the HOLDOUT — same formula as refresh_proven_rules
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
  -- the keep bar: enough games on BOTH sides of the split; winners AND losers are stored
  where g.tn >= 1000 and g.hn >= 300;

  select count(*) into v_n from public.rule_lab;
  drop table _m;
  drop table _c;
  return v_n;
end $function$;

-- 2. mine twice weekly instead of nightly
do $$
begin
  perform cron.unschedule('rule-lab-nightly');
exception when others then null;
end $$;
select cron.schedule('rule-lab-nightly', '15 3 * * 1,4', $$set statement_timeout = '900000'; select public.mine_rule_lab();$$);

-- 3. prune the cron run log weekly (37MB and never cleaned)
do $$
begin
  perform cron.unschedule('cron-log-prune');
exception when others then null;
end $$;
select cron.schedule('cron-log-prune', '45 4 * * 0', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);

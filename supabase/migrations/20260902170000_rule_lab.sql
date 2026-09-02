-- 🧪 Rule Lab (owner-directed 2026-09-02): a nightly in-database grid search that fine-tunes
-- betting-rule candidates for every common market over the FULL fixtures history (~769K finished
-- games), extending the proven-rules library beyond what settled agent picks can teach.
--
-- 1. rule_lab: every candidate cell's latest evaluation — (market x condition) with a 60-day
--    time-split: train = everything older than 60 days, holdout = the newest 60 days, both
--    requiring full 5-game form for BOTH teams. The lab is a record, not a leaderboard: every
--    cell clearing the sample bar (train_n >= 1000 AND holdout_n >= 300) is stored, winners and
--    losers alike, ranked by the Wilson lower bound (z=1.96) on the HOLDOUT.
-- 2. mine_rule_lab(): one pass over the fixtures history (window-function form, temp tables),
--    then ONE grouped aggregation over conditions x outcomes — the fixtures scan happens once,
--    never per cell. Grid: 33 condition cells (goals_blend / min_goals_blend / goals averages /
--    form ppg / wins-last-5 thresholds + 6 principled two-condition combos) x 14 outcomes = 462
--    evaluated cells. Conditions use ONLY fields the agent rule engine expresses, and rule_text
--    is the exact plain English the rule parser understands (refresh_proven_rules idiom).
--    Nightly cron rule-lab-nightly at 03:15 UTC.
-- 3. refresh_proven_rules v2: body unchanged for the deliveries-based grid; afterwards, any
--    market in the lab's outcome list that got NO deliveries-based row borrows the best rule_lab
--    cell (highest holdout Wilson LB) IF its holdout hit clears the same 75% bar — stored with
--    n/won/hit from the HOLDOUT. New proven_rules.source column ('picks' | 'fixtures') lets the
--    UI caption receipts honestly ("graded agent picks" vs "backtested on the match history").

create table if not exists public.rule_lab (
  market_key text not null,
  cond_key text not null,
  rule_text text not null,
  filters jsonb not null,
  train_n integer not null,
  train_won integer not null,
  holdout_n integer not null,
  holdout_won integer not null,
  wilson_lb numeric not null,
  computed_at timestamptz not null default now(),
  primary key (market_key, cond_key)
);
alter table public.rule_lab enable row level security;
drop policy if exists rule_lab_read on public.rule_lab;
create policy rule_lab_read on public.rule_lab for select to authenticated using (true);
-- writes only via the definer miner below

-- The public entry point wraps the worker with a widened statement_timeout: the grid insert
-- legitimately runs past the platform's 2-minute session default (33 conditions x 14 outcomes
-- over ~700K matches) — the first seed attempt died on exactly that (2026-09-02, canceling
-- statement due to statement timeout under pg_cron).
create or replace function public.mine_rule_lab()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform set_config('statement_timeout', '900000', true);
  return public.mine_rule_lab_inner();
end $function$;

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

revoke all on function public.mine_rule_lab() from public;
revoke all on function public.mine_rule_lab() from anon;
revoke all on function public.mine_rule_lab() from authenticated;
revoke all on function public.mine_rule_lab_inner() from public;
revoke all on function public.mine_rule_lab_inner() from anon;
revoke all on function public.mine_rule_lab_inner() from authenticated;

-- receipts honesty: where did a proven rule's record come from?
-- 'picks' = graded agent picks (deliveries) · 'fixtures' = the rule-lab fixtures backtest
alter table public.proven_rules add column if not exists source text not null default 'picks';

-- refresh_proven_rules v2: the deliveries-based grid is UNCHANGED (copied exactly); after it,
-- markets with no picks-based row borrow the best rule_lab cell (highest holdout Wilson LB)
-- when its holdout hit clears the same 75% bar — n/won/hit come from the holdout, labelled
-- source='fixtures'. The weekly cron reads whatever the nightly lab last mined.
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

  -- fixtures-history fallback (rule lab): markets the deliveries grid could NOT master yet
  -- borrow their best lab cell — promote bar: holdout hit >= 75% (same bar as picks rows;
  -- the lab's own keep bar already guarantees holdout_n >= 300)
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
    and 100.0 * l.holdout_won / l.holdout_n >= 75
    and not exists (select 1 from public.proven_rules p where p.market_key = l.market_key)
  order by l.market_key, l.wilson_lb desc;
end;
$function$;

-- nightly lab mine at 03:15 UTC — in-database via pg_cron, so no API timeout applies
do $$
begin
  perform cron.unschedule('rule-lab-nightly');
exception when others then null;
end $$;
-- statement_timeout must be raised as its OWN statement before the call: a timeout change
-- cannot affect a statement already running, so setting it inside the function (or in the same
-- statement) does nothing — two seed attempts died at exactly 2:00 proving it (2026-09-02).
select cron.schedule('rule-lab-nightly', '15 3 * * *', $$set statement_timeout = '900000'; select public.mine_rule_lab();$$);

-- Seeding note: the inline seed exceeded the migration API's timeout — the first mine was run
-- via a one-shot pg_cron ('rule-lab-seed', removed after success). The nightly cron owns it
-- from here.

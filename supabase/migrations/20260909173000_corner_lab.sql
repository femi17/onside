-- 🚩 Corner Lab (owner-directed 2026-09-09): the goals rule_lab / model_signal_lab are goals-only, so
-- corner over/under markets had NO backtested rule to lean on (live sample was tiny: n=8-56). This
-- adds a nightly in-database grid search for corner totals over the corner history we hold in
-- fixture_stats (~24K finished fixtures with corners, ~13 months), so corner markets can earn a
-- validated proven rule the same way the goals markets did. Corners keep farming live meanwhile.
--
-- Mirrors mine_rule_lab: ONE scan (window-function last-5 corner form for BOTH teams), then ONE
-- grouped aggregation over conditions x corner outcomes. 60-day train/holdout split, both teams
-- needing a full 5-game corner window. Conditions use ONLY fields the rule engine already exposes
-- (corners_avg / home_corners_avg / away_corners_avg — each team's OWN corners per game, last 5).
-- Keep bar: train_n >= 1000 AND holdout_n >= 200 (corner history is ~24K, not the ~700K of goals).

create table if not exists public.corner_lab (
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
alter table public.corner_lab enable row level security;
drop policy if exists corner_lab_read on public.corner_lab;
create policy corner_lab_read on public.corner_lab for select to authenticated using (true);

create or replace function public.mine_corner_lab()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform set_config('statement_timeout', '900000', true);
  return public.mine_corner_lab_inner();
end $function$;

create or replace function public.mine_corner_lab_inner()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_n integer;
begin
  -- ONE scan of finished fixtures that carry corner stats: per fixture, both teams' rolling last-5
  -- average OWN corners (games strictly before kickoff), kept only when BOTH have a full 5-window.
  create temp table _mc on commit drop as
  with res as (
    select f.id, f.kickoff_utc, f.home_team_id, f.away_team_id,
           fs.corners_home::numeric as ch, fs.corners_away::numeric as ca
    from public.fixtures f
    join public.fixture_stats fs on fs.fixture_id = f.id
    where f.status in ('FT','AET','PEN') and f.home_team_id is not null and f.away_team_id is not null
      and fs.corners_home is not null and fs.corners_away is not null
      and f.kickoff_utc >= now() - interval '24 months'
  ),
  tg as (
    select id as fid, home_team_id as team_id, kickoff_utc, ch as cf, true as is_home from res
    union all
    select id, away_team_id, kickoff_utc, ca, false from res
  ),
  form as (
    select fid, is_home,
           avg(cf) over w as cfor5, count(*) over w as n5
    from tg
    window w as (partition by team_id order by kickoff_utc, fid rows between 5 preceding and 1 preceding)
  )
  select r.id,
         (r.kickoff_utc < now() - interval '60 days') as is_train,
         (r.ch + r.ca) as total,
         hf.cfor5 as havg, af.cfor5 as aavg,
         (hf.cfor5 + af.cfor5) as cavg   -- corners_avg: both teams' own-corner averages summed
  from res r
  join form hf on hf.fid = r.id and hf.is_home
  join form af on af.fid = r.id and not af.is_home
  where hf.n5 = 5 and af.n5 = 5;

  -- condition grid: rule-engine corner fields only, filters in the engine-ready {field,op,value} shape
  create temp table _cc on commit drop as
  select * from (values
    ('corners_avg_gte_9.0', 'Only games where the two teams average at least 9.0 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','gte','value',9.0,'value2',0)), 'corners_avg', 'gte', 9.0::numeric),
    ('corners_avg_gte_9.5', 'Only games where the two teams average at least 9.5 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','gte','value',9.5,'value2',0)), 'corners_avg', 'gte', 9.5),
    ('corners_avg_gte_10.0', 'Only games where the two teams average at least 10.0 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','gte','value',10.0,'value2',0)), 'corners_avg', 'gte', 10.0),
    ('corners_avg_gte_10.5', 'Only games where the two teams average at least 10.5 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','gte','value',10.5,'value2',0)), 'corners_avg', 'gte', 10.5),
    ('corners_avg_gte_11.0', 'Only games where the two teams average at least 11.0 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','gte','value',11.0,'value2',0)), 'corners_avg', 'gte', 11.0),
    ('corners_avg_gte_11.5', 'Only games where the two teams average at least 11.5 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','gte','value',11.5,'value2',0)), 'corners_avg', 'gte', 11.5),
    ('corners_avg_gte_12.0', 'Only games where the two teams average at least 12.0 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','gte','value',12.0,'value2',0)), 'corners_avg', 'gte', 12.0),
    ('corners_avg_lte_9.0', 'Only games where the two teams average at most 9.0 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','lte','value',9.0,'value2',0)), 'corners_avg', 'lte', 9.0),
    ('corners_avg_lte_8.5', 'Only games where the two teams average at most 8.5 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','lte','value',8.5,'value2',0)), 'corners_avg', 'lte', 8.5),
    ('corners_avg_lte_8.0', 'Only games where the two teams average at most 8.0 corners combined over their last 5',
      jsonb_build_array(jsonb_build_object('field','corners_avg','op','lte','value',8.0,'value2',0)), 'corners_avg', 'lte', 8.0),
    ('home_corners_avg_gte_5.5', 'Only games where the home team averages at least 5.5 corners per game over their last 5',
      jsonb_build_array(jsonb_build_object('field','home_corners_avg','op','gte','value',5.5,'value2',0)), 'home_corners_avg', 'gte', 5.5),
    ('home_corners_avg_gte_6.0', 'Only games where the home team averages at least 6.0 corners per game over their last 5',
      jsonb_build_array(jsonb_build_object('field','home_corners_avg','op','gte','value',6.0,'value2',0)), 'home_corners_avg', 'gte', 6.0),
    ('away_corners_avg_gte_5.5', 'Only games where the away team averages at least 5.5 corners per game over their last 5',
      jsonb_build_array(jsonb_build_object('field','away_corners_avg','op','gte','value',5.5,'value2',0)), 'away_corners_avg', 'gte', 5.5),
    ('away_corners_avg_gte_6.0', 'Only games where the away team averages at least 6.0 corners per game over their last 5',
      jsonb_build_array(jsonb_build_object('field','away_corners_avg','op','gte','value',6.0,'value2',0)), 'away_corners_avg', 'gte', 6.0)
  ) as t(cond_key, rule_text, filters, f1, o1, v1);

  delete from public.corner_lab;

  insert into public.corner_lab
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
    from _mc m
    join _cc c on (
      case c.f1
        when 'corners_avg'      then case when c.o1 = 'gte' then m.cavg >= c.v1 else m.cavg <= c.v1 end
        when 'home_corners_avg' then m.havg >= c.v1
        when 'away_corners_avg' then m.aavg >= c.v1
      end
    )
    cross join lateral (values
      ('over_8_5_corners',  m.total >= 9),
      ('over_9_5_corners',  m.total >= 10),
      ('over_10_5_corners', m.total >= 11),
      ('over_11_5_corners', m.total >= 12),
      ('under_8_5_corners', m.total <= 8),
      ('under_9_5_corners', m.total <= 9),
      ('under_10_5_corners', m.total <= 10)
    ) o(market_key, hit)
    group by o.market_key, c.cond_key, c.rule_text, c.filters
  ) g
  cross join lateral (select g.hw::numeric / nullif(g.hn, 0) as p) w
  where g.tn >= 1000 and g.hn >= 200;

  select count(*) into v_n from public.corner_lab;
  drop table _mc;
  drop table _cc;
  return v_n;
end $function$;

revoke all on function public.mine_corner_lab() from public;
revoke all on function public.mine_corner_lab() from anon;
revoke all on function public.mine_corner_lab() from authenticated;
revoke all on function public.mine_corner_lab_inner() from public;
revoke all on function public.mine_corner_lab_inner() from anon;
revoke all on function public.mine_corner_lab_inner() from authenticated;

-- nightly corner mine at 03:30 UTC (after rule-lab-nightly at 03:15), in-database via pg_cron
do $$
begin
  perform cron.unschedule('corner-lab-nightly');
exception when others then null;
end $$;
select cron.schedule('corner-lab-nightly', '30 3 * * *', $$set statement_timeout = '900000'; select public.mine_corner_lab();$$);

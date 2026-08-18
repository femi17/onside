-- 🔎 Insight miner (phase 1, corpus): weekly sweep of the fixtures history against a fixed
-- catalog of hypotheses EXPRESSIBLE IN THE RULE LANGUAGE, with a judgment gate against flukes:
-- min samples (train>=80, holdout>=30) + a time-split holdout (a pattern found on older games
-- must still hold on the newest 30%). Survivors land in `discoveries` as suggestions — the
-- system proposes, the owner applies (change-safety protocol). Surfaced on /performance as
-- "What the engine noticed this week" with a copy-able rule per card.
-- Deliveries-based mining (model-prob bands, e.g. the 84%-to-score signal) is phase 2.
create table if not exists public.discoveries (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  market_key text not null,
  side text,
  line numeric,
  period text not null default 'ft',
  field text not null,
  op text not null,
  value numeric not null,
  title text not null,
  detail text not null,
  rule_text text not null,
  rule_parsed jsonb not null,
  train_n int not null,
  train_hits int not null,
  holdout_n int not null,
  holdout_hits int not null,
  baseline numeric not null,
  score numeric not null,
  status text not null default 'new' check (status in ('new','dismissed','applied')),
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.discoveries enable row level security;
create policy discoveries_read on public.discoveries for select to authenticated using (true);
-- writes only via the definer miner below

create or replace function public.mine_discoveries(p_days int default 28, p_cap int default 3000)
returns int
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_cut timestamptz;
  v_found int := 0;
  c record;
  tn int; th int; hn int; hh int; bl numeric; tr numeric; hr numeric;
begin
  create temp table _s on commit drop as
  with sample as (
    select f.id, f.home_team_id hid, f.away_team_id aid, f.kickoff_utc ko,
           coalesce(f.ft_home, f.home_goals) hg, coalesce(f.ft_away, f.away_goals) ag
    from public.fixtures f
    where f.status in ('FT','AET','PEN') and coalesce(f.ft_home, f.home_goals) is not null
      and f.home_team_id is not null and f.away_team_id is not null
      and f.kickoff_utc > now() - make_interval(days => p_days)
    order by f.kickoff_utc desc limit p_cap
  ),
  apps as (
    select fx.kickoff_utc ako, fx.home_team_id tid,
           coalesce(fx.ft_home, fx.home_goals) gf, coalesce(fx.ft_away, fx.away_goals) ga
    from public.fixtures fx
    where fx.status in ('FT','AET','PEN') and coalesce(fx.ft_home, fx.home_goals) is not null
      and fx.home_team_id is not null and fx.kickoff_utc > now() - make_interval(days => p_days + 180)
    union all
    select fx.kickoff_utc, fx.away_team_id,
           coalesce(fx.ft_away, fx.away_goals), coalesce(fx.ft_home, fx.home_goals)
    from public.fixtures fx
    where fx.status in ('FT','AET','PEN') and coalesce(fx.ft_home, fx.home_goals) is not null
      and fx.away_team_id is not null and fx.kickoff_utc > now() - make_interval(days => p_days + 180)
  ),
  hform as (
    select id, count(*) n, sum(w) w, sum(d) d, sum(gf) gf, sum(ga) ga from (
      select s.id, a.gf, a.ga,
             case when a.gf > a.ga then 1 else 0 end w,
             case when a.gf = a.ga then 1 else 0 end d,
             row_number() over (partition by s.id order by a.ako desc) rn
      from sample s join apps a on a.tid = s.hid and a.ako < s.ko
    ) x where rn <= 5 group by id
  ),
  aform as (
    select id, count(*) n, sum(w) w, sum(d) d, sum(gf) gf, sum(ga) ga from (
      select s.id, a.gf, a.ga,
             case when a.gf > a.ga then 1 else 0 end w,
             case when a.gf = a.ga then 1 else 0 end d,
             row_number() over (partition by s.id order by a.ako desc) rn
      from sample s join apps a on a.tid = s.aid and a.ako < s.ko
    ) x where rn <= 5 group by id
  ),
  fin as (
    select home_team_id h_id, away_team_id a_id, kickoff_utc mko,
           coalesce(ft_home, home_goals) h, coalesce(ft_away, away_goals) a
    from public.fixtures
    where status in ('FT','AET','PEN') and coalesce(ft_home, home_goals) is not null
      and home_team_id is not null and away_team_id is not null
  ),
  met as (
    select s.id, (m.h > m.a) hw_home_side, (m.a > m.h) hw_away_side, m.h + m.a tot
    from sample s join fin m on m.h_id = s.hid and m.a_id = s.aid and m.mko < s.ko
    union all
    select s.id, (m.a > m.h), (m.h > m.a), m.h + m.a
    from sample s join fin m on m.h_id = s.aid and m.a_id = s.hid and m.mko < s.ko
  ),
  h2h as (
    select id, count(*) n,
           sum(case when hw_home_side then 1 else 0 end) hw,
           sum(case when hw_away_side then 1 else 0 end) aw,
           sum(case when tot >= 3 then 1 else 0 end) o25
    from met group by id
  )
  select s.id, s.ko, s.hg, s.ag,
         hf.n hn5, hf.w hw5, hf.d hd5, hf.gf hgf5, hf.ga hga5,
         af.n an5, af.w aw5, af.d ad5, af.gf agf5, af.ga aga5,
         h2.n h2n, h2.hw h2hw, h2.aw h2aw, h2.o25 h2o25,
         case when hf.n = 5 then (hf.gf + hf.ga) / 5.0 end hblend,
         case when af.n = 5 then (af.gf + af.ga) / 5.0 end ablend,
         case when hf.n = 5 then hf.gf / 5.0 end havg,
         case when af.n = 5 then af.gf / 5.0 end aavg,
         case when hf.n = 5 then (3 * hf.w + hf.d) / 5.0 end hppg,
         false hold
  from sample s
  left join hform hf on hf.id = s.id
  left join aform af on af.id = s.id
  left join h2h h2 on h2.id = s.id;

  -- time split: newest 30% is the holdout (percentile_cont can't order timestamps — use offset)
  select ko into v_cut from _s order by ko offset (select (count(*) * 7 / 10)::int from _s) limit 1;
  update _s set hold = (ko >= v_cut);

  -- previous run's still-"new" corpus suggestions are superseded by this run
  delete from public.discoveries where status = 'new' and key like 'corpus:%';

  for c in select * from (values
    ('corpus:1x_hw4',      'double_chance_1x', '1x',  null::numeric, 'home_wins_last5', 'gte', 4::numeric,
     'hn5 = 5 and hw5 >= 4', 'hg >= ag',
     'Homes on 4+ recent wins hold the 1X',
     'Home team has won at least 4 of their last 5 games'),
    ('corpus:1x_aw0',      'double_chance_1x', '1x',  null, 'away_wins_last5', 'lte', 0,
     'an5 = 5 and aw5 = 0', 'hg >= ag',
     'Winless-away opponents rarely beat the home side',
     'Away team has won none of their last 5 games'),
    ('corpus:hw_ppg24',    'home_win', 'home', null, 'home_form_ppg', 'gte', 2.4,
     'hn5 = 5 and hppg >= 2.4', 'hg > ag',
     'Homes at 2.4+ points a game keep winning',
     'Home team must be averaging at least 2.4 points per game over their last 5'),
    ('corpus:o25_blend34', 'over_2_5', 'over', 2.5, 'goals_blend', 'gte', 3.4,
     'hblend is not null and ablend is not null and (hblend + ablend) / 2 >= 3.4', 'hg + ag >= 3',
     'Goal-heavy pairings clear Over 2.5',
     'Both teams blended must average at least 3.4 goals per game'),
    ('corpus:o15_blend30', 'over_1_5', 'over', 1.5, 'goals_blend', 'gte', 3.0,
     'hblend is not null and ablend is not null and (hblend + ablend) / 2 >= 3.0', 'hg + ag >= 2',
     'Busy pairings clear Over 1.5',
     'Both teams blended must average at least 3.0 goals per game'),
    ('corpus:u25_blend20', 'under_2_5', 'under', 2.5, 'goals_blend', 'lte', 2.0,
     'hblend is not null and ablend is not null and (hblend + ablend) / 2 <= 2.0', 'hg + ag <= 2',
     'Quiet pairings stay Under 2.5',
     'Both teams blended must average at most 2.0 goals per game'),
    ('corpus:u35_blend24', 'under_3_5', 'under', 3.5, 'goals_blend', 'lte', 2.4,
     'hblend is not null and ablend is not null and (hblend + ablend) / 2 <= 2.4', 'hg + ag <= 3',
     'Quiet pairings stay Under 3.5',
     'Both teams blended must average at most 2.4 goals per game'),
    ('corpus:btts_min28',  'btts', 'yes', null, 'min_goals_blend', 'gte', 2.8,
     'hblend is not null and ablend is not null and least(hblend, ablend) >= 2.8', 'hg >= 1 and ag >= 1',
     'When even the quieter side runs hot, both score',
     'The lower of the two teams'' blends must be at least 2.8'),
    ('corpus:hts_avg20',   'home_to_score', 'home', null, 'home_goals_avg', 'gte', 2.0,
     'havg is not null and havg >= 2.0', 'hg >= 1',
     'Homes scoring 2 a game keep scoring',
     'Home team must be scoring at least 2.0 goals per game over their last 5'),
    ('corpus:h15_avg22',   'home_goals_ou', 'over', 1.5, 'home_goals_avg', 'gte', 2.2,
     'havg is not null and havg >= 2.2', 'hg >= 2',
     'Hot homes go over 1.5 team goals',
     'Home team must be scoring at least 2.2 goals per game over their last 5'),
    ('corpus:ats_avg18',   'away_to_score', 'away', null, 'away_goals_avg', 'gte', 1.8,
     'aavg is not null and aavg >= 1.8', 'ag >= 1',
     'Travelling sides on 1.8+ a game keep scoring',
     'Away team must be scoring at least 1.8 goals per game over their last 5'),
    ('corpus:1x_h2hw4',    'double_chance_1x', '1x', null, 'h2h_home_wins', 'gte', 4,
     'h2n >= 6 and h2hw >= 4', 'hg >= ag',
     'Head-to-head kings hold the 1X at home',
     'Home team must have won at least 4 of the head-to-head meetings'),
    ('corpus:o25_h2o5',    'over_2_5', 'over', 2.5, 'h2h_over25', 'gte', 5,
     'h2n >= 6 and h2o25 >= 5', 'hg + ag >= 3',
     'Fixtures with a goal history go over again',
     'At least 5 of the head-to-head meetings must have gone over 2.5 goals')
  ) as t(key, mk, side, line, field, op, val, pred, outc, title, rtext)
  loop
    execute format(
      'select count(*) filter (where not hold and (%1$s)),
              count(*) filter (where not hold and (%1$s) and (%2$s)),
              count(*) filter (where hold and (%1$s)),
              count(*) filter (where hold and (%1$s) and (%2$s)),
              avg(case when (%2$s) then 1.0 else 0 end)
         from _s', c.pred, c.outc)
      into tn, th, hn, hh, bl;
    if tn is null or tn < 80 or hn is null or hn < 30 or bl is null then continue; end if;
    tr := th::numeric / tn; hr := hh::numeric / hn;
    -- the gate: a real lift on the training window AND it survives the newest 30% unseen
    if tr - bl < 0.07 or hr - bl < 0.04 then continue; end if;
    insert into public.discoveries as d
      (key, market_key, side, line, period, field, op, value, title, rule_text, rule_parsed,
       train_n, train_hits, holdout_n, holdout_hits, baseline, score, detail)
    values
      (c.key, c.mk, c.side, c.line, 'ft', c.field, c.op, c.val, c.title, c.rtext,
       jsonb_build_object('filters', jsonb_build_array(jsonb_build_object('field', c.field, 'op', c.op, 'value', c.val, 'value2', 0)), 'select', jsonb_build_array()),
       tn, th, hn, hh, round(bl, 4), round(tr - bl, 4),
       format('Landed %s%% of %s qualifying games (baseline %s%%) — and held at %s%% across the newest %s games it had never seen.',
              round(tr * 100, 1), tn, round(bl * 100, 1), round(hr * 100, 1), hn))
    on conflict (key) do update
      set train_n = excluded.train_n, train_hits = excluded.train_hits,
          holdout_n = excluded.holdout_n, holdout_hits = excluded.holdout_hits,
          baseline = excluded.baseline, score = excluded.score,
          detail = excluded.detail, updated_at = now();
    v_found := v_found + 1;
  end loop;
  return v_found;
end $function$;

-- weekly, Monday 04:15 UTC — in-database via pg_cron, so no API timeout applies
select cron.schedule('onside-mine-insights', '15 4 * * 1', 'select public.mine_discoveries()');

-- Mirror of remotely applied migration model_signal_lab (2026-09-03).
-- Cross-market signal farming (owner-directed). Every delivered pick stores the model's FULL
-- probability vector (criteria.reasons.model: home/away/draw/btts/over25/home_score/away_score),
-- and we have every fixture's final score. So one pick is 12+ labelled training rows — one per
-- outcome market, scored from the TRUE result (wins AND losses, never assumed). This mines that:
-- for each model signal x threshold x outcome-market it computes hit + n + Wilson LB. REVIEW-ONLY —
-- nothing here auto-publishes to proven_rules; the daily review agent surfaces it and the owner
-- promotes by hand. Scans deliveries (small) with a PK join to fixtures — no fixtures full-scan.
create table if not exists public.model_signal_lab (
  signal_key text not null,
  threshold numeric not null,
  market_key text not null,
  market_label text not null,
  n integer not null,
  won integer not null,
  hit numeric not null,
  wilson_lb numeric not null,
  computed_at timestamptz not null default now(),
  primary key (signal_key, threshold, market_key)
);
alter table public.model_signal_lab enable row level security;
drop policy if exists model_signal_lab_read on public.model_signal_lab;
create policy model_signal_lab_read on public.model_signal_lab for select to authenticated using (true);
grant select on public.model_signal_lab to authenticated;

create or replace function public.mine_model_signals()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_n integer;
begin
  create temp table _d on commit drop as
  select dv.id,
    (dv.criteria->'reasons'->'model'->>'home')::numeric as p_home,
    (dv.criteria->'reasons'->'model'->>'away')::numeric as p_away,
    (dv.criteria->'reasons'->'model'->>'draw')::numeric as p_draw,
    (dv.criteria->'reasons'->'model'->>'btts')::numeric as p_btts,
    (dv.criteria->'reasons'->'model'->>'over25')::numeric as p_over25,
    (dv.criteria->'reasons'->'model'->>'home_score')::numeric as p_hs,
    (dv.criteria->'reasons'->'model'->>'away_score')::numeric as p_as,
    coalesce(f.ft_home, f.home_goals) as hg, coalesce(f.ft_away, f.away_goals) as ag
  from public.deliveries dv
  join public.fixtures f on f.id = dv.fixture_id and f.status in ('FT','AET','PEN')
  where dv.result in ('won','lost') and dv.criteria->'reasons' ? 'model'
    and coalesce(f.ft_home, f.home_goals) is not null
    and coalesce(f.ft_away, f.away_goals) is not null;

  delete from public.model_signal_lab;

  insert into public.model_signal_lab
    (signal_key, threshold, market_key, market_label, n, won, hit, wilson_lb, computed_at)
  select g.sig, g.thr, g.market_key, g.market_label, g.n, g.won,
         round(100.0 * g.won / g.n, 1),
         round(((w.p + 1.92 / g.n - 1.96 * sqrt((w.p * (1 - w.p) + 0.9604 / g.n) / g.n)) / (1 + 3.8416 / g.n)), 4),
         now()
  from (
    select s.sig, t.thr, o.market_key, o.market_label,
           count(*)::int as n, count(*) filter (where o.hit)::int as won
    from _d d
    cross join lateral (values
      ('home_win_prob', d.p_home),
      ('away_win_prob', d.p_away),
      ('draw_prob', d.p_draw),
      ('btts_prob', d.p_btts),
      ('over25_prob', d.p_over25),
      ('home_score_prob', d.p_hs),
      ('away_score_prob', d.p_as)
    ) s(sig, sval)
    cross join (values (0.55),(0.60),(0.65),(0.70),(0.75),(0.80),(0.85),(0.90)) t(thr)
    cross join lateral (values
      ('over_1_5','Over 1.5 goals', d.hg + d.ag >= 2),
      ('over_2_5','Over 2.5 goals', d.hg + d.ag >= 3),
      ('btts','Both teams to score', d.hg >= 1 and d.ag >= 1),
      ('home_to_score','Home team to score', d.hg >= 1),
      ('away_to_score','Away team to score', d.ag >= 1),
      ('home_over_1_5','Home over 1.5 goals', d.hg >= 2),
      ('away_over_1_5','Away over 1.5 goals', d.ag >= 2),
      ('home_win','Home win', d.hg > d.ag),
      ('away_win','Away win', d.ag > d.hg),
      ('double_chance_1x','Double chance (1X)', d.hg >= d.ag),
      ('double_chance_x2','Double chance (X2)', d.ag >= d.hg),
      ('double_chance_12','Double chance (12)', d.hg <> d.ag)
    ) o(market_key, market_label, hit)
    where s.sval is not null and s.sval >= t.thr
    group by s.sig, t.thr, o.market_key, o.market_label
    having count(*) >= 30
  ) g
  cross join lateral (select g.won::numeric / nullif(g.n, 0) as p) w;

  select count(*) into v_n from public.model_signal_lab;
  return v_n;
end $function$;

revoke all on function public.mine_model_signals() from public;
grant execute on function public.mine_model_signals() to service_role;

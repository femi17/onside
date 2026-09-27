-- Team attack/defence profiles (home/away split), recent 400-day window, rebuilt nightly, + a
-- transparent matchup projector. This is the interpretable input the agent ranks on to match each
-- game to the market its BOTH teams fit — NOT a second live model, and it does NOT touch
-- run-strategies. Foundation for the "reduce the cut" agent redesign (owner-directed 2026-09-27).
--
-- Design notes (from the long alignment): unit = team + matchup, never league average (La Liga is
-- 48% Over 2.5 but Barcelona 63%, Getafe 34%). Opponent is essential: Bayern's Over 2.5 is ~68% vs
-- Getafe but ~80% vs PSV. The engine's own model already combines both teams; this table is the
-- interpretable layer + the reason string + a team-grounded cross-check the owner trusts.

create table if not exists public.team_profile (
  team_id bigint primary key,
  team_name text,
  n_home int, gf_home numeric, ga_home numeric,   -- scored / conceded per HOME game
  n_away int, gf_away numeric, ga_away numeric,    -- scored / conceded per AWAY game
  computed_at timestamptz not null default now()
);
alter table public.team_profile enable row level security;
comment on table public.team_profile is
  'Per-team attack/defence (home/away split), last 400 days, rebuilt nightly. Feeds matchup_fit(). No public RLS: read via security-definer functions only.';

create or replace function public.rebuild_team_profile() returns void
  language plpgsql security definer set search_path to '' as $$
begin
  insert into public.team_profile (team_id, team_name, n_home, gf_home, ga_home, n_away, gf_away, ga_away, computed_at)
  select coalesce(h.tid, a.tid), coalesce(h.tn, a.tn),
    coalesce(h.n,0), round(coalesce(h.gf,0),3), round(coalesce(h.ga,0),3),
    coalesce(a.n,0), round(coalesce(a.gf,0),3), round(coalesce(a.ga,0),3), now()
  from
    (select f.home_team_id tid, max(f.home_team) tn, count(*) n,
       avg(coalesce(f.ft_home,f.home_goals)::numeric) gf, avg(coalesce(f.ft_away,f.away_goals)::numeric) ga
     from public.fixtures f
     where f.status in ('FT','AET','PEN') and f.kickoff_utc > now() - interval '400 days'
       and f.home_team_id is not null and (f.ft_home is not null or f.home_goals is not null)
     group by f.home_team_id) h
  full outer join
    (select f.away_team_id tid, max(f.away_team) tn, count(*) n,
       avg(coalesce(f.ft_away,f.away_goals)::numeric) gf, avg(coalesce(f.ft_home,f.home_goals)::numeric) ga
     from public.fixtures f
     where f.status in ('FT','AET','PEN') and f.kickoff_utc > now() - interval '400 days'
       and f.away_team_id is not null and (f.ft_home is not null or f.home_goals is not null)
     group by f.away_team_id) a
  on a.tid = h.tid
  on conflict (team_id) do update set
    team_name=excluded.team_name, n_home=excluded.n_home, gf_home=excluded.gf_home, ga_home=excluded.ga_home,
    n_away=excluded.n_away, gf_away=excluded.gf_away, ga_away=excluded.ga_away, computed_at=now();
end;
$$;

-- home attack MEETS away defence (and vice-versa) -> expected goals -> Poisson score grid (0..8 each
-- side) -> every core market probability. Combines BOTH teams. Returns null if either lacks data
-- (>=5 home/away games) so the caller can fall back to the model.
create or replace function public.matchup_fit(p_home bigint, p_away bigint) returns jsonb
  language plpgsql stable security definer set search_path to '' as $$
declare
  h public.team_profile; a public.team_profile;
  lh numeric; la numeric;
  ph numeric[] := array_fill(0::numeric, array[9]);
  pa numeric[] := array_fill(0::numeric, array[9]);
  i int; j int; hg int; ag int; tot int; joint numeric;
  o15 numeric := 0; o25 numeric := 0; o35 numeric := 0; btts numeric := 0;
  hw numeric := 0; dr numeric := 0; aw numeric := 0;
begin
  select * into h from public.team_profile where team_id = p_home;
  select * into a from public.team_profile where team_id = p_away;
  if h.team_id is null or a.team_id is null or coalesce(h.n_home,0) < 5 or coalesce(a.n_away,0) < 5 then
    return null;
  end if;
  lh := (h.gf_home + a.ga_away) / 2.0;
  la := (a.gf_away + h.ga_home) / 2.0;
  ph[1] := exp(-lh); pa[1] := exp(-la);
  for i in 1..8 loop
    ph[i+1] := ph[i] * lh / i;
    pa[i+1] := pa[i] * la / i;
  end loop;
  for i in 1..9 loop
    hg := i - 1;
    for j in 1..9 loop
      ag := j - 1; joint := ph[i] * pa[j]; tot := hg + ag;
      if tot >= 2 then o15 := o15 + joint; end if;
      if tot >= 3 then o25 := o25 + joint; end if;
      if tot >= 4 then o35 := o35 + joint; end if;
      if hg >= 1 and ag >= 1 then btts := btts + joint; end if;
      if hg > ag then hw := hw + joint; elsif hg = ag then dr := dr + joint; else aw := aw + joint; end if;
    end loop;
  end loop;
  return jsonb_build_object(
    'exp_home', round(lh,2), 'exp_away', round(la,2), 'exp_total', round(lh+la,2),
    'over_1_5', round(o15,3), 'over_2_5', round(o25,3), 'over_3_5', round(o35,3),
    'under_2_5', round(1-o25,3), 'under_3_5', round(1-o35,3), 'btts', round(btts,3),
    'home_win', round(hw,3), 'draw', round(dr,3), 'away_win', round(aw,3),
    'dc_1x', round(hw+dr,3), 'dc_x2', round(dr+aw,3), 'dc_12', round(hw+aw,3));
end;
$$;

select cron.schedule('rebuild-team-profile', '20 4 * * *', $$ select public.rebuild_team_profile(); $$);

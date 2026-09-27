-- Batch helper for run-strategies' reduce-the-cut re-rank: one round-trip returns matchup_fit() for a
-- list of fixtures, so the engine can order gated candidates by how well BOTH teams fit the agent's
-- market. Additive, read-only; pairs with the run-strategies matchupFitFor() helper. NOT YET APPLIED
-- — deploy alongside the run-strategies edit after review + regression replay. (Owner-directed 2026-09-27.)
create or replace function public.matchup_fit_batch(p_fixtures bigint[])
returns table(fixture_id bigint, fit jsonb)
language sql stable security definer set search_path to '' as $$
  select f.id, public.matchup_fit(f.home_team_id, f.away_team_id)
  from public.fixtures f
  where f.id = any(p_fixtures) and f.home_team_id is not null and f.away_team_id is not null;
$$;

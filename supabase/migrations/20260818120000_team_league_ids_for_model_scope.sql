-- Every league a set of teams played in since a date - lets run-strategies widen its model
-- scope so cup/U23 fixtures are rated from their teams' DOMESTIC history (which lives in
-- other leagues). Friendlies excluded: B-team noise at huge volume would crowd the model's
-- recent-results window.
create or replace function public.team_league_ids(p_team_ids bigint[], p_since timestamptz)
returns bigint[]
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(array_agg(distinct f.league_id), '{}')
  from public.fixtures f
  where f.league_id is not null
    and f.kickoff_utc >= p_since
    and (f.home_team_id = any(p_team_ids) or f.away_team_id = any(p_team_ids))
    and not exists (select 1 from public.leagues l where l.id = f.league_id and l.name ilike '%friendl%')
$function$;

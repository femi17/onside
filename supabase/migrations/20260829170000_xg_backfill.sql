-- xG backfill (owner-approved 2026-08-29): API-Football serves statistics for PAST fixtures, so
-- instead of waiting months for xG history to accrue via the nightly collector, we probe the
-- ~17k finished fixtures (last 120 days) in leagues agents actually deliver picks in (~853
-- batched calls). Two pieces:
--
-- xg_backfill_candidates: like stats_backfill_candidates but targets MISSING xG (row absent OR
-- stats lacks expected_goals), skips fixtures already probed-and-barren (no_xg marker), and
-- orders by learned per-league xG yield (unexplored 0.5 prior) then delivery volume — the model
-- gets xG first where picks actually happen.
--
-- merge_fixture_stats: the collector's normal upsert NEVER touches existing rows (live-poll
-- snapshots must survive). Backfill needs the opposite for FINISHED games: merge new stat keys
-- into existing rows (stats || new — corners/cards keys keep their values unless re-sent final),
-- fill corners columns only when null, insert when the row doesn't exist.
create or replace function public.xg_backfill_candidates(p_since timestamptz, p_limit integer)
returns table(id bigint)
language sql
security definer
set search_path to ''
as $function$
  with probed as (
    select f.league_id,
           (count(*) filter (where fs.stats ? 'expected_goals'))::numeric / count(*) as hit
    from public.fixture_stats fs
    join public.fixtures f on f.id = fs.fixture_id
    where fs.stats ? 'expected_goals' or fs.stats ? 'no_xg'
    group by f.league_id
    having count(*) >= 3
  ),
  pick_leagues as (
    select f.league_id, count(*) as picks
    from public.deliveries d
    join public.fixtures f on f.id = d.fixture_id
    group by 1
  )
  select f.id
  from public.fixtures f
  join pick_leagues pl on pl.league_id = f.league_id
  left join public.fixture_stats fs on fs.fixture_id = f.id
  left join probed y on y.league_id = f.league_id
  where f.status in ('FT','AET','PEN')
    and f.kickoff_utc >= p_since
    and (fs.fixture_id is null
         or not (fs.stats ? 'expected_goals' or fs.stats ? 'no_xg'))
  order by coalesce(y.hit, 0.5) desc, pl.picks desc, f.kickoff_utc desc
  limit p_limit;
$function$;

create or replace function public.merge_fixture_stats(p_rows jsonb)
returns integer
language sql
security definer
set search_path to ''
as $function$
  with ins as (
    insert into public.fixture_stats as fs (fixture_id, corners_home, corners_away, stats, updated_at)
    select (r->>'fixture_id')::bigint,
           nullif(r->>'corners_home', '')::int,
           nullif(r->>'corners_away', '')::int,
           coalesce(r->'stats', '{}'::jsonb),
           now()
    from jsonb_array_elements(p_rows) r
    on conflict (fixture_id) do update
      set stats = coalesce(fs.stats, '{}'::jsonb) || excluded.stats,
          corners_home = coalesce(fs.corners_home, excluded.corners_home),
          corners_away = coalesce(fs.corners_away, excluded.corners_away),
          updated_at = now()
    returning 1
  )
  select count(*)::int from ins;
$function$;

-- service-role only (called from the collect-stats edge fn) — same posture as settle_delivery
revoke all on function public.xg_backfill_candidates(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.merge_fixture_stats(jsonb) from public, anon, authenticated;

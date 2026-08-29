-- xg_backfill_candidates v2: the probed-yield CTE was hash-joining fixture_stats->fixtures by
-- SEQ-SCANNING all ~850K fixture rows (6-11s → intermittent statement timeouts that kept killing
-- the drain). Resolve each probed row's league via an indexed PK lookup instead (~24K lookups,
-- sub-second). Same results, same ordering, same signature.
create or replace function public.xg_backfill_candidates(p_since timestamptz, p_limit integer)
returns table(id bigint)
language sql
security definer
set search_path to ''
as $function$
  with probed as (
    select league_id,
           (count(*) filter (where has_xg))::numeric / count(*) as hit
    from (
      select (select f.league_id from public.fixtures f where f.id = fs.fixture_id) as league_id,
             fs.stats ? 'expected_goals' as has_xg
      from public.fixture_stats fs
      where fs.stats ? 'expected_goals' or fs.stats ? 'no_xg'
    ) p
    where league_id is not null
    group by league_id
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

revoke all on function public.xg_backfill_candidates(timestamptz, integer) from public, anon, authenticated;

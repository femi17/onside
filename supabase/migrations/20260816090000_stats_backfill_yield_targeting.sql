-- Corner-stat backfill was walking fixtures in blind recency order — a 1000-fixture run yielded
-- just 48 games with corners because most candidates sit in leagues the provider records no
-- corner stats for. Target instead by LEAGUE YIELD learned from our own collection history:
-- leagues whose collected games usually carry corners first, unexplored leagues next (0.5 prior),
-- proven-barren leagues last. Same signature — collect-stats needs no change.
-- Measured: yield went 48/1000 → 993/1000 on the first targeted run.
create or replace function public.stats_backfill_candidates(p_since timestamp with time zone, p_limit integer)
 returns table(id bigint)
 language sql
 security definer
 set search_path to ''
as $function$
  with yield as (
    select f.league_id,
           count(*) filter (where fs.corners_home is not null)::numeric / count(*) as hit
    from public.fixture_stats fs
    join public.fixtures f on f.id = fs.fixture_id
    group by f.league_id
    having count(*) >= 3
  )
  select f.id
  from public.fixtures f
  left join public.fixture_stats fs on fs.fixture_id = f.id
  left join yield y on y.league_id = f.league_id
  where fs.fixture_id is null
    and f.status in ('FT','AET','PEN')
    and f.kickoff_utc >= p_since
  order by coalesce(y.hit, 0.5) desc, f.kickoff_utc desc
  limit p_limit;
$function$;

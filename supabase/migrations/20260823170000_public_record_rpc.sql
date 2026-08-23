-- /record — the public transparency page ("every pick graded, even the misses").
-- Platform-wide AGGREGATES ONLY: no user, agent, or pick identities ever leave this RPC,
-- which is what makes it safe to grant to anon (same reasoning as public_acca/public_agent,
-- but with zero per-row data). Days are Lagos-local like the agent feed. Voids are excluded
-- from grading everywhere else, so they are excluded here too.
create or replace function public.public_record()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'all_time', (
      select jsonb_build_object(
        'graded', count(*),
        'won',    count(*) filter (where result = 'won'),
        'since',  min(delivered_at)
      )
      from public.deliveries
      where result in ('won', 'lost')
    ),
    'today_delivered', (
      select count(*)
      from public.deliveries
      where delivered_at >= date_trunc('day', now() at time zone 'Africa/Lagos')
                            at time zone 'Africa/Lagos'
    ),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'graded', graded, 'won', won)
                       order by day desc)
      from (
        select (d.delivered_at at time zone 'Africa/Lagos')::date as day,
               count(*) filter (where d.result in ('won', 'lost')) as graded,
               count(*) filter (where d.result = 'won') as won
        from public.deliveries d
        where d.delivered_at >= now() - interval '35 days'
        group by 1
        having count(*) filter (where d.result in ('won', 'lost')) > 0
        order by 1 desc
        limit 30
      ) t
    ), '[]'::jsonb),
    -- confidence honesty: what the agents CLAIMED (model %) vs what actually landed,
    -- in 10-point bands. The engine's own veto works on exact-% cells (owner ruling);
    -- bands here are the grouped PUBLIC overview, same as the /performance card.
    'bands', coalesce((
      select jsonb_agg(jsonb_build_object('band', band, 'n', n, 'won', won, 'claimed', claimed)
                       order by band)
      from (
        select least(floor(d.model_prob * 10) * 10, 90)::int as band,
               count(*) as n,
               count(*) filter (where d.result = 'won') as won,
               round(avg(d.model_prob) * 100)::int as claimed
        from public.deliveries d
        where d.model_prob is not null and d.result in ('won', 'lost')
        group by 1
        having count(*) >= 25
      ) b
    ), '[]'::jsonb)
  )
$function$;
revoke all on function public.public_record() from public;
grant execute on function public.public_record() to anon, authenticated;

-- /record v2: each day now also reports how many INDIVIDUAL agents went perfect that day
-- (3+ delivered picks, every one won — same bar as the perfect-day congratulation) and the
-- biggest such sweep (perfect_n), so a 4/4 like Weekend Overs' isn't lost inside the pooled
-- day total. Still aggregates only — no user/agent identities leave the RPC (anon-safe).
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
      select jsonb_agg(jsonb_build_object(
               'day', day, 'graded', graded, 'won', won,
               'perfect', perfect, 'perfect_n', perfect_n)
             order by day desc)
      from (
        with per_agent as (
          select (d.delivered_at at time zone 'Africa/Lagos')::date as day,
                 d.strategy_id,
                 count(*) as delivered,
                 count(*) filter (where d.result in ('won', 'lost')) as g,
                 count(*) filter (where d.result = 'won') as w
          from public.deliveries d
          where d.delivered_at >= now() - interval '35 days'
          group by 1, 2
        )
        select day,
               sum(g) as graded,
               sum(w) as won,
               count(*) filter (where delivered >= 3 and w = delivered) as perfect,
               max(delivered) filter (where delivered >= 3 and w = delivered) as perfect_n
        from per_agent
        group by day
        having sum(g) > 0
        order by day desc
        limit 30
      ) t
    ), '[]'::jsonb),
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

-- /record v3: the perfect-day spotlight opens into the actual games. perfect_details
-- returns, for the 3 most recent days with a perfect sweep, every sweeping agent's legs
-- (fixture names, market label, settled score). Fixtures and markets are public facts;
-- user/agent identities still never leave the RPC (anon-safe, same rule as ever).
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
    'perfect_details', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'sweeps', sweeps) order by day desc)
      from (
        with pa as (
          select (d.delivered_at at time zone 'Africa/Lagos')::date as day, d.strategy_id,
                 count(*) as delivered
          from public.deliveries d
          where d.delivered_at >= now() - interval '14 days'
          group by 1, 2
          having count(*) >= 3
             and count(*) filter (where d.result = 'won') = count(*)
        ),
        picks as (
          select pa.day, pa.strategy_id, pa.delivered,
                 jsonb_agg(jsonb_build_object(
                   'home', f.home_team, 'away', f.away_team,
                   'market', coalesce(nullif(d.market_label, ''), d.market_key),
                   'score', coalesce(d.settle_score, f.ft_home::text || '-' || f.ft_away::text)
                 ) order by d.delivered_at) as legs
          from pa
          join public.deliveries d on d.strategy_id = pa.strategy_id
            and (d.delivered_at at time zone 'Africa/Lagos')::date = pa.day
          join public.fixtures f on f.id = d.fixture_id
          group by 1, 2, 3
        )
        select day,
               jsonb_agg(jsonb_build_object('n', delivered, 'legs', legs) order by delivered desc) as sweeps
        from picks
        group by day
        order by day desc
        limit 3
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

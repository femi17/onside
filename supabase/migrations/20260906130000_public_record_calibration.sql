-- #4 headline hit-rate fix (2026-09-06): a bare pooled won/graded rate is dominated by market mix
-- (easy Over-1.5 volume inflates it; a harder mix "declines" it) and weights a 92%-claim and a
-- 55%-claim pick equally — so as a quality signal it mostly reports WHICH markets agents picked.
-- The honest headline for a confidence-default product is CALIBRATION: when we claim X%, does X%
-- land? This adds a `calibration` object (pooled claimed vs actual over every model_prob-bearing
-- settled non-draft pick) so /record can lead with "claimed X% · landed Y% — delivers on its word".
-- Purely ADDITIVE: every existing key of public_record() is reproduced unchanged.
CREATE OR REPLACE FUNCTION public.public_record()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'all_time', (
      select jsonb_build_object(
        'graded', count(*),
        'won',    count(*) filter (where result = 'won'),
        'since',  min(delivered_at)
      )
      from public.deliveries d
      where result in ('won', 'lost')
        and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
    ),
    'today_delivered', (
      select count(*)
      from public.deliveries d
      where delivered_at >= date_trunc('day', now() at time zone 'Africa/Lagos')
                            at time zone 'Africa/Lagos'
        and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
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
            and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
          group by 1, 2
        )
        select day,
               sum(g) as graded,
               sum(w) as won,
               count(*) filter (where strategy_id is not null and delivered >= 3 and w = delivered) as perfect,
               max(delivered) filter (where strategy_id is not null and delivered >= 3 and w = delivered) as perfect_n
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
            and d.strategy_id is not null
            and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
          group by 1, 2
          having count(*) >= 3
             and count(*) filter (where d.result = 'won') = count(*)
        ),
        picks as (
          select pa.day, pa.strategy_id, pa.delivered,
                 jsonb_agg(jsonb_build_object(
                   'home', f.home_team, 'away', f.away_team,
                   'market', coalesce(nullif(d.market_label, ''), d.market_key),
                   'score', coalesce(d.settle_score,
                            coalesce(f.ft_home, f.home_goals)::text || '-' || coalesce(f.ft_away, f.away_goals)::text)
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
          and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
        group by 1
        having count(*) >= 25
      ) b
    ), '[]'::jsonb),
    'calibration', (
      -- pooled claim-vs-delivered over every graded pick that carries a shown %: the honest
      -- headline. n≈all_time.graded (model_prob present on ~all settled picks).
      select jsonb_build_object(
        'n',       count(*),
        'won',     count(*) filter (where result = 'won'),
        'claimed', round(avg(model_prob) * 100)::int
      )
      from public.deliveries d
      where d.model_prob is not null and d.result in ('won', 'lost')
        and not exists (select 1 from public.strategies sd where sd.id = d.strategy_id and sd.status = 'draft')
    )
  )
$function$

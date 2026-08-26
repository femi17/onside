-- Follow-up to immutable_record: anonymous ledger rows (null strategy_id/user_id after a
-- deletion) must keep COUNTING in the totals but never impersonate an agent. public_record
-- v4: per-agent grouping (perfect days + sweeps) excludes null strategy_id — otherwise
-- unrelated anonymous rows sharing a day could merge into one fake "perfect agent".
-- admin_recent_picks: deleted users label as Anonymous instead of a null name.
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

create or replace function public.admin_recent_picks()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_admin boolean;
  v_excl uuid[];
begin
  select is_admin into v_admin from public.profiles where id = auth.uid();
  if not coalesce(v_admin, false) then raise exception 'not authorized'; end if;

  select coalesce(array_agg(p.id), '{}') into v_excl
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.is_admin = true
     or u.email in ('tyewoduola@gmail.com', 'demo@onside.com.ng', 'oduolafemi17@gmail.com');

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'at', t.delivered_at,
      'who', t.who,
      'agent', t.agent,
      'home', t.home_team,
      'away', t.away_team,
      'league', t.league,
      'kickoff', t.kickoff_utc,
      'market', t.market,
      'prob', t.model_prob,
      'result', t.result,
      'score', t.score
    ) order by t.delivered_at desc), '[]'::jsonb)
    from (
      select d.delivered_at, d.model_prob,
        coalesce(nullif(p.display_name, ''), nullif(p.handle, ''), left(u.email, 3) || '***', 'Anonymous') as who,
        coalesce(s.name, 'Deleted agent') as agent,
        f.home_team, f.away_team, f.kickoff_utc,
        coalesce(l.name, '#' || f.league_id::text) as league,
        coalesce(nullif(d.market_label, ''), d.market_key) as market,
        coalesce(d.result, 'pending') as result,
        coalesce(d.settle_score,
          case when f.status in ('FT', 'AET', 'PEN') then f.ft_home::text || '-' || f.ft_away::text end) as score
      from public.deliveries d
      join public.fixtures f on f.id = d.fixture_id
      left join public.leagues l on l.id = f.league_id
      left join public.strategies s on s.id = d.strategy_id
      left join public.profiles p on p.id = d.user_id
      left join auth.users u on u.id = d.user_id
      where d.user_id is null or d.user_id <> all(v_excl)
      order by d.delivered_at desc
      limit 60
    ) t
  );
end;
$function$;

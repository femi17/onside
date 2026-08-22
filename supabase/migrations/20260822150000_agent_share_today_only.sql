-- Owner ruling: a shared agent page is about THE DAY, not the whole past feed — the picks
-- list shows only deliveries from the current day in the agent's own timezone. The all-time
-- landed/cut record stays as the credibility line; everything else as 20260822130000.
create or replace function public.public_agent(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'name', s.name,
    'market', s.market_label,
    'created_at', s.created_at,
    'record', (
      select jsonb_build_object(
        'won',  count(*) filter (where d.result = 'won'),
        'lost', count(*) filter (where d.result = 'lost')
      )
      from public.deliveries d where d.strategy_id = s.id
    ),
    'picks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'game', coalesce(p.home_team || ' v ' || p.away_team, 'Match'),
        'league', p.league_name,
        'market', coalesce(p.market_label, 'Bet'),
        'prob', p.model_prob,
        'result', p.result,
        'value', p.current_value,
        'kickoff', p.kickoff_utc,
        'fx_status', p.status,
        'elapsed', p.elapsed,
        'hg', p.home_goals,
        'ag', p.away_goals
      ) order by p.delivered_at desc)
      from (
        select d.delivered_at, d.market_label, d.model_prob, d.result, d.current_value,
               f.home_team, f.away_team, f.kickoff_utc, f.status, f.elapsed,
               f.home_goals, f.away_goals, l.name as league_name
        from public.deliveries d
        left join public.fixtures f on f.id = d.fixture_id
        left join public.leagues l on l.id = f.league_id
        where d.strategy_id = s.id
          -- today only, in the agent's timezone: start of the local day, expressed in UTC
          and d.delivered_at >= date_trunc('day', now() at time zone coalesce(s.timezone, 'Africa/Lagos'))
                                at time zone coalesce(s.timezone, 'Africa/Lagos')
        order by d.delivered_at desc
        limit 25
      ) p
    ), '[]'::jsonb)
  )
  from public.strategies s
  where s.share_token = p_token
$function$;

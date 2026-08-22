-- Owner ruling, completing 20260822150000: the shared agent page is ONLY the day's own —
-- the all-time landed/cut record leaked the whole past through the header, so it leaves
-- the public payload entirely. The page tallies today's results from the picks themselves.
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

-- Public agent share links — the promotional loop for agents, mirroring the acca share
-- (20260818140000). The owner mints an unguessable token for one of their agents; anyone
-- with the link sees an ANONYMISED read-only feed: the agent's name, its record, and its
-- recent picks with live game state. No user identity, ever. Sharing is explicit (token
-- null until the owner taps Share); deleting the agent deletes the row, so links go dark.
alter table public.strategies add column if not exists share_token uuid;
create unique index if not exists strategies_share_token_key on public.strategies (share_token) where share_token is not null;

-- owner-only: mint (or return) the agent's share token
create or replace function public.share_strategy(p_strategy_id uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare v_token uuid;
begin
  update public.strategies
     set share_token = coalesce(share_token, gen_random_uuid())
   where id = p_strategy_id and user_id = auth.uid()
   returning share_token into v_token;
  if v_token is null then raise exception 'not your agent'; end if;
  return v_token;
end $function$;

-- public: the shared agent feed, anonymised — callable signed-out (marketing page + OG image).
-- Record counts settled deliveries all-time; picks are the 25 most recent with enough fixture
-- state to render live scores. current_value is the poll's live bet reading (single writer).
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
        order by d.delivered_at desc
        limit 25
      ) p
    ), '[]'::jsonb)
  )
  from public.strategies s
  where s.share_token = p_token
$function$;
grant execute on function public.public_agent(uuid) to anon;
grant execute on function public.share_strategy(uuid) to authenticated;

-- Onside Best, rebuilt as a deterministic statistical quality gate (no LLM / no API credit).
-- It is the "defect check on the line": every agent pick is scored on three signals the data
-- proved matter, and only the ones that clear the bar reach the user. Improves over time because
-- agent_quality recomputes from settled results — the more games settle, the sharper the gate.
--
-- The three defect signals (from the pick-outcome analysis, 2026-08-09):
--   1. agent track record — chronically losing agents (Double Chance 44%, Weekend Overs 34%) drag
--      results down; drop picks from agents proven below coin-flip.
--   2. edge sanity — the model runs ~10-15pts hot; result/DC picks above +12% edge are overconfidence
--      that hit ~13-36%, not value. Drop them.
--   3. odds realism — a pick's real hit rate tracks the book price, so drop longshots the model overrates.
-- Filtering these lifted the day's hit rate 65% -> 74% while keeping ~60% of picks.

-- the improving statistical core: each agent's record, win rate shrunk toward 50% so a thin sample
-- isn't over-trusted. Own-rows only for clients (deliveries/strategies RLS); the gate reads it as definer.
create or replace view public.agent_quality as
select st.id as strategy_id, st.user_id, st.name,
  count(*) filter (where d.result in ('won','lost')) as settled,
  count(*) filter (where d.result = 'won') as won,
  case when count(*) filter (where d.result in ('won','lost')) = 0 then null
       else (count(*) filter (where d.result = 'won'))::numeric
            / count(*) filter (where d.result in ('won','lost')) end as win_rate,
  (count(*) filter (where d.result = 'won') + 7.5)
    / (count(*) filter (where d.result in ('won','lost')) + 15) as shrunk_rate
from public.strategies st
left join public.deliveries d on d.strategy_id = st.id
group by st.id, st.user_id, st.name;

create unique index if not exists onside_best_user_date_uq on public.onside_best(user_id, set_date);

create or replace function public.build_onside_best()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_secret text;
  v_created int := 0;
  u record;
  v_pool int; v_kept int; v_picks jsonb; v_summary text; v_existing boolean;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;

  -- eligible: pro / pro_max with 2+ running agents (Onside Best curates ACROSS agents)
  for u in
    select p.id as user_id
    from public.profiles p
    where p.plan in ('pro','pro_max')
      and (select count(*) from public.strategies s where s.user_id = p.id and s.status = 'running') >= 2
  loop
    with pool as (   -- today's not-yet-started, still-pending picks from this user's agents
      select d.id, d.fixture_id, d.edge, d.model_prob, d.market_prob,
        (d.market_key in ('home_win','away_win','draw','double_chance_1x','double_chance_x2','double_chance_12')) as is_result,
        coalesce(d.market_prob, d.model_prob) as hit_like,
        aq.shrunk_rate, aq.settled, aq.win_rate, st.name as agent
      from public.deliveries d
      join public.fixtures f on f.id = d.fixture_id
      join public.strategies st on st.id = d.strategy_id
      join public.agent_quality aq on aq.strategy_id = d.strategy_id
      where d.user_id = u.user_id and d.result = 'pending'
        and f.kickoff_utc > now() and f.status = 'NS'
        and (d.delivered_at at time zone 'Africa/Lagos')::date = v_today
    ),
    kept as (   -- the three defect gates
      select *, (coalesce(shrunk_rate, 0.5) * coalesce(hit_like, 0)) as score
      from pool
      where (settled < 20 or coalesce(win_rate, 1) >= 0.50)                         -- agent not a proven loser
        and not (is_result and coalesce(edge, 0) > 0.12)                            -- not an overconfident result bet
        and (coalesce(market_prob, 0) >= 0.40                                       -- not a longshot the model overrates
             or (market_prob is null and coalesce(model_prob, 0) >= 0.55))
    ),
    per_fixture as (   -- best surviving pick per game
      select distinct on (fixture_id) id, fixture_id, score, agent, win_rate
      from kept order by fixture_id, score desc
    ),
    ranked as (
      select id, agent, win_rate, row_number() over (order by score desc) as rnk
      from per_fixture order by score desc limit 15
    )
    select
      (select count(*) from pool),
      (select count(*) from ranked),
      coalesce((select jsonb_agg(jsonb_build_object(
        'delivery_id', id::text, 'rank', rnk,
        'reason', 'Kept — ' || coalesce(agent,'agent') || ' running '
                  || round(coalesce(win_rate,0.5)*100)::int || '%, and it is not an overpriced pick'
      ) order by rnk) from ranked), '[]'::jsonb)
    into v_pool, v_kept, v_picks;

    if v_kept >= 3 then
      v_summary := 'Onside screened ' || v_pool || ' picks from your agents and kept the ' || v_kept
        || ' that clear its quality bar — picks from cold agents and overpriced results are filtered out.';
      select exists(select 1 from public.onside_best where user_id = u.user_id and set_date = v_today) into v_existing;
      insert into public.onside_best (user_id, set_date, picks, summary)
      values (u.user_id, v_today, v_picks, v_summary)
      on conflict (user_id, set_date) do update set picks = excluded.picks, summary = excluded.summary;
      -- push only when the set is first created today, not on every refresh
      if not v_existing and v_secret is not null then
        perform net.http_post(
          url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
          headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
          body := jsonb_build_object('user_id', u.user_id, 'category', 'agent_picks',
            'title', '⭐ Onside Best', 'body', v_summary, 'url', '/agent',
            'tag', 'onside-best-' || v_today::text),
          timeout_milliseconds := 8000);
        v_created := v_created + 1;
      end if;
    end if;
  end loop;
  return v_created;
end;
$function$;

-- keep the set fresh through the day as agents deliver; creating the row early also means the old
-- LLM path in run-strategies finds a row already present and never spends a Sonnet call
select cron.schedule('onside-best-gate', '*/15 * * * *', 'select public.build_onside_best();');

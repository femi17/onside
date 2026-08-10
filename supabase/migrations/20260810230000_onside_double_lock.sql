-- Lock the daily Onside Double. It built once all agents were in, but the */15 cron kept
-- re-selecting the top 2 from still-UPCOMING pending legs — so when a leg's game finished it dropped
-- out and got replaced (the set "re-rolled"). A banker double must be committed: pick the best 2
-- once, then freeze for the day. Skip any user who already has today's double, and never overwrite it.
create or replace function public.build_onside_double()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_secret text; v_created int := 0; u record;
  v_legs jsonb; v_summary text; v_existing boolean; v_n int;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;

  for u in
    select distinct d.user_id
    from public.deliveries d
    join public.strategies st on st.id = d.strategy_id and st.status = 'running'
    where d.result = 'pending' and (d.delivered_at at time zone 'Africa/Lagos')::date = v_today
  loop
    -- wait for the whole slate: every running agent scheduled today must have delivered
    if exists (
      select 1 from public.strategies st
      where st.user_id = u.user_id and st.status = 'running'
        and (
          coalesce(st.target_day, 'same_day') not in ('saturday', 'sunday')
          or (st.target_day = 'saturday' and extract(dow from (now() at time zone coalesce(st.timezone, 'Africa/Lagos'))) = 6)
          or (st.target_day = 'sunday'  and extract(dow from (now() at time zone coalesce(st.timezone, 'Africa/Lagos'))) = 0)
        )
        and (
          st.last_run_at is null
          or (st.last_run_at at time zone coalesce(st.timezone, 'Africa/Lagos'))::date
             < (now() at time zone coalesce(st.timezone, 'Africa/Lagos'))::date
        )
    ) then
      continue;
    end if;

    -- LOCK: once today's double is set, keep the SAME two picks all day — never re-roll a landed leg
    if exists (select 1 from public.onside_double where user_id = u.user_id and set_date = v_today) then
      continue;
    end if;

    with pool as (
      select d.id, d.fixture_id, d.market_prob, d.side, d.market_label,
        (d.market_key in ('home_win','away_win','draw','double_chance_1x','double_chance_x2','double_chance_12')) as is_result,
        aq.shrunk_rate, st.name as agent, f.home_team || ' v ' || f.away_team as game
      from public.deliveries d
      join public.fixtures f on f.id = d.fixture_id
      join public.strategies st on st.id = d.strategy_id
      join public.agent_quality aq on aq.strategy_id = d.strategy_id
      where d.user_id = u.user_id and d.result = 'pending'
        and f.kickoff_utc > now() and f.status = 'NS'
        and (d.delivered_at at time zone 'Africa/Lagos')::date = v_today
        and coalesce(d.market_prob, 0) >= 0.68
        and (aq.settled < 20 or coalesce(aq.win_rate, 1) >= 0.55)
    ),
    per_fix as (
      select distinct on (fixture_id) id, fixture_id, market_prob, market_label, agent, game,
        (market_prob + case when is_result then -0.05 else 0.02 end + (coalesce(shrunk_rate,0.5)-0.5)*0.2) as score
      from pool
      order by fixture_id, (market_prob + case when is_result then -0.05 else 0.02 end) desc
    ),
    top2 as (
      select id, fixture_id, market_prob, market_label, agent, game,
        row_number() over (order by score desc) as rnk
      from per_fix order by score desc limit 2
    )
    select count(*),
      coalesce(jsonb_agg(jsonb_build_object(
        'delivery_id', id::text, 'rank', rnk, 'game', game, 'market', market_label,
        'agent', agent, 'prob', round(market_prob*100)::int, 'fixture_id', fixture_id
      ) order by rnk), '[]'::jsonb)
    into v_n, v_legs from top2;

    if v_n = 2 then
      v_summary := 'Today''s banker double — your two safest picks from your strongest agents.';
      select exists(select 1 from public.onside_double where user_id = u.user_id and set_date = v_today) into v_existing;
      insert into public.onside_double (user_id, set_date, legs, summary)
      values (u.user_id, v_today, v_legs, v_summary)
      on conflict (user_id, set_date) do nothing;
      if not v_existing and v_secret is not null then
        perform net.http_post(
          url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
          headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
          body := jsonb_build_object('user_id', u.user_id, 'category', 'agent_picks',
            'title', '🎯 Onside Double', 'body', 'Today''s banker double is ready — your two safest picks.',
            'url', '/agent', 'tag', 'onside-double-' || v_today::text),
          timeout_milliseconds := 8000);
        v_created := v_created + 1;
      end if;
    end if;
  end loop;
  return v_created;
end;
$function$;

revoke execute on function public.build_onside_double() from anon, authenticated;

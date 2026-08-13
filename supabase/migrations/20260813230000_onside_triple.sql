-- Onside Triple — the bolder sibling of the Onside Double. Same pool and scoring, but takes the TOP 3
-- (the double's two safest + the next-best). Backtest: the 3rd leg is only marginally weaker
-- (~77% implied / ~83% hit), so it's a gentle step down, framed as a bolder/bigger-return banker.
-- The Double's logic is untouched; this is a fully separate table + builder + cron.

create table if not exists public.onside_triple (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  set_date date not null default (now() at time zone 'Africa/Lagos')::date,
  legs jsonb not null default '[]'::jsonb,
  summary text,
  created_at timestamptz not null default now(),
  unique (user_id, set_date)
);
alter table public.onside_triple enable row level security;
drop policy if exists "read own triple" on public.onside_triple;
create policy "read own triple" on public.onside_triple for select using (auth.uid() = user_id);

create or replace function public.build_onside_triple()
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
    -- wait until every one of the user's due agents has run today (same guard as the double)
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

    if exists (select 1 from public.onside_triple where user_id = u.user_id and set_date = v_today) then
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
    top3 as (
      select id, fixture_id, market_prob, market_label, agent, game,
        row_number() over (order by score desc) as rnk
      from per_fix order by score desc limit 3
    )
    select count(*),
      coalesce(jsonb_agg(jsonb_build_object(
        'delivery_id', id::text, 'rank', rnk, 'game', game, 'market', market_label,
        'agent', agent, 'prob', round(market_prob*100)::int, 'fixture_id', fixture_id
      ) order by rnk), '[]'::jsonb)
    into v_n, v_legs from top3;

    -- only a genuine 3-legger; a thin day (fewer than 3 eligible) leaves the double to stand alone
    if v_n = 3 then
      v_summary := 'Today''s banker triple — your three safest picks from your strongest agents. Bolder than the double, bigger return.';
      select exists(select 1 from public.onside_triple where user_id = u.user_id and set_date = v_today) into v_existing;
      insert into public.onside_triple (user_id, set_date, legs, summary)
      values (u.user_id, v_today, v_legs, v_summary)
      on conflict (user_id, set_date) do nothing;
      if not v_existing and v_secret is not null then
        perform net.http_post(
          url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
          headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
          body := jsonb_build_object('user_id', u.user_id, 'category', 'agent_picks', 'mute', true,
            'title', '🎲 Onside Triple', 'body', 'Today''s banker triple is ready — three strong picks, bigger return.',
            'url', '/agent', 'tag', 'onside-triple-' || v_today::text),
          timeout_milliseconds := 8000);
        v_created := v_created + 1;
      end if;
    end if;
  end loop;
  return v_created;
end;
$function$;

-- every 15 min, offset from the double so they don't fire in the same instant
select cron.schedule('onside-triple-slip', '3-59/15 * * * *', 'select public.build_onside_triple();');

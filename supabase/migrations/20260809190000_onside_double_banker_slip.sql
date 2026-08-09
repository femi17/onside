-- Onside Double: the daily "banker slip" — a 2-leg accumulator from each user's two safest premium
-- legs (proven-good agents only, scoring markets preferred). The analysis showed a 2-leg double is
-- the structure that actually wins DAYS (3 of the last 4), so this is the flagship "bet this today".

create table if not exists public.onside_double (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  set_date date not null default (now() at time zone 'Africa/Lagos')::date,
  legs jsonb not null default '[]'::jsonb,   -- [{delivery_id, rank, game, market, agent, prob, fixture_id}]
  summary text,
  created_at timestamptz not null default now(),
  unique (user_id, set_date)
);
alter table public.onside_double enable row level security;
drop policy if exists "read own double" on public.onside_double;
create policy "read own double" on public.onside_double for select using (auth.uid() = user_id);
grant select on public.onside_double to authenticated;

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

  -- any user with today's still-pending picks from a running agent
  for u in
    select distinct d.user_id
    from public.deliveries d
    join public.strategies st on st.id = d.strategy_id and st.status = 'running'
    where d.result = 'pending' and (d.delivered_at at time zone 'Africa/Lagos')::date = v_today
  loop
    with pool as (   -- safe, not-yet-started legs from PROVEN-GOOD agents only (the banker bar)
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
        and coalesce(d.market_prob, 0) >= 0.68                              -- safe floor (odds ~1.45 or shorter)
        and (aq.settled < 20 or coalesce(aq.win_rate, 1) >= 0.55)           -- strong agents only; unproven get a pass
    ),
    per_fix as (   -- safest pick per game; scoring markets slightly preferred over result markets
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
      on conflict (user_id, set_date) do update set legs = excluded.legs, summary = excluded.summary;
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

select cron.schedule('onside-double-slip', '*/15 * * * *', 'select public.build_onside_double();');

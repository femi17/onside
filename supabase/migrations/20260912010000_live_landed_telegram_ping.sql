-- Mirror of remotely applied migration live_landed_telegram_ping (2026-09-12).
-- Live "it's in!" Telegram ping the moment a TRACKED pick lands (won). Complements the existing
-- web-push results toggle (notify_delivery_settled / notify_ticket_settled), which stays unchanged
-- and still reports both wins and misses to push users. Telegram reaches the linked majority and is
-- the dopamine moment — so it's WON-ONLY (no demoralizing "missed" spam) and TRACKED-ONLY (tracking
-- a pick already opts into its alerts — owner rule). Fires in-play for monotonic markets (poll
-- early-settles them to won mid-game). Exactly-one via the same dedup the push path uses.

create or replace function public.notify_delivery_settled()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  v_secret text; v_name text; v_home text; v_away text; v_emoji text; v_verb text;
  v_tracked boolean; v_cat text; v_chat bigint; v_tgtoken text;
begin
  if NEW.result not in ('won','lost') then return NEW; end if;
  if OLD.result is not distinct from NEW.result then return NEW; end if;
  if OLD.result is not null and OLD.result <> 'pending' then return NEW; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;

  select exists (
    select 1 from public.tickets t
    where t.user_id = NEW.user_id and t.fixture_id = NEW.fixture_id
      and t.market_key = NEW.market_key
      and coalesce(t.side, '') = coalesce(NEW.side, '')
      and coalesce(t.line, -1) = coalesce(NEW.line, -1)
      and coalesce(t.period, 'ft') = coalesce(NEW.period, 'ft')
  ) into v_tracked;
  v_cat := case when v_tracked then 'results' else 'agent_games' end;

  select s.name into v_name from public.strategies s where s.id = NEW.strategy_id;
  select f.home_team, f.away_team into v_home, v_away from public.fixtures f where f.id = NEW.fixture_id;
  v_emoji := case when NEW.result = 'won' then '✅' else '❌' end;
  v_verb  := case when NEW.result = 'won' then 'landed' else 'missed' end;

  if v_secret is not null then
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
      body := jsonb_build_object(
        'user_id', NEW.user_id, 'category', v_cat, 'mute', not v_tracked,
        'title', v_emoji || ' ' || coalesce(v_name, 'Agent'),
        'body', coalesce(v_home, '') || ' v ' || coalesce(v_away, '') || ' — ' || coalesce(NEW.market_label, 'your pick') || ' ' || v_verb || '.',
        'url', '/agent', 'tag', 'settle-' || NEW.id::text
      ),
      timeout_milliseconds := 8000);
  end if;

  -- live Telegram celebration: tracked wins only
  if NEW.result = 'won' and v_tracked then
    select telegram_chat_id into v_chat from public.profiles where id = NEW.user_id;
    select decrypted_secret into v_tgtoken from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1;
    if v_chat is not null and v_tgtoken is not null then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || v_tgtoken || '/sendMessage',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'chat_id', v_chat, 'disable_web_page_preview', true,
          'text', '⚽ IT''S IN! ' || coalesce(NEW.market_label, 'Your pick') || ' just landed ✅' ||
                  E'\n' || coalesce(v_home, '') || ' v ' || coalesce(v_away, '')
        ),
        timeout_milliseconds := 8000);
    end if;
  end if;

  return NEW;
end;
$function$;

create or replace function public.notify_ticket_settled()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  v_secret text; v_home text; v_away text; v_emoji text; v_verb text; v_acca boolean;
  v_chat bigint; v_tgtoken text;
begin
  if NEW.status not in ('won','lost') then return NEW; end if;
  if OLD.status is not distinct from NEW.status then return NEW; end if;
  if OLD.status not in ('pending','live') then return NEW; end if;
  if coalesce(NEW.tracker_hidden, false) then return NEW; end if;
  if NEW.user_id is null or NEW.fixture_id is null then return NEW; end if;

  if exists (
    select 1 from public.deliveries d
    where d.user_id = NEW.user_id and d.fixture_id = NEW.fixture_id
      and d.market_key = NEW.market_key
      and coalesce(d.side, '') = coalesce(NEW.side, '')
      and coalesce(d.line, -1) = coalesce(NEW.line, -1)
      and coalesce(d.period, 'ft') = coalesce(NEW.period, 'ft')
  ) then return NEW; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;

  select f.home_team, f.away_team into v_home, v_away from public.fixtures f where f.id = NEW.fixture_id;
  v_emoji := case when NEW.status = 'won' then '✅' else '❌' end;
  v_verb  := case when NEW.status = 'won' then 'landed' else 'missed' end;
  v_acca  := NEW.accumulator_id is not null;

  if v_secret is not null then
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
      body := jsonb_build_object(
        'user_id', NEW.user_id, 'category', 'results',
        'title', v_emoji || ' ' || initcap(v_verb),
        'body', coalesce(NEW.market_label, NEW.custom_market, 'Your pick') || ' — ' || coalesce(v_home, '') || ' v ' || coalesce(v_away, '') || case when v_acca then ' · acca leg' else '' end,
        'url', case when v_acca then '/accumulators' else '/tracker' end,
        'tag', 'settle-t-' || NEW.id::text
      ),
      timeout_milliseconds := 8000);
  end if;

  -- live Telegram celebration: wins only (a tracked ticket = the user opted in by tracking it)
  if NEW.status = 'won' then
    select telegram_chat_id into v_chat from public.profiles where id = NEW.user_id;
    select decrypted_secret into v_tgtoken from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1;
    if v_chat is not null and v_tgtoken is not null then
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || v_tgtoken || '/sendMessage',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'chat_id', v_chat, 'disable_web_page_preview', true,
          'text', '⚽ IT''S IN! ' || coalesce(NEW.market_label, NEW.custom_market, 'Your pick') ||
                  ' just landed ✅' || case when v_acca then ' (acca leg)' else '' end ||
                  E'\n' || coalesce(v_home, '') || ' v ' || coalesce(v_away, '')
        ),
        timeout_milliseconds := 8000);
    end if;
  end if;

  return NEW;
end;
$function$;

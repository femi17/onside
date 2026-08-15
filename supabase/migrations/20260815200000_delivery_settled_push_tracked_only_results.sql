-- Owner rule: agent-pick pushes fire only for picks the user TRACKS (or when the agent_games
-- toggle is on). The landed/missed push therefore picks its category per pick at send time:
-- a matching ticket (same fixture+market+side+line+period, ANY status — the ticket may settle in
-- the same poll pass) -> 'results' (default-on toggle, "when your picks land or miss");
-- no matching ticket -> 'agent_games' (opt-in agent alerts, silent unless enabled; mute button
-- attached as with other agent_games sends).
create or replace function public.notify_delivery_settled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text; v_name text; v_home text; v_away text; v_emoji text; v_verb text;
  v_tracked boolean; v_cat text;
begin
  if NEW.result not in ('won','lost') then return NEW; end if;
  if OLD.result is not distinct from NEW.result then return NEW; end if;
  if OLD.result is not null and OLD.result <> 'pending' then return NEW; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;
  if v_secret is null then return NEW; end if;

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
  return NEW;
end;
$function$;

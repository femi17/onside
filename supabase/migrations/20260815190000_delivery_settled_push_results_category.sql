-- The per-pick landed/missed push now rides the `results` category — the settings toggle whose
-- description ("When your picks land or miss") exactly matches it, and which previously had no
-- sender. It was under agent_games, so anyone with agent game alerts off silently never got it.
-- One push per settle: trigger fires only on pending -> won/lost, tag settle-<id> replaces on
-- re-settle, and no other sender fires on delivery settlement. The mute action button is dropped —
-- it would have muted the whole results category under a misleading "agent alerts" label.
create or replace function public.notify_delivery_settled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text; v_name text; v_home text; v_away text; v_emoji text; v_verb text;
begin
  if NEW.result not in ('won','lost') then return NEW; end if;
  if OLD.result is not distinct from NEW.result then return NEW; end if;
  if OLD.result is not null and OLD.result <> 'pending' then return NEW; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;
  if v_secret is null then return NEW; end if;

  select s.name into v_name from public.strategies s where s.id = NEW.strategy_id;
  select f.home_team, f.away_team into v_home, v_away from public.fixtures f where f.id = NEW.fixture_id;
  v_emoji := case when NEW.result = 'won' then '✅' else '❌' end;
  v_verb  := case when NEW.result = 'won' then 'landed' else 'missed' end;

  perform net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', NEW.user_id, 'category', 'results',
      'title', v_emoji || ' ' || coalesce(v_name, 'Agent'),
      'body', coalesce(v_home, '') || ' v ' || coalesce(v_away, '') || ' — ' || coalesce(NEW.market_label, 'your pick') || ' ' || v_verb || '.',
      'url', '/agent', 'tag', 'settle-' || NEW.id::text
    ),
    timeout_milliseconds := 8000);
  return NEW;
end;
$function$;

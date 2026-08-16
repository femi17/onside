-- The Results toggle ("when your picks land or miss") had a sender for agent DELIVERIES only —
-- a slip/manual TICKET settling (acca leg or standalone) sent nothing. This trigger completes it:
-- every ticket that settles pending/live -> won/lost pushes under `results`.
-- Exactly-one-push dedup with notify_delivery_settled: the delivery push fires when a MATCHING
-- ticket exists; so here we stay silent when a matching delivery exists (it will speak for both).
-- Removed-from-tracker legs (tracker_hidden) stay silent. Voids stay silent.
create or replace function public.notify_ticket_settled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text; v_home text; v_away text; v_emoji text; v_verb text; v_acca boolean;
begin
  if NEW.status not in ('won','lost') then return NEW; end if;
  if OLD.status is not distinct from NEW.status then return NEW; end if;
  if OLD.status not in ('pending','live') then return NEW; end if;
  if coalesce(NEW.tracker_hidden, false) then return NEW; end if;
  if NEW.user_id is null or NEW.fixture_id is null then return NEW; end if;

  -- a matching agent delivery will push this result itself (results category, tracked pick)
  if exists (
    select 1 from public.deliveries d
    where d.user_id = NEW.user_id and d.fixture_id = NEW.fixture_id
      and d.market_key = NEW.market_key
      and coalesce(d.side, '') = coalesce(NEW.side, '')
      and coalesce(d.line, -1) = coalesce(NEW.line, -1)
      and coalesce(d.period, 'ft') = coalesce(NEW.period, 'ft')
  ) then return NEW; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;
  if v_secret is null then return NEW; end if;

  select f.home_team, f.away_team into v_home, v_away from public.fixtures f where f.id = NEW.fixture_id;
  v_emoji := case when NEW.status = 'won' then '✅' else '❌' end;
  v_verb  := case when NEW.status = 'won' then 'landed' else 'missed' end;
  v_acca  := NEW.accumulator_id is not null;

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
  return NEW;
end;
$function$;

drop trigger if exists trg_ticket_settled on public.tickets;
create trigger trg_ticket_settled
  after update of status on public.tickets
  for each row execute function public.notify_ticket_settled();

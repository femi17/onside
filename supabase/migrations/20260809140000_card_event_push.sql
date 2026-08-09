-- Card push alerts. Every live event push now carries the icon of what it's about:
-- goals ⚽ (existing), corners 🚩 (build-up trigger, existing) — and now cards 🟨/🟥.
-- The poller writes cards into fixtures.events (kind 'yellow'/'red' with side/player/min),
-- but the fixture-event trigger only fired on status/score changes, so cards were invisible.
-- This adds: (1) an opt-in `cards` category (noisy, like goals), (2) card detection in
-- notify_fixture_event, (3) `events` changes to the trigger's WHEN clause.
-- NOTE: send-push must know the 'cards' category BEFORE this lands (deployed together).

alter table public.notification_prefs
  add column if not exists cards boolean not null default false;

create or replace function public.notify_fixture_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text;
  v_users jsonb;
  v_hg int := coalesce(NEW.home_goals, 0);
  v_ag int := coalesce(NEW.away_goals, 0);
  v_old_tot int := coalesce(OLD.home_goals, 0) + coalesce(OLD.away_goals, 0);
  v_score text;
  v_live text[] := array['1H','2H','HT','ET','BT','P','LIVE','SUSP','INT'];
  v_fin  text[] := array['FT','AET','PEN'];
  v_is_kickoff boolean;
  v_is_ft boolean;
  v_is_goal boolean;
  v_is_card boolean;
  v_yc_new int := 0; v_rc_new int := 0; v_yc_old int := 0; v_rc_old int := 0;
  v_kind text; v_card_title text; v_card jsonb; v_team text; v_card_body text;
begin
  v_is_kickoff := (NEW.status = '1H') and (coalesce(OLD.status,'') <> all (v_live || v_fin));
  v_is_ft      := (NEW.status = any (v_fin)) and (coalesce(OLD.status,'') <> all (v_fin));
  v_is_goal    := (v_hg + v_ag) > v_old_tot and (NEW.status = any (v_live));

  -- new card in the live timeline? (poll rewrites fixtures.events each cycle; count, don't diff)
  if NEW.status = any (v_live) and NEW.events is distinct from OLD.events then
    select count(*) filter (where elem->>'kind' = 'yellow'),
           count(*) filter (where elem->>'kind' = 'red')
      into v_yc_new, v_rc_new
      from jsonb_array_elements(coalesce(NEW.events, '[]'::jsonb)) as t(elem);
    select count(*) filter (where elem->>'kind' = 'yellow'),
           count(*) filter (where elem->>'kind' = 'red')
      into v_yc_old, v_rc_old
      from jsonb_array_elements(coalesce(OLD.events, '[]'::jsonb)) as t(elem);
  end if;
  v_is_card := (v_rc_new > v_rc_old) or (v_yc_new > v_yc_old);

  if not (v_is_kickoff or v_is_ft or v_is_goal or v_is_card) then return NEW; end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;
  if v_secret is null then return NEW; end if;

  select coalesce(jsonb_agg(distinct uid), '[]'::jsonb) into v_users from (
    select user_id as uid from public.tickets     where fixture_id = NEW.id and status in ('pending','live') and user_id is not null
    union
    select user_id from public.agent_picks        where fixture_id = NEW.id and status in ('pending','live') and user_id is not null
    union
    select user_id from public.deliveries         where fixture_id = NEW.id and result = 'pending' and user_id is not null
  ) u;
  if v_users = '[]'::jsonb then return NEW; end if;

  v_score := coalesce(NEW.home_team,'') || ' ' || v_hg || '-' || v_ag || ' ' || coalesce(NEW.away_team,'');

  if v_is_kickoff then
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object('user_ids', v_users, 'category', 'kickoff',
        'title', '🟢 Kick-off',
        'body', coalesce(NEW.home_team,'') || ' v ' || coalesce(NEW.away_team,'') || ' is underway.',
        'url', '/tracker', 'tag', 'fx-' || NEW.id::text || '-ko'),
      timeout_milliseconds := 8000);
  end if;

  if v_is_goal then
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object('user_ids', v_users, 'category', 'goals',
        'title', '⚽ Goal!', 'body', v_score,
        'url', '/tracker', 'tag', 'fx-' || NEW.id::text || '-g' || (v_hg + v_ag)::text),
      timeout_milliseconds := 8000);
  end if;

  if v_is_card then
    -- red beats yellow when both arrive in one poll cycle; describe the latest card of that kind
    if v_rc_new > v_rc_old then v_kind := 'red'; v_card_title := '🟥 Red card';
    else v_kind := 'yellow'; v_card_title := '🟨 Yellow card'; end if;
    select elem into v_card
      from jsonb_array_elements(coalesce(NEW.events, '[]'::jsonb)) as t(elem)
      where elem->>'kind' = v_kind
      order by coalesce((elem->>'min')::int, 0) desc, coalesce((elem->>'extra')::int, 0) desc
      limit 1;
    v_team := case when v_card->>'side' = 'away' then NEW.away_team else NEW.home_team end;
    v_card_body := coalesce(v_team, '')
      || case when coalesce(v_card->>'player','') <> '' then ' — ' || (v_card->>'player') else '' end
      || case when v_card->>'min' is not null then ' ' || (v_card->>'min') || '''' else '' end
      || ' · ' || v_score;
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object('user_ids', v_users, 'category', 'cards',
        'title', v_card_title, 'body', v_card_body,
        'url', '/tracker', 'tag', 'fx-' || NEW.id::text || '-c' || (v_yc_new + v_rc_new)::text),
      timeout_milliseconds := 8000);
  end if;

  if v_is_ft then
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object('user_ids', v_users, 'category', 'full_time',
        'title', '⏱️ Full-time', 'body', v_score,
        'url', '/tracker', 'tag', 'fx-' || NEW.id::text || '-ft'),
      timeout_milliseconds := 8000);
  end if;

  return NEW;
end;
$function$;

-- the trigger must also fire when only the events timeline changed (cards don't move the score)
drop trigger if exists trg_fixture_event_push on public.fixtures;
create trigger trg_fixture_event_push
  after update on public.fixtures
  for each row
  when (old.status is distinct from new.status
     or old.home_goals is distinct from new.home_goals
     or old.away_goals is distinct from new.away_goals
     or old.events is distinct from new.events)
  execute function public.notify_fixture_event();

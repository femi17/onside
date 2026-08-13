-- Kick-off / goal / card / full-time pushes (notify_fixture_event) fanned out to EVERY user who has the
-- fixture — including users who only have it via an agent pick (no tracked ticket) — under the default-on
-- kickoff/goals/full_time categories. So agent-game event alerts ignored the agent_games opt-in toggle.
-- Fix: split recipients. Users with a pending/live TICKET keep their normal event category; users who
-- only have an agent pick (agent_picks/deliveries, no ticket) get the SAME event under the opt-in
-- agent_games category (with the Mute button). Turn agent_games off → no agent-game event pushes at all.

create or replace function public._push_fixture_groups(
  v_secret text, v_tracked jsonb, v_agent jsonb, evt_cat text, p_title text, p_body text, p_tag text
) returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if v_tracked is not null and v_tracked <> '[]'::jsonb then
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object('user_ids', v_tracked, 'category', evt_cat,
        'title', p_title, 'body', p_body, 'url', '/tracker', 'tag', p_tag),
      timeout_milliseconds := 8000);
  end if;
  if v_agent is not null and v_agent <> '[]'::jsonb then
    perform net.http_post(
      url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
      body := jsonb_build_object('user_ids', v_agent, 'category', 'agent_games', 'mute', true,
        'title', p_title, 'body', p_body, 'url', '/agent', 'tag', p_tag),
      timeout_milliseconds := 8000);
  end if;
end;
$function$;

create or replace function public.notify_fixture_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text;
  v_tracked jsonb;   -- users with a pending/live TICKET on this fixture (normal event categories)
  v_agent jsonb;     -- users who only have an agent pick on it (routed to agent_games)
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

  -- tracked = has a pending/live ticket; agent = has an agent pick but NO such ticket
  select coalesce(jsonb_agg(distinct user_id), '[]'::jsonb) into v_tracked
    from public.tickets where fixture_id = NEW.id and status in ('pending','live') and user_id is not null;

  select coalesce(jsonb_agg(distinct uid), '[]'::jsonb) into v_agent
  from (
    select user_id as uid from public.agent_picks where fixture_id = NEW.id and status in ('pending','live') and user_id is not null
    union
    select user_id from public.deliveries where fixture_id = NEW.id and result = 'pending' and user_id is not null
  ) u
  where u.uid not in (
    select t.user_id from public.tickets t where t.fixture_id = NEW.id and t.status in ('pending','live') and t.user_id is not null
  );

  if v_tracked = '[]'::jsonb and v_agent = '[]'::jsonb then return NEW; end if;

  v_score := coalesce(NEW.home_team,'') || ' ' || v_hg || '-' || v_ag || ' ' || coalesce(NEW.away_team,'');

  if v_is_kickoff then
    perform public._push_fixture_groups(v_secret, v_tracked, v_agent, 'kickoff',
      '🟢 Kick-off',
      coalesce(NEW.home_team,'') || ' v ' || coalesce(NEW.away_team,'') || ' is underway.',
      'fx-' || NEW.id::text || '-ko');
  end if;

  if v_is_goal then
    perform public._push_fixture_groups(v_secret, v_tracked, v_agent, 'goals',
      '⚽ Goal!', v_score, 'fx-' || NEW.id::text || '-g' || (v_hg + v_ag)::text);
  end if;

  if v_is_card then
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
    perform public._push_fixture_groups(v_secret, v_tracked, v_agent, 'cards',
      v_card_title, v_card_body, 'fx-' || NEW.id::text || '-c' || (v_yc_new + v_rc_new)::text);
  end if;

  if v_is_ft then
    perform public._push_fixture_groups(v_secret, v_tracked, v_agent, 'full_time',
      '⏱️ Full-time', v_score, 'fx-' || NEW.id::text || '-ft');
  end if;

  return NEW;
end;
$function$;

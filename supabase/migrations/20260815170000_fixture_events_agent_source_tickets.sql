-- Tracking an agent pick creates a ticket (source='agent') — that moved the game from the opt-in
-- agent_games audience into the tracked audience, so kickoff/FT fired under the default-on
-- kickoff/full_time categories even with agent alerts off. Agent-origin tickets now stay in the
-- agent audience: "agent picks" toggles govern agent-picked games even after the user tracks them.
-- Tracked audience = games the user added THEMSELVES (slip screenshots / manual adds).
create or replace function public.notify_fixture_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text;
  v_tracked jsonb;
  v_agent jsonb;
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

  -- tracked = users with a pending/live ticket they added THEMSELVES (not tracked agent picks)
  select coalesce(jsonb_agg(distinct user_id), '[]'::jsonb) into v_tracked
    from public.tickets
   where fixture_id = NEW.id and status in ('pending','live') and user_id is not null
     and coalesce(source,'') <> 'agent';

  -- agent audience = agent picks/deliveries AND agent-origin tickets, minus anyone already tracked
  select coalesce(jsonb_agg(distinct uid), '[]'::jsonb) into v_agent
  from (
    select user_id as uid from public.agent_picks where fixture_id = NEW.id and status in ('pending','live') and user_id is not null
    union
    select user_id from public.deliveries where fixture_id = NEW.id and result = 'pending' and user_id is not null
    union
    select user_id from public.tickets where fixture_id = NEW.id and status in ('pending','live') and user_id is not null and source = 'agent'
  ) u
  where u.uid not in (
    select t.user_id from public.tickets t
     where t.fixture_id = NEW.id and t.status in ('pending','live') and t.user_id is not null
       and coalesce(t.source,'') <> 'agent'
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

-- OWNER-RULED swing pushes (default ON): for result-market bets (1X2 / double chance / DNB) a
-- goal that FLIPS the bet's live verdict — on-track ↔ behind — pushes with bet-aware framing
-- ("your Double Chance (12) is now behind"). Investigation background: the raw ⚽ goal push is
-- opt-in 'goals' (noisy), while goal-line bets early-settle mid-match via default-on 'results'
-- — so result-market holders heard nothing when a goal went against them until FT. Raw
-- every-goal alerts stay opt-in; swing is the default-on, high-signal middle.

-- prefs column: null = category default (ON); false = user muted it in Profile
alter table public.notification_prefs add column if not exists swing boolean;

-- is this result-family pick currently satisfied by the scoreline? null = not a result market
create or replace function public.result_on_track(mk text, side text, hg int, ag int)
returns boolean
language sql
immutable
as $function$
  select case mk
    when 'home_win' then hg > ag
    when 'away_win' then ag > hg
    when 'draw' then hg = ag
    when 'result_1x2' then case side when 'home' then hg > ag when 'away' then ag > hg when 'draw' then hg = ag else null end
    when 'double_chance_1x' then hg >= ag
    when 'double_chance_x2' then ag >= hg
    when 'double_chance_12' then hg <> ag
    when 'double_chance' then case side when '1x' then hg >= ag when 'x2' then ag >= hg when '12' then hg <> ag else null end
    when 'dnb' then case side when 'home' then hg >= ag when 'away' then ag >= hg else null end
    else null
  end
$function$;

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
  v_ohg int := coalesce(OLD.home_goals, 0);
  v_oag int := coalesce(OLD.away_goals, 0);
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
  v_swing record;
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

  -- tracked = a VISIBLE pending/live ticket on this game; tracker_hidden legs (cut accas) don't count
  select coalesce(jsonb_agg(distinct user_id), '[]'::jsonb) into v_tracked
    from public.tickets
    where fixture_id = NEW.id and status in ('pending','live') and user_id is not null
      and coalesce(tracker_hidden, false) = false;

  select coalesce(jsonb_agg(distinct uid), '[]'::jsonb) into v_agent
  from (
    select user_id as uid from public.agent_picks where fixture_id = NEW.id and status in ('pending','live') and user_id is not null
    union
    select user_id from public.deliveries where fixture_id = NEW.id and result = 'pending' and user_id is not null
  ) u
  where u.uid not in (
    select t.user_id from public.tickets t
    where t.fixture_id = NEW.id and t.status in ('pending','live') and t.user_id is not null
      and coalesce(t.tracker_hidden, false) = false
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

    -- swing pushes (default-on): the goal FLIPPED a result-market pick's live verdict.
    -- One push per user (their first flipped bet carries the framing).
    for v_swing in
      select distinct on (t.user_id)
             t.user_id,
             coalesce(nullif(t.market_label, ''), t.market_key) as label,
             public.result_on_track(t.market_key, t.side, v_hg, v_ag) as now_ok
      from public.tickets t
      where t.fixture_id = NEW.id and t.status in ('pending','live') and t.user_id is not null
        and coalesce(t.tracker_hidden, false) = false
        and public.result_on_track(t.market_key, t.side, v_hg, v_ag) is not null
        and public.result_on_track(t.market_key, t.side, v_hg, v_ag)
            is distinct from public.result_on_track(t.market_key, t.side, v_ohg, v_oag)
      order by t.user_id
    loop
      perform public._push_fixture_groups(v_secret, jsonb_build_array(v_swing.user_id), '[]'::jsonb, 'swing',
        case when v_swing.now_ok then '⚽ Back on track' else '⚠️ Goal against you' end,
        v_score || ' — your ' || v_swing.label ||
          case when v_swing.now_ok then ' is back on track.' else ' is now behind.' end,
        'fx-' || NEW.id::text || '-sw' || (v_hg + v_ag)::text);
    end loop;
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

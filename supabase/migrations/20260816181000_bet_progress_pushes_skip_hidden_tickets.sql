-- (2/2) Same sweep as notify_fixture_event: a cut acca's legs (tracker_hidden=true, still
-- 'pending') must not send build-up pushes, and a hidden ticket must not suppress the agent-side
-- progress push for the same bet (the ticket-side push will never come).
create or replace function public.notify_bet_progress()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text;
  v_mk text := NEW.market_key;
  v_val int := floor(coalesce(NEW.current_value, 0))::int;
  v_line numeric := NEW.line;
  v_period text := coalesce(NEW.period, 'ft');
  v_home text; v_away text;
  v_is_corner boolean;
  v_over boolean;
  v_unit text; v_emoji text; v_desc text; v_plabel text; v_body text;
  v_needed int; v_remaining int; v_bust int; v_left int;
  v_status text; v_hg int; v_ag int; v_events jsonb;
  v_g1h_home int; v_g1h_away int; v_cht int;
  v_is_ticket boolean := TG_TABLE_NAME = 'tickets';
begin
  if NEW.current_value is null then return NEW; end if;
  -- a leg swept off the tracker (cut acca) is not tracked — no build-up pushes for it
  if v_is_ticket then
    if coalesce(NEW.tracker_hidden, false) then return NEW; end if;
  end if;
  v_is_corner := v_mk in ('over_8_5_corners', 'corners_ou');
  if not (v_is_corner or v_mk in
    ('over_0_5','over_1_5','over_2_5','over_3_5','under_2_5','under_3_5','total_goals_ou',
     'home_goals_ou','away_goals_ou')) then
    return NEW;
  end if;

  if TG_TABLE_NAME in ('deliveries', 'agent_picks') then
    if exists (
      select 1 from public.tickets t
      where t.user_id = NEW.user_id and t.fixture_id = NEW.fixture_id
        and t.market_key = NEW.market_key
        and coalesce(t.side, '') = coalesce(NEW.side, '')
        and coalesce(t.line, -1) = coalesce(NEW.line, -1)
        and coalesce(t.period, 'ft') = coalesce(NEW.period, 'ft')
        and t.status in ('pending', 'live')
        and coalesce(t.tracker_hidden, false) = false
    ) then
      return NEW;
    end if;
  end if;

  if v_line is null then
    v_line := case v_mk
      when 'over_0_5' then 0.5 when 'over_1_5' then 1.5 when 'over_2_5' then 2.5 when 'over_3_5' then 3.5
      when 'under_2_5' then 2.5 when 'under_3_5' then 3.5 when 'over_8_5_corners' then 8.5 end;
  end if;
  if v_line is null then return NEW; end if;

  if v_period <> 'ft' then
    select f.status, coalesce(f.home_goals,0), coalesce(f.away_goals,0), f.events
      into v_status, v_hg, v_ag, v_events
    from public.fixtures f where f.id = NEW.fixture_id;
    if v_period = '1h' then
      if v_status is null or v_status not in ('1H','HT') then return NEW; end if;
      v_val := case
        when v_is_corner then floor(coalesce(NEW.current_value,0))::int
        when v_mk = 'home_goals_ou' then v_hg
        when v_mk = 'away_goals_ou' then v_ag
        else v_hg + v_ag end;
    else
      if v_status is null or v_status not in ('2H','ET','BT','P','LIVE','INT','SUSP') then return NEW; end if;
      if v_is_corner then
        select coalesce(fs.corners_home_ht,0) + coalesce(fs.corners_away_ht,0) into v_cht
          from public.fixture_stats fs where fs.fixture_id = NEW.fixture_id;
        v_val := greatest(0, floor(coalesce(NEW.current_value,0))::int - coalesce(v_cht,0));
      else
        select
          count(*) filter (where (elem->>'kind') in ('goal','pen','og') and (elem->>'side')='home' and coalesce((elem->>'min')::int,999) <= 45),
          count(*) filter (where (elem->>'kind') in ('goal','pen','og') and (elem->>'side')='away' and coalesce((elem->>'min')::int,999) <= 45)
          into v_g1h_home, v_g1h_away
        from jsonb_array_elements(coalesce(v_events, '[]'::jsonb)) as t(elem);
        v_val := case
          when v_mk = 'home_goals_ou' then greatest(0, v_hg - coalesce(v_g1h_home,0))
          when v_mk = 'away_goals_ou' then greatest(0, v_ag - coalesce(v_g1h_away,0))
          else greatest(0, (v_hg + v_ag) - coalesce(v_g1h_home,0) - coalesce(v_g1h_away,0)) end;
      end if;
    end if;
  end if;

  v_over := coalesce(NEW.side, 'over') <> 'under';
  v_unit := case when v_is_corner then 'corners' else 'goals' end;
  v_emoji := case when v_is_corner then '🚩' else '⚽' end;
  v_desc := case v_mk when 'home_goals_ou' then 'Home ' when 'away_goals_ou' then 'Away ' else '' end;
  v_plabel := case v_period when '1h' then ' (1st half)' when '2h' then ' (2nd half)' else '' end;

  if v_over then
    v_needed := floor(v_line)::int + 1;
    v_remaining := v_needed - v_val;
    if v_remaining <= 0 then return NEW; end if;
    v_body := v_desc || 'Over ' || v_line || ' ' || v_unit || v_plabel || ' — ' || v_val || '/' || v_line
      || ', building up · ' || v_remaining || ' more to clear';
  else
    v_bust := floor(v_line)::int + 1;
    v_left := v_bust - v_val;
    if v_left <= 0 then return NEW; end if;
    v_body := v_desc || 'Under ' || v_line || ' ' || v_unit || v_plabel || ' — ' || v_val || ' so far, counting down · '
      || v_left || ' more ends it';
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret' limit 1;
  if v_secret is null then return NEW; end if;
  select f.home_team, f.away_team into v_home, v_away from public.fixtures f where f.id = NEW.fixture_id;

  perform net.http_post(
    url := 'https://mbrtpetpgsggnlcazhqd.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', NEW.user_id, 'category', case when v_is_ticket then 'build_up' else 'agent_games' end,
      'mute', not v_is_ticket,
      'title', v_emoji || ' ' || coalesce(v_home, '') || ' v ' || coalesce(v_away, ''),
      'body', v_body, 'url', case when v_is_ticket then '/tracker' else '/agent' end,
      'tag', 'prog-' || NEW.id::text || '-' || v_period || '-' || v_val::text
    ),
    timeout_milliseconds := 8000);
  return NEW;
end;
$function$;

-- Row-level guard for goals-in-a-row settlement.
--
-- The poll's live path (updateRowsLive) rewrites every open in-a-row ticket to status='live' on
-- EVERY pass. For a run that completed before the fixtures-events trigger existed (or in the gap
-- between passes), that reopen would sit 'live' until full time because nothing re-fires the events
-- trigger without a new goal. This BEFORE-UPDATE guard closes that hole: any write that leaves an
-- in-a-row bet open is checked against the fixture's current timeline and flipped to won/lost the
-- instant the run is reached — no race with the poll, and it self-heals rows the events trigger
-- couldn't (the poll's next 'live' write on such a row triggers the guard, which settles it).

create or replace function public.guard_in_row_row()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_any int; v_home int; v_away int; v_evs jsonb; v_gc int; v_res text;
begin
  select events into v_evs from public.fixtures where id = NEW.fixture_id;
  select mx_any, mx_home, mx_away into v_any, v_home, v_away from public.goals_in_row_maxes(v_evs);
  if not public._in_row_reached(NEW.market_key, v_any, v_home, v_away) then
    return NEW;  -- run not reached yet — leave the poll's live/pending value alone
  end if;
  select count(*) into v_gc from jsonb_array_elements(coalesce(v_evs, '[]'::jsonb)) as elem
    where elem->>'kind' in ('goal','pen','og');
  v_res := case when coalesce(NEW.side,'yes') = 'no' then 'lost' else 'won' end;  -- Yes hit / No busted
  if TG_TABLE_NAME = 'deliveries' then NEW.result := v_res; else NEW.status := v_res; end if;
  NEW.current_value := v_gc;
  NEW.settled_at := now();
  return NEW;
end;
$function$;

-- fire only for the in-a-row markets, and only for writes that would leave the bet open
drop trigger if exists trg_guard_in_row_tickets on public.tickets;
create trigger trg_guard_in_row_tickets
  before update on public.tickets
  for each row
  when (new.market_key in ('goals_in_row_2','goals_in_row_3','home_goals_in_row_2','home_goals_in_row_3','away_goals_in_row_2','away_goals_in_row_3')
        and coalesce(new.period,'ft') = 'ft' and new.status in ('pending','live'))
  execute function public.guard_in_row_row();

drop trigger if exists trg_guard_in_row_agent_picks on public.agent_picks;
create trigger trg_guard_in_row_agent_picks
  before update on public.agent_picks
  for each row
  when (new.market_key in ('goals_in_row_2','goals_in_row_3','home_goals_in_row_2','home_goals_in_row_3','away_goals_in_row_2','away_goals_in_row_3')
        and coalesce(new.period,'ft') = 'ft' and new.status in ('pending','live'))
  execute function public.guard_in_row_row();

drop trigger if exists trg_guard_in_row_deliveries on public.deliveries;
create trigger trg_guard_in_row_deliveries
  before update on public.deliveries
  for each row
  when (new.market_key in ('goals_in_row_2','goals_in_row_3','home_goals_in_row_2','home_goals_in_row_3','away_goals_in_row_2','away_goals_in_row_3')
        and coalesce(new.period,'ft') = 'ft' and new.result = 'pending')
  execute function public.guard_in_row_row();

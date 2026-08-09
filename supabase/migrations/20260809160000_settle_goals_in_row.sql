-- Early-settle "goals in a row" bets during live play.
--
-- goals_in_row_N (any/home/away) is decided the instant a team reaches N consecutive goals with no
-- reply between: Yes wins, No busts. The poll grades it correctly at full time, but its live path
-- (updateRowsLive) only has goal COUNTS, not the ordered timeline, so these bets sat "live" until FT
-- even after the run had already happened (e.g. a 3-0 half where one team scored all three). This
-- settles them off fixtures.events — which the poll rewrites on every goal — via a trigger.
--
-- The streak maths mirrors the engine's maxGoalsInRow exactly: own goals are already credited to the
-- benefiting team in the stored events (side flipped), kind in (goal/pen/og), ordered by minute.
--
-- Interaction with the poll: within one poll pass updateRowsLive runs first (leaving the row "live"),
-- then the poll rewrites fixtures.events which fires this trigger and settles the row. Once settled,
-- the row drops out of the poll's pending/live snapshot, so later passes leave it alone — the two
-- converge. FT still grades any unreached "No" as won via the poll's settle().

create or replace function public.goals_in_row_maxes(evs jsonb)
returns table(mx_any int, mx_home int, mx_away int)
language plpgsql
immutable
as $function$
declare
  s text;
  cur text;
  run_any int := 0; max_any int := 0;
  run_home int := 0; max_home int := 0;
  run_away int := 0; max_away int := 0;
begin
  for s in
    select elem->>'side'
    from jsonb_array_elements(coalesce(evs, '[]'::jsonb)) as elem
    where elem->>'kind' in ('goal', 'pen', 'og')
    order by coalesce((elem->>'min')::int, 0), coalesce((elem->>'extra')::int, 0)
  loop
    -- any team: longest run regardless of which team, reset when the scorer changes
    if s is distinct from cur then cur := s; run_any := 1; else run_any := run_any + 1; end if;
    if run_any > max_any then max_any := run_any; end if;
    -- home: run resets to 0 whenever the away team scores
    if s = 'home' then run_home := run_home + 1; if run_home > max_home then max_home := run_home; end if;
    else run_home := 0; end if;
    -- away: symmetric
    if s = 'away' then run_away := run_away + 1; if run_away > max_away then max_away := run_away; end if;
    else run_away := 0; end if;
  end loop;
  mx_any := max_any; mx_home := max_home; mx_away := max_away;
  return next;
end;
$function$;

-- has the fixture's timeline reached the target for this market key?
create or replace function public._in_row_reached(mk text, v_any int, v_home int, v_away int)
returns boolean
language sql
immutable
as $function$
  select case mk
    when 'goals_in_row_2' then v_any  >= 2
    when 'goals_in_row_3' then v_any  >= 3
    when 'home_goals_in_row_2' then v_home >= 2
    when 'home_goals_in_row_3' then v_home >= 3
    when 'away_goals_in_row_2' then v_away >= 2
    when 'away_goals_in_row_3' then v_away >= 3
    else false
  end;
$function$;

create or replace function public.settle_goals_in_row()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_any int; v_home int; v_away int; v_gc int;
  v_live text[] := array['1H','2H','HT','ET','BT','P','LIVE','SUSP','INT'];
  v_keys text[] := array['goals_in_row_2','goals_in_row_3','home_goals_in_row_2',
                         'home_goals_in_row_3','away_goals_in_row_2','away_goals_in_row_3'];
begin
  -- only while live; full time is graded by the poll's settle()
  if NEW.status <> all (v_live) then return NEW; end if;

  -- skip the streak maths unless this fixture actually carries an in-a-row bet (open or already
  -- early-settled, so a VAR reversal can revert one)
  if not exists (
    select 1 from public.tickets      where fixture_id = NEW.id and market_key = any(v_keys) and status in ('pending','live','won','lost')
    union all
    select 1 from public.agent_picks  where fixture_id = NEW.id and market_key = any(v_keys) and status in ('pending','live','won','lost')
    union all
    select 1 from public.deliveries   where fixture_id = NEW.id and market_key = any(v_keys) and result in ('pending','won','lost')
  ) then return NEW; end if;

  select mx_any, mx_home, mx_away into v_any, v_home, v_away
    from public.goals_in_row_maxes(NEW.events);
  select count(*) into v_gc
    from jsonb_array_elements(coalesce(NEW.events, '[]'::jsonb)) as elem
    where elem->>'kind' in ('goal','pen','og');

  -- SETTLE reached bets: Yes -> won, No -> lost (tickets/agent_picks use status, deliveries result)
  update public.tickets t set
    status = case when coalesce(t.side,'yes') = 'no' then 'lost' else 'won' end,
    current_value = v_gc, settled_at = now()
  where t.fixture_id = NEW.id and t.period = 'ft' and t.status in ('pending','live')
    and public._in_row_reached(t.market_key, v_any, v_home, v_away);

  update public.agent_picks t set
    status = case when coalesce(t.side,'yes') = 'no' then 'lost' else 'won' end,
    current_value = v_gc, settled_at = now()
  where t.fixture_id = NEW.id and t.period = 'ft' and t.status in ('pending','live')
    and public._in_row_reached(t.market_key, v_any, v_home, v_away);

  update public.deliveries t set
    result = case when coalesce(t.side,'yes') = 'no' then 'lost' else 'won' end,
    current_value = v_gc, settled_at = now()
  where t.fixture_id = NEW.id and t.period = 'ft' and t.result = 'pending'
    and public._in_row_reached(t.market_key, v_any, v_home, v_away);

  -- REVERT an early-settled bet whose run a later VAR call has broken (rare but keeps us honest)
  update public.tickets t set status = 'live', settled_at = null
  where t.fixture_id = NEW.id and t.period = 'ft' and t.status in ('won','lost')
    and t.market_key = any(v_keys) and not public._in_row_reached(t.market_key, v_any, v_home, v_away);

  update public.agent_picks t set status = 'live', settled_at = null
  where t.fixture_id = NEW.id and t.period = 'ft' and t.status in ('won','lost')
    and t.market_key = any(v_keys) and not public._in_row_reached(t.market_key, v_any, v_home, v_away);

  update public.deliveries t set result = 'pending', settled_at = null
  where t.fixture_id = NEW.id and t.period = 'ft' and t.result in ('won','lost')
    and t.market_key = any(v_keys) and not public._in_row_reached(t.market_key, v_any, v_home, v_away);

  return NEW;
end;
$function$;

drop trigger if exists trg_settle_goals_in_row on public.fixtures;
create trigger trg_settle_goals_in_row
  after update on public.fixtures
  for each row
  when (old.events is distinct from new.events)
  execute function public.settle_goals_in_row();

-- one-time backfill: settle any live in-a-row bet whose run has already happened (the games that
-- prompted this — a completed 3-in-a-row sitting live because the trigger didn't exist yet).
update public.tickets t set
  status = case when coalesce(t.side,'yes') = 'no' then 'lost' else 'won' end,
  current_value = (select count(*) from jsonb_array_elements(coalesce(f.events,'[]'::jsonb)) e where e->>'kind' in ('goal','pen','og')),
  settled_at = now()
from public.fixtures f, lateral public.goals_in_row_maxes(f.events) m
where t.fixture_id = f.id and t.period = 'ft' and t.status in ('pending','live')
  and f.status in ('1H','2H','HT','ET','BT','P','LIVE','SUSP','INT')
  and public._in_row_reached(t.market_key, m.mx_any, m.mx_home, m.mx_away);

update public.agent_picks t set
  status = case when coalesce(t.side,'yes') = 'no' then 'lost' else 'won' end,
  current_value = (select count(*) from jsonb_array_elements(coalesce(f.events,'[]'::jsonb)) e where e->>'kind' in ('goal','pen','og')),
  settled_at = now()
from public.fixtures f, lateral public.goals_in_row_maxes(f.events) m
where t.fixture_id = f.id and t.period = 'ft' and t.status in ('pending','live')
  and f.status in ('1H','2H','HT','ET','BT','P','LIVE','SUSP','INT')
  and public._in_row_reached(t.market_key, m.mx_any, m.mx_home, m.mx_away);

update public.deliveries t set
  result = case when coalesce(t.side,'yes') = 'no' then 'lost' else 'won' end,
  current_value = (select count(*) from jsonb_array_elements(coalesce(f.events,'[]'::jsonb)) e where e->>'kind' in ('goal','pen','og')),
  settled_at = now()
from public.fixtures f, lateral public.goals_in_row_maxes(f.events) m
where t.fixture_id = f.id and t.period = 'ft' and t.result = 'pending'
  and f.status in ('1H','2H','HT','ET','BT','P','LIVE','SUSP','INT')
  and public._in_row_reached(t.market_key, m.mx_any, m.mx_home, m.mx_away);

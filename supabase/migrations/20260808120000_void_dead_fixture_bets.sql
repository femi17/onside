-- Postponed/cancelled games settle themselves. When a fixture's status flips to a dead state
-- (PST postponed, CANC cancelled, ABD abandoned, AWD awarded, WO walkover), any open tracker
-- ticket and any pending agent delivery on it is voided automatically — mirroring how bookmakers
-- refund stakes on games that never get played as scheduled. Trigger-level so it works no matter
-- which sync path (sync fn, poll fn, manual fix) flips the status.

create or replace function public.void_dead_fixture_bets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('PST','CANC','ABD','AWD','WO') and new.status is distinct from old.status then
    update public.tickets
       set status = 'void', settled_at = now()
     where fixture_id = new.id and status in ('pending','live');
    update public.deliveries
       set result = 'void'
     where fixture_id = new.id and result = 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_void_dead_fixture_bets on public.fixtures;
create trigger trg_void_dead_fixture_bets
  after update of status on public.fixtures
  for each row execute function public.void_dead_fixture_bets();

-- backfill: settle anything already sitting on a dead game
update public.tickets t
   set status = 'void', settled_at = now()
  from public.fixtures f
 where f.id = t.fixture_id
   and f.status in ('PST','CANC','ABD','AWD','WO')
   and t.status in ('pending','live');

update public.deliveries d
   set result = 'void'
  from public.fixtures f
 where f.id = d.fixture_id
   and f.status in ('PST','CANC','ABD','AWD','WO')
   and d.result = 'pending';

-- A cut slip used to void every sibling leg, which dropped those legs out of the poll's
-- pending/live query — their games stopped tracking and the board read "not counted".
-- Now the acca is marked lost the moment a leg cuts, but the other legs keep settling to
-- their real result, so a dead slip still reads honestly: "10 safe, 1 cut".
create or replace function public.settle_accumulator()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.accumulator_id is null then
    return new;
  end if;

  if new.status = 'lost' and old.status is distinct from 'lost' then
    update accumulators set status = 'lost' where id = new.accumulator_id and status <> 'lost';

  elsif new.status = 'won' and old.status is distinct from 'won' then
    -- all legs won -> acca won (a lost leg keeps its lost status now, so this can
    -- never flip a dead slip back to won)
    if not exists (
      select 1 from tickets
      where accumulator_id = new.accumulator_id and status <> 'won'
    ) then
      update accumulators set status = 'won' where id = new.accumulator_id and status <> 'lost';
    end if;
  end if;

  return new;
end;
$$;

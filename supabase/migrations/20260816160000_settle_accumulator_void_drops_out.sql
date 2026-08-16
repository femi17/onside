-- Owner push rule: a VOID leg drops out of an acca (stake-back on that leg), it neither wins nor
-- kills the slip. Before this, the "all legs won" check counted a void leg as not-won, so an acca
-- with a voided leg could never settle won. Now: all legs won-or-void -> acca won (or void when
-- every single leg voided).
create or replace function public.settle_accumulator()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.accumulator_id is null then
    return new;
  end if;

  if new.status = 'lost' and old.status is distinct from 'lost' then
    update accumulators set status = 'lost' where id = new.accumulator_id and status <> 'lost';
    -- the slip is dead — clear its games off the tracker (safe: the trigger only
    -- fires on status changes, so this tracker_hidden update can't re-enter)
    update tickets set tracker_hidden = true
      where accumulator_id = new.accumulator_id and tracker_hidden is distinct from true;

  elsif new.status in ('won', 'void') and old.status is distinct from new.status then
    -- every leg settled won-or-void -> the acca wins on the legs that stood; a fully
    -- voided slip is itself void (stake back). A lost leg keeps the slip lost.
    if not exists (
      select 1 from tickets
      where accumulator_id = new.accumulator_id and status not in ('won', 'void')
    ) then
      if exists (
        select 1 from tickets
        where accumulator_id = new.accumulator_id and status = 'won'
      ) then
        update accumulators set status = 'won' where id = new.accumulator_id and status not in ('lost', 'won');
      else
        update accumulators set status = 'void' where id = new.accumulator_id and status not in ('lost', 'void');
      end if;
    end if;
  end if;

  return new;
end;
$function$;

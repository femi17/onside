-- A cut slip's games come off the tracker: the moment a leg cuts the acca, every leg
-- on that slip is hidden there (tracker_hidden). The legs stay on the slip and keep
-- settling to their real results (poll ignores tracker_hidden), and an open leg can
-- still be re-added from the acca card with one tap.
--
-- Cut slips can also be deleted from /accumulators. Deletion is a SOFT delete
-- (deleted_at) on purpose: slip_upload_quota and enforce_acca_daily_limit both count
-- rows in accumulators, so a hard delete would refund the day's upload/acca quota.
-- Soft-deleted rows keep counting toward both; the UI just stops showing them.

alter table public.accumulators add column if not exists deleted_at timestamptz;

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
    -- the slip is dead — clear its games off the tracker (safe: the trigger only
    -- fires on status changes, so this tracker_hidden update can't re-enter)
    update tickets set tracker_hidden = true
      where accumulator_id = new.accumulator_id and tracker_hidden is distinct from true;

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

-- backfill: hide the legs of slips that already cut before this migration
update public.tickets t
set tracker_hidden = true
from public.accumulators a
where t.accumulator_id = a.id
  and a.status = 'lost'
  and t.tracker_hidden is distinct from true;

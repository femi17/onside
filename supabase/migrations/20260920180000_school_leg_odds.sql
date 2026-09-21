-- Onside School — real bookie odds per leg.
-- The record's per-leg price defaults to the MODEL's Over 2.5 estimate (1/prob), which runs higher
-- than the actual bookie line, so the displayed profit over-states what a member really collects.
-- This table lets an admin type the REAL odds they took at the book (e.g. Kansas 1.41) per fixture;
-- the card + profit + monthly totals then recompute on real money. Where no real odds is entered yet,
-- the model estimate still shows (prefixed "~").
--
-- Source of truth: keyed by fixture_id (a leg == a fixture). Everyone may READ (the record is public
-- motivation); only the security-definer admin RPC below may WRITE, so no member can doctor the record.

create table if not exists public.school_leg_odds (
  fixture_id bigint primary key,
  odds numeric not null check (odds > 1),      -- the real decimal odds taken at the bookie
  set_by uuid,                                 -- admin who entered it
  updated_at timestamptz not null default now()
);

alter table public.school_leg_odds enable row level security;

-- everyone signed in reads the real record
drop policy if exists school_odds_sel on public.school_leg_odds;
create policy school_odds_sel on public.school_leg_odds
  for select using (true);
-- (no user INSERT/UPDATE/DELETE policy: only the admin RPC below mutates real odds)

grant select on public.school_leg_odds to authenticated;

-- Set (or clear) the real bookie odds for a leg. p_odds > 1 upserts; null/<=1 clears back to the model
-- estimate. is_admin-gated (defence in depth alongside the write-less RLS).
create or replace function public.school_set_leg_odds(p_fixture_id bigint, p_odds numeric)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  if p_odds is null or p_odds <= 1 then
    delete from public.school_leg_odds where fixture_id = p_fixture_id;
    return;
  end if;
  insert into public.school_leg_odds (fixture_id, odds, set_by, updated_at)
  values (p_fixture_id, p_odds, auth.uid(), now())
  on conflict (fixture_id)
  do update set odds = excluded.odds, set_by = excluded.set_by, updated_at = now();
end $function$;

revoke all on function public.school_set_leg_odds(bigint, numeric) from public, anon;
grant execute on function public.school_set_leg_odds(bigint, numeric) to authenticated;

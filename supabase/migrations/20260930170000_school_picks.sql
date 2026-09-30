-- Onside School — manual pick book (owner-ruled 2026-09-30). The admin builds each day's slip by hand:
-- pick the match, the bet outcome, and the odds — like adding to the tracker. Each pick auto-grades
-- hit/miss from the fixture's score (page-side, on gradeable goal/result markets) and rolls into the
-- monthly record. Replaces the auto Over-2.5 selection as the record's source; school_daily_over25()
-- stays in the DB unused (revivable).
--
-- One row = one leg. A day's slip = all rows sharing set_date. Everyone signed in reads (the record is
-- the sell); only the admin RPCs below write, so no member can doctor the record.
create table if not exists public.school_picks (
  id uuid primary key default gen_random_uuid(),
  set_date date not null,                       -- the slip's day (Africa/Lagos)
  fixture_id bigint not null,
  market text not null,                         -- gradeable outcome key (over_2_5, under_3_5, btts_yes, home, dc_1x, ...)
  label text not null,                          -- display label ("Under 3.5", "BTTS — No")
  odds numeric not null check (odds > 1),       -- the real decimal odds taken
  set_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists school_picks_date_idx on public.school_picks (set_date);

alter table public.school_picks enable row level security;

drop policy if exists school_picks_sel on public.school_picks;
create policy school_picks_sel on public.school_picks for select using (true);
-- (no member write policy: only the security-definer admin RPCs below mutate the book)

grant select on public.school_picks to authenticated;

-- Add a leg to a day's slip (admin only).
create or replace function public.school_add_pick(
  p_date date, p_fixture_id bigint, p_market text, p_label text, p_odds numeric
) returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare v_id uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  if p_odds is null or p_odds <= 1 then
    raise exception 'Odds must be greater than 1.';
  end if;
  insert into public.school_picks (set_date, fixture_id, market, label, odds, set_by)
  values (p_date, p_fixture_id, p_market, p_label, p_odds, auth.uid())
  returning id into v_id;
  return v_id;
end $function$;

-- Remove a leg (admin only).
create or replace function public.school_remove_pick(p_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  delete from public.school_picks where id = p_id;
end $function$;

revoke all on function public.school_add_pick(date, bigint, text, text, numeric) from public, anon;
grant execute on function public.school_add_pick(date, bigint, text, text, numeric) to authenticated;
revoke all on function public.school_remove_pick(uuid) from public, anon;
grant execute on function public.school_remove_pick(uuid) to authenticated;

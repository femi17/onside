-- Onside School: a SportyBet booking/verify code per daily card. The owner builds the day's double on
-- SportyBet, gets the share code, and uploads it from /analytics; each School card shows the code so a
-- member can load the exact slip in one paste. One card per day (the all-Over-0.5 Onside Double), so the
-- code is keyed by the card's set_date.
--
-- The code REVEALS the paywalled upcoming pick, so reads are gated to admins + active admitted members
-- (same audience that unlocks the upcoming card). Non-members see no codes. Only the security-definer
-- admin RPC writes, so a member can never set/alter a code.
create table if not exists public.school_codes (
  set_date   date primary key,
  code       text not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table public.school_codes enable row level security;

-- read: admins and currently-admitted members (the code == the pick)
drop policy if exists school_codes_sel on public.school_codes;
create policy school_codes_sel on public.school_codes
  for select using (
    exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
    or exists (
      select 1 from public.school_enrollments e
      where e.user_id = (select auth.uid()) and e.status = 'admitted' and e.admitted_until > now()
    )
  );
-- (no user INSERT/UPDATE/DELETE policy: only school_set_code below mutates codes)

grant select on public.school_codes to authenticated;

-- Set (or clear) the SportyBet code for a date. Empty/blank code clears the row. Admin-gated.
create or replace function public.school_set_code(p_date date, p_code text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  if p_code is null or length(btrim(p_code)) = 0 then
    delete from public.school_codes where set_date = p_date;
    return;
  end if;
  insert into public.school_codes (set_date, code, updated_by, updated_at)
  values (p_date, upper(btrim(p_code)), auth.uid(), now())
  on conflict (set_date) do update
    set code = excluded.code, updated_by = excluded.updated_by, updated_at = now();
end $function$;

-- Recent codes for the admin uploader (bypasses the member-gated SELECT policy; admin only).
create or replace function public.school_codes_recent()
returns table (set_date date, code text, updated_at timestamptz)
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  return query
    select c.set_date, c.code, c.updated_at from public.school_codes c
    order by c.set_date desc limit 30;
end $function$;

revoke all on function public.school_set_code(date, text) from public, anon;
revoke all on function public.school_codes_recent() from public, anon;
grant execute on function public.school_set_code(date, text) to authenticated;
grant execute on function public.school_codes_recent() to authenticated;

-- Onside School enrollment — manual bank-transfer admission (NOT Paystack).
-- Flow: a user uploads a transfer receipt -> a 'pending' enrollment row; an admin reviews the receipt
-- image and admits them for 30 days (monthly). Access to the "upcoming pick" is gated on an ACTIVE
-- admitted enrollment; the settled record stays visible to everyone (it's the motivation to join).
--
-- Source of truth for access lives in THIS table, never on profiles, so a user can never self-grant:
-- RLS lets a user INSERT only a fresh 'pending' row for themselves and has NO user update/delete path.
-- Only the security-definer admin RPCs below can flip a row to 'admitted' with an expiry.

create table if not exists public.school_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'admitted', 'rejected')),
  receipt_path text,                         -- object path in the private 'school-receipts' bucket
  amount int,                                -- naira the user says they transferred (optional)
  note text,                                 -- optional note from the user
  admitted_until timestamptz,                -- set on admit; access is active while this is > now()
  reviewed_by uuid,                          -- admin who actioned the row
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.school_enrollments enable row level security;

create index if not exists school_enr_user_idx on public.school_enrollments (user_id, created_at desc);
create index if not exists school_enr_pending_idx on public.school_enrollments (created_at) where status = 'pending';

-- users read their own rows (to see their pending/rejected/admitted state)
drop policy if exists school_enr_sel_own on public.school_enrollments;
create policy school_enr_sel_own on public.school_enrollments
  for select using (user_id = (select auth.uid()));

-- admins read every row (the review queue)
drop policy if exists school_enr_sel_admin on public.school_enrollments;
create policy school_enr_sel_admin on public.school_enrollments
  for select using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin));

-- users may only submit a fresh PENDING row for themselves — never set status / expiry / reviewer
drop policy if exists school_enr_ins_own on public.school_enrollments;
create policy school_enr_ins_own on public.school_enrollments
  for insert with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and admitted_until is null
    and reviewed_by is null
    and reviewed_at is null
  );
-- (deliberately no user UPDATE/DELETE policy: only the admin RPCs below mutate status/expiry)

grant select, insert on public.school_enrollments to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Admin RPCs (security definer, is_admin-gated — defence in depth alongside RLS)
-- ---------------------------------------------------------------------------------------------------

-- Admit (or renew) a paying user for p_days days. Stacks onto any still-active window so an early
-- renewal doesn't burn the remaining days. Returns the new expiry.
create or replace function public.school_admit(p_id uuid, p_days int default 30)
returns timestamptz
language plpgsql
security definer
set search_path to ''
as $function$
declare v_user uuid; v_base timestamptz; v_until timestamptz;
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  select user_id into v_user from public.school_enrollments where id = p_id;
  if v_user is null then raise exception 'Enrollment not found.'; end if;
  select max(admitted_until) into v_base
    from public.school_enrollments
    where user_id = v_user and status = 'admitted' and admitted_until > now();
  v_until := coalesce(v_base, now()) + make_interval(days => greatest(p_days, 1));
  update public.school_enrollments
     set status = 'admitted', admitted_until = v_until, reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id;
  return v_until;
end $function$;

create or replace function public.school_reject(p_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  update public.school_enrollments
     set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id and status = 'pending';
end $function$;

-- Pending review queue with the payer's identity so the admin can match a receipt to a person.
create or replace function public.school_pending()
returns table (id uuid, user_id uuid, email text, display_name text, receipt_path text, amount int, note text, created_at timestamptz)
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  return query
    select e.id, e.user_id, u.email::text, p.display_name, e.receipt_path, e.amount, e.note, e.created_at
    from public.school_enrollments e
    join auth.users u on u.id = e.user_id
    left join public.profiles p on p.id = e.user_id
    where e.status = 'pending'
    order by e.created_at asc;
end $function$;

revoke all on function public.school_admit(uuid, int) from public, anon;
revoke all on function public.school_reject(uuid) from public, anon;
revoke all on function public.school_pending() from public, anon;
grant execute on function public.school_admit(uuid, int) to authenticated;
grant execute on function public.school_reject(uuid) to authenticated;
grant execute on function public.school_pending() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- Private receipt bucket + storage policies (user uploads to their own {uid}/ folder; admins read all)
-- ---------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('school-receipts', 'school-receipts', false)
on conflict (id) do nothing;

drop policy if exists school_receipts_ins on storage.objects;
create policy school_receipts_ins on storage.objects
  for insert to authenticated
  with check (bucket_id = 'school-receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists school_receipts_sel_own on storage.objects;
create policy school_receipts_sel_own on storage.objects
  for select to authenticated
  using (bucket_id = 'school-receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists school_receipts_sel_admin on storage.objects;
create policy school_receipts_sel_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'school-receipts' and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin));

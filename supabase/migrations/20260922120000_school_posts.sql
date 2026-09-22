-- Onside School: today's card is a DRAFT only the owner sees until they "Post now" — room to set the
-- line/odds and confirm the game at the bookmaker before members see it. One posted flag per day.
create table if not exists public.school_posts (
  set_date date primary key,
  posted_at timestamptz not null default now(),
  posted_by uuid
);
alter table public.school_posts enable row level security;

drop policy if exists school_posts_sel on public.school_posts;
create policy school_posts_sel on public.school_posts for select using (true);
grant select on public.school_posts to authenticated;

create or replace function public.school_post_day(p_date date, p_on boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'Admins only.';
  end if;
  if p_on then
    insert into public.school_posts (set_date, posted_at, posted_by)
    values (p_date, now(), auth.uid())
    on conflict (set_date) do update set posted_at = now(), posted_by = auth.uid();
  else
    delete from public.school_posts where set_date = p_date;
  end if;
end $function$;

revoke all on function public.school_post_day(date, boolean) from public, anon;
grant execute on function public.school_post_day(date, boolean) to authenticated;

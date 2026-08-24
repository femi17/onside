-- v3: the seeded demo/screenshot account (demo@onside.com.ng) qualified for the upsell
-- (free plan + agents) and got mailed on the first ladder run — exclude it from every
-- nudge kind at the pool level.
create or replace function public.nudge_targets()
returns table(kind text, user_id uuid, email text)
language sql
stable
security definer
set search_path to ''
as $function$
  with pool as (
    select u.id, u.email, u.email_confirmed_at, u.last_sign_in_at
    from auth.users u
    where u.deleted_at is null
      and u.email <> 'demo@onside.com.ng'  -- the seeded screenshot account never gets nudged
  )
  select 'confirm'::text, u.id, u.email::text
  from pool u
  where u.email_confirmed_at is null
    and u.last_sign_in_at is null
    and exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email')
  union all
  select 'onboard'::text, u.id, u.email::text
  from pool u
  join public.profiles p on p.id = u.id
  where u.email_confirmed_at is not null and p.onboarded = false
  union all
  select 'activate'::text, u.id, u.email::text
  from pool u
  join public.profiles p on p.id = u.id
  where p.onboarded = true
    and p.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.tickets t where t.user_id = p.id)
    and not exists (select 1 from public.strategies s where s.user_id = p.id)
  union all
  select 'upsell'::text, u.id, u.email::text
  from pool u
  join public.profiles p on p.id = u.id
  where p.plan = 'free'
    and exists (select 1 from public.strategies s
                where s.user_id = p.id and s.created_at < now() - interval '24 hours')
$function$;

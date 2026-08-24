-- The confirm nudge was the only ladder stage WITHOUT a 24h grace gate, so a same-day email
-- signup received Supabase's own confirmation email at signup AND our nudge at the next cron
-- tick (sundayabiodun781: registered 10:42, nudged 16:00). Give the original confirmation
-- email a full day to do its job; the nudge is the RESCUE for people who ignored it, not an
-- echo. Rest of the function unchanged.
create or replace function public.nudge_targets()
returns table(kind text, user_id uuid, email text)
language sql
stable
security definer
set search_path to ''
as $function$
  with pool as (
    select u.id, u.email, u.email_confirmed_at, u.last_sign_in_at, u.created_at
    from auth.users u
    where u.deleted_at is null
      and u.email not in ('demo@onside.com.ng', 'oduolafemi17@gmail.com')
  )
  select 'confirm'::text, u.id, u.email::text
  from pool u
  where u.email_confirmed_at is null
    and u.last_sign_in_at is null
    and u.created_at < now() - interval '24 hours'
    and exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email')
  union all
  select 'onboard'::text, u.id, u.email::text
  from pool u
  join public.profiles p on p.id = u.id
  where u.email_confirmed_at is not null and p.onboarded = false
    and u.created_at < now() - interval '24 hours'
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

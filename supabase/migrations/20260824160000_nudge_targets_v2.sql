-- Nudge audience v2: the full lifecycle ladder. Each kind is a STATE, recomputed fresh per
-- run; the mailer's once-per-(kind,user) claim turns states into at-most-one touch each:
--   confirm  — email signup never confirmed (never signed in)
--   onboard  — confirmed, onboarding not finished
--   activate — onboarded 24h+ ago, still no tracked bet AND no agent
--   upsell   — free plan, has an agent 24h+ old (their one monthly run has context by then)
-- Age gates keep day-zero users out: exploring is not idling. Service-role ONLY (emails).
create or replace function public.nudge_targets()
returns table(kind text, user_id uuid, email text)
language sql
stable
security definer
set search_path to ''
as $function$
  select 'confirm'::text, u.id, u.email::text
  from auth.users u
  where u.email_confirmed_at is null
    and u.last_sign_in_at is null
    and u.deleted_at is null
    and exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email')
  union all
  select 'onboard'::text, u.id, u.email::text
  from auth.users u
  join public.profiles p on p.id = u.id
  where u.email_confirmed_at is not null
    and u.deleted_at is null
    and p.onboarded = false
  union all
  select 'activate'::text, u.id, u.email::text
  from auth.users u
  join public.profiles p on p.id = u.id
  where u.deleted_at is null
    and p.onboarded = true
    and p.created_at < now() - interval '24 hours'
    and not exists (select 1 from public.tickets t where t.user_id = p.id)
    and not exists (select 1 from public.strategies s where s.user_id = p.id)
  union all
  select 'upsell'::text, u.id, u.email::text
  from auth.users u
  join public.profiles p on p.id = u.id
  where u.deleted_at is null
    and p.plan = 'free'
    and exists (select 1 from public.strategies s
                where s.user_id = p.id and s.created_at < now() - interval '24 hours')
$function$;
revoke all on function public.nudge_targets() from public, anon, authenticated;
grant execute on function public.nudge_targets() to service_role;

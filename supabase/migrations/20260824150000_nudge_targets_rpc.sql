-- Audience picker for the send-nudge mailer, computed where the data actually lives
-- (auth.users) instead of through the admin listUsers API, whose JS response dropped
-- unconfirmed users' fields in practice. Service-role ONLY — it exposes emails.
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
$function$;
revoke all on function public.nudge_targets() from public, anon, authenticated;
grant execute on function public.nudge_targets() to service_role;

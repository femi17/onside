-- Telegram-channel invite audience (owner request): users who linked the @OnsideAIbot get a
-- one-time bot message inviting them into the public @onsideai channel. send-nudge claims
-- nudge:tg-channel:{user} once EVER and skips (while claiming) anyone getChatMember already
-- shows inside the channel. Internal accounts excluded like nudge_targets.
create or replace function public.telegram_nudge_targets()
returns table(user_id uuid, chat_id bigint)
language sql
stable
security definer
set search_path to ''
as $function$
  select p.id, p.telegram_chat_id
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.telegram_chat_id is not null
    and coalesce(p.is_admin, false) = false
    and u.deleted_at is null
    and u.email not in ('tyewoduola@gmail.com', 'demo@onside.com.ng', 'oduolafemi17@gmail.com')
$function$;
revoke all on function public.telegram_nudge_targets() from public, anon, authenticated;
grant execute on function public.telegram_nudge_targets() to service_role;

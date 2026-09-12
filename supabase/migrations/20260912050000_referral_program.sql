-- Mirror of remotely applied migration referral_program (2026-09-12).
-- Two-sided referral: each user has a referral_code; a new user who signs up via /?ref=CODE gets
-- referred_by set once (attribute_referral). When that referee first SUBSCRIBES, the Paystack verify
-- route rewards BOTH sides (referrer +30d Pro, referee +14d), idempotent via referral_rewarded_at.
alter table public.profiles
  add column if not exists referral_code text,
  add column if not exists referred_by uuid references public.profiles(id),
  add column if not exists referral_rewarded_at timestamptz;

update public.profiles set referral_code = upper(substr(md5(gen_random_uuid()::text),1,6)) where referral_code is null;
alter table public.profiles alter column referral_code set default upper(substr(md5(gen_random_uuid()::text),1,6));
create unique index if not exists profiles_referral_code_uidx on public.profiles(referral_code);
create index if not exists profiles_referred_by_idx on public.profiles(referred_by);

create or replace function public.attribute_referral(p_code text)
returns boolean language plpgsql security definer set search_path to '' as $function$
declare v_ref uuid;
begin
  if p_code is null or length(trim(p_code)) = 0 then return false; end if;
  select id into v_ref from public.profiles where upper(referral_code) = upper(trim(p_code)) limit 1;
  if v_ref is null or v_ref = auth.uid() then return false; end if;
  update public.profiles set referred_by = v_ref where id = auth.uid() and referred_by is null;
  return found;
end;
$function$;
revoke all on function public.attribute_referral(text) from public, anon;
grant execute on function public.attribute_referral(text) to authenticated;

create or replace function public.my_referral_stats()
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_code text; v_joined int; v_subscribed int;
begin
  select referral_code into v_code from public.profiles where id = auth.uid();
  select count(*) into v_joined from public.profiles where referred_by = auth.uid();
  select count(*) into v_subscribed from public.profiles where referred_by = auth.uid() and referral_rewarded_at is not null;
  return jsonb_build_object('code', v_code, 'joined', v_joined, 'subscribed', v_subscribed, 'days_earned', v_subscribed * 30);
end;
$function$;
revoke all on function public.my_referral_stats() from public, anon;
grant execute on function public.my_referral_stats() to authenticated;

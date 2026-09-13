-- Referral reward cap (display side). The Paystack verify route now grants a referrer at most
-- REFERRAL_REWARD_CAP = 12 friends' worth of +30d (lifetime) — bounds the give-away against
-- fake/self-referral rings. Past the cap, referees are still marked referral_rewarded_at (they get
-- their own +14d), so v_subscribed keeps climbing while the referrer earns nothing more. Cap the
-- displayed "free days earned" at 12*30 = 360 so the tally stays truthful. 'subscribed' still shows
-- the real count of friends who subscribed.
create or replace function public.my_referral_stats()
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_code text; v_joined int; v_subscribed int;
begin
  select referral_code into v_code from public.profiles where id = auth.uid();
  select count(*) into v_joined from public.profiles where referred_by = auth.uid();
  select count(*) into v_subscribed from public.profiles where referred_by = auth.uid() and referral_rewarded_at is not null;
  return jsonb_build_object('code', v_code, 'joined', v_joined, 'subscribed', v_subscribed, 'days_earned', least(v_subscribed, 12) * 30);
end;
$function$;
revoke all on function public.my_referral_stats() from public, anon;
grant execute on function public.my_referral_stats() to authenticated;

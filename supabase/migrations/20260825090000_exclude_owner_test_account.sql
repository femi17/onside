-- The owner's slip-testing Gmail (oduolafemi17@gmail.com, "Emmanuel Oduola") was the last
-- internal fingerprint in the "real users" analytics — it held the only counted acca — and
-- it must never receive lifecycle nudges either. One-line change in each function's
-- exclusion list; everything else identical to the previous versions.

-- 1) nudge mailer audience: extend the pool exclusion
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
      -- internal accounts never get nudged: seeded demo + the owner's test Gmail
      and u.email not in ('demo@onside.com.ng', 'oduolafemi17@gmail.com')
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

-- 2) analytics: extend v_excl inside admin_analytics (body otherwise identical to v3);
--    the full function is re-stated because Postgres replaces functions whole.
--    See 20260824180000 for the v3 commentary.
create or replace function public.admin_analytics()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_admin boolean;
  v_excl uuid[];
begin
  select is_admin into v_admin from public.profiles where id = auth.uid();
  if not coalesce(v_admin, false) then raise exception 'not authorized'; end if;

  select coalesce(array_agg(p.id), '{}') into v_excl
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.is_admin = true
     or u.email in ('tyewoduola@gmail.com', 'demo@onside.com.ng', 'oduolafemi17@gmail.com');

  return jsonb_build_object(
    'users', jsonb_build_object(
      'total', (select count(*) from public.profiles where id <> all(v_excl)),
      'new_today', (select count(*) from public.profiles where id <> all(v_excl) and created_at >= date_trunc('day', now())),
      'new_7d', (select count(*) from public.profiles where id <> all(v_excl) and created_at > now() - interval '7 days'),
      'new_30d', (select count(*) from public.profiles where id <> all(v_excl) and created_at > now() - interval '30 days'),
      'active_7d', (select count(*) from (
          select user_id from public.tickets where created_at > now() - interval '7 days'
          union select user_id from public.community_posts where created_at > now() - interval '7 days'
          union select user_id from public.strategies where last_run_at > now() - interval '7 days'
        ) u where user_id is not null and user_id <> all(v_excl)),
      'telegram_linked', (select count(*) from public.profiles where id <> all(v_excl) and telegram_linked_at is not null)
    ),
    'funnel', jsonb_build_object(
      'onboarded', (select count(*) from public.profiles where id <> all(v_excl) and onboarded = true),
      'with_bet', (select count(distinct user_id) from public.tickets where user_id <> all(v_excl)),
      'with_agent', (select count(distinct user_id) from public.strategies where user_id <> all(v_excl)),
      'push_enabled', (select count(distinct user_id) from public.push_subscriptions where user_id <> all(v_excl))
    ),
    'revenue', jsonb_build_object(
      'free', (select count(*) from public.profiles where id <> all(v_excl) and (plan = 'free' or plan is null)),
      'pro', (select count(*) from public.profiles where id <> all(v_excl) and plan = 'pro'),
      'pro_max', (select count(*) from public.profiles where id <> all(v_excl) and plan = 'pro_max'),
      'active_subs', (select count(*) from public.profiles where id <> all(v_excl) and paystack_subscription_code is not null),
      'mrr_naira', (select coalesce(sum(case plan when 'pro' then 500 when 'pro_max' then 1000 else 0 end), 0) from public.profiles where id <> all(v_excl)),
      'collected_naira', (select coalesce(sum(amount_kobo), 0) / 100 from public.payments where status = 'success' and user_id <> all(v_excl))
    ),
    'agents', jsonb_build_object(
      'total', (select count(*) from public.strategies where user_id <> all(v_excl)),
      'running', (select count(*) from public.strategies where user_id <> all(v_excl) and status = 'running'),
      'learning', (select count(*) from public.strategies where user_id <> all(v_excl) and learning = true),
      'new_7d', (select count(*) from public.strategies where user_id <> all(v_excl) and created_at > now() - interval '7 days'),
      'deliveries', (select count(*) from public.deliveries where user_id <> all(v_excl)),
      'won', (select count(*) from public.deliveries where user_id <> all(v_excl) and result = 'won'),
      'lost', (select count(*) from public.deliveries where user_id <> all(v_excl) and result = 'lost'),
      'void', (select count(*) from public.deliveries where user_id <> all(v_excl) and result = 'void'),
      'pending', (select count(*) from public.deliveries where user_id <> all(v_excl) and (result = 'pending' or result is null)),
      'avg_edge', (select round(avg(edge)::numeric, 4) from public.deliveries where user_id <> all(v_excl) and edge is not null),
      'top_markets', (select coalesce(jsonb_agg(jsonb_build_object('market', market_key, 'n', c) order by c desc), '[]'::jsonb)
          from (select market_key, count(*) c from public.deliveries where user_id <> all(v_excl) and market_key is not null group by market_key order by c desc limit 6) m)
    ),
    'engagement', jsonb_build_object(
      'tickets', (select count(*) from public.tickets where user_id <> all(v_excl)),
      'tickets_7d', (select count(*) from public.tickets where user_id <> all(v_excl) and created_at > now() - interval '7 days'),
      'accumulators', (select count(*) from public.accumulators where user_id <> all(v_excl)),
      'slip_uploads', (select count(*) from public.screenshot_imports where user_id <> all(v_excl)),
      'posts', (select count(*) from public.community_posts where user_id <> all(v_excl)),
      'comments', (select count(*) from public.community_comments where user_id <> all(v_excl)),
      'reactions', (select count(*) from public.community_reactions where user_id <> all(v_excl)),
      'leaderboard_opt_ins', (select count(*) from public.profiles where id <> all(v_excl) and leaderboard_opt_in = true),
      'open_reports', (select count(*) from public.community_reports),
      'channel_posts', (select count(*) from public.channel_posts),
      'channel_posted', (select count(*) from public.channel_posts where status = 'posted'),
      'channel_failed', (select count(*) from public.channel_posts where status in ('failed', 'blocked')),
      'api_today', (select coalesce(sum(count), 0) from public.api_usage where day = current_date)
    ),
    'signups_daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', c) order by d), '[]'::jsonb)
        from (select date_trunc('day', created_at)::date d, count(*) c from public.profiles where id <> all(v_excl) and created_at > now() - interval '30 days' group by 1) s),
    'agents_daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', c) order by d), '[]'::jsonb)
        from (select date_trunc('day', created_at)::date d, count(*) c from public.strategies where user_id <> all(v_excl) and created_at > now() - interval '30 days' group by 1) s),
    'revenue_weekly', (select coalesce(jsonb_agg(jsonb_build_object('w', w, 'amount', amt, 'cum', cum) order by w), '[]'::jsonb)
        from (
          with wk as (select date_trunc('week', paid_at)::date w, sum(amount_kobo) / 100.0 amt from public.payments where status = 'success' and user_id <> all(v_excl) group by 1)
          select w, amt, sum(amt) over (order by w) cum from wk order by w desc limit 12) t),
    'agents_weekly', (select coalesce(jsonb_agg(jsonb_build_object('w', w, 'n', c, 'cum', cum) order by w), '[]'::jsonb)
        from (
          with wk as (select date_trunc('week', created_at)::date w, count(*) c from public.strategies where user_id <> all(v_excl) group by 1)
          select w, c, sum(c) over (order by w) cum from wk order by w desc limit 12) t),
    'deliveries_weekly', (select coalesce(jsonb_agg(jsonb_build_object('w', w, 'n', c) order by w), '[]'::jsonb)
        from (select date_trunc('week', delivered_at)::date w, count(*) c from public.deliveries where user_id <> all(v_excl) and delivered_at is not null group by 1 order by 1 desc limit 12) t)
  );
end;
$function$;

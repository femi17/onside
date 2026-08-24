-- admin_analytics v2: adds (1) agents_daily — strategies created per day, last 30 days
-- (the weekly cumulative chart hid the day-to-day pulse the launch phase needs) and
-- (2) funnel — the activation ladder the marketing push is driving: onboarded → placed
-- a bet → built an agent → push enabled. Everything else unchanged.
create or replace function public.admin_analytics()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_admin boolean;
begin
  select is_admin into v_admin from public.profiles where id = auth.uid();
  if not coalesce(v_admin, false) then raise exception 'not authorized'; end if;

  return jsonb_build_object(
    'users', jsonb_build_object(
      'total', (select count(*) from public.profiles),
      'new_today', (select count(*) from public.profiles where created_at >= date_trunc('day', now())),
      'new_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
      'new_30d', (select count(*) from public.profiles where created_at > now() - interval '30 days'),
      'active_7d', (select count(*) from (
          select user_id from public.tickets where created_at > now() - interval '7 days'
          union select user_id from public.community_posts where created_at > now() - interval '7 days'
          union select user_id from public.strategies where last_run_at > now() - interval '7 days'
        ) u where user_id is not null),
      'telegram_linked', (select count(*) from public.profiles where telegram_linked_at is not null)
    ),
    'funnel', jsonb_build_object(
      'onboarded', (select count(*) from public.profiles where onboarded = true),
      'with_bet', (select count(distinct user_id) from public.tickets),
      'with_agent', (select count(distinct user_id) from public.strategies),
      'push_enabled', (select count(distinct user_id) from public.push_subscriptions)
    ),
    'revenue', jsonb_build_object(
      'free', (select count(*) from public.profiles where plan = 'free' or plan is null),
      'pro', (select count(*) from public.profiles where plan = 'pro'),
      'pro_max', (select count(*) from public.profiles where plan = 'pro_max'),
      'active_subs', (select count(*) from public.profiles where paystack_subscription_code is not null),
      'mrr_naira', (select coalesce(sum(case plan when 'pro' then 500 when 'pro_max' then 1000 else 0 end), 0) from public.profiles),
      'collected_naira', (select coalesce(sum(amount_kobo), 0) / 100 from public.payments where status = 'success')
    ),
    'agents', jsonb_build_object(
      'total', (select count(*) from public.strategies),
      'running', (select count(*) from public.strategies where status = 'running'),
      'learning', (select count(*) from public.strategies where learning = true),
      'new_7d', (select count(*) from public.strategies where created_at > now() - interval '7 days'),
      'deliveries', (select count(*) from public.deliveries),
      'won', (select count(*) from public.deliveries where result = 'won'),
      'lost', (select count(*) from public.deliveries where result = 'lost'),
      'void', (select count(*) from public.deliveries where result = 'void'),
      'pending', (select count(*) from public.deliveries where result = 'pending' or result is null),
      'avg_edge', (select round(avg(edge)::numeric, 4) from public.deliveries where edge is not null),
      'top_markets', (select coalesce(jsonb_agg(jsonb_build_object('market', market_key, 'n', c) order by c desc), '[]'::jsonb)
          from (select market_key, count(*) c from public.deliveries where market_key is not null group by market_key order by c desc limit 6) m)
    ),
    'engagement', jsonb_build_object(
      'tickets', (select count(*) from public.tickets),
      'tickets_7d', (select count(*) from public.tickets where created_at > now() - interval '7 days'),
      'accumulators', (select count(*) from public.accumulators),
      'slip_uploads', (select count(*) from public.screenshot_imports),
      'posts', (select count(*) from public.community_posts),
      'comments', (select count(*) from public.community_comments),
      'reactions', (select count(*) from public.community_reactions),
      'leaderboard_opt_ins', (select count(*) from public.profiles where leaderboard_opt_in = true),
      'open_reports', (select count(*) from public.community_reports),
      'channel_posts', (select count(*) from public.channel_posts),
      'channel_posted', (select count(*) from public.channel_posts where status = 'posted'),
      'channel_failed', (select count(*) from public.channel_posts where status in ('failed', 'blocked')),
      'api_today', (select coalesce(sum(count), 0) from public.api_usage where day = current_date)
    ),
    'signups_daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', c) order by d), '[]'::jsonb)
        from (select date_trunc('day', created_at)::date d, count(*) c from public.profiles where created_at > now() - interval '30 days' group by 1) s),
    'agents_daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', c) order by d), '[]'::jsonb)
        from (select date_trunc('day', created_at)::date d, count(*) c from public.strategies where created_at > now() - interval '30 days' group by 1) s),
    'revenue_weekly', (select coalesce(jsonb_agg(jsonb_build_object('w', w, 'amount', amt, 'cum', cum) order by w), '[]'::jsonb)
        from (
          with wk as (select date_trunc('week', paid_at)::date w, sum(amount_kobo) / 100.0 amt from public.payments where status = 'success' group by 1)
          select w, amt, sum(amt) over (order by w) cum from wk order by w desc limit 12) t),
    'agents_weekly', (select coalesce(jsonb_agg(jsonb_build_object('w', w, 'n', c, 'cum', cum) order by w), '[]'::jsonb)
        from (
          with wk as (select date_trunc('week', created_at)::date w, count(*) c from public.strategies group by 1)
          select w, c, sum(c) over (order by w) cum from wk order by w desc limit 12) t),
    'deliveries_weekly', (select coalesce(jsonb_agg(jsonb_build_object('w', w, 'n', c) order by w), '[]'::jsonb)
        from (select date_trunc('week', delivered_at)::date w, count(*) c from public.deliveries where delivered_at is not null group by 1 order by 1 desc limit 12) t)
  );
end;
$function$;

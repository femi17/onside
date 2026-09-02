-- Last-seen presence ping: a user who logs in daily but only READS their agent's picks leaves
-- no row anywhere and looks churned. user_seen_days records one (user, day) row per calendar
-- day via the mark_seen() RPC (client fires it at most hourly, localStorage-throttled).
-- Service/definer only (RLS on, no policies — no client reads needed). admin_analytics then
-- counts a seen-day as activity in active_7d and active_by_day, so "active" means "showed up",
-- not just "wrote something".

create table if not exists public.user_seen_days (
  user_id uuid not null,
  day date not null,
  primary key (user_id, day)
);
alter table public.user_seen_days enable row level security;

-- Idempotent daily marker. security definer so it can write past RLS; no-op when unauthenticated.
create or replace function public.mark_seen()
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if auth.uid() is null then return; end if;
  insert into public.user_seen_days (user_id, day)
  values (auth.uid(), current_date)
  on conflict do nothing;
end;
$function$;

revoke all on function public.mark_seen() from public;
revoke all on function public.mark_seen() from anon;
grant execute on function public.mark_seen() to authenticated;

-- admin_analytics: count seen-days as activity. Body copied byte-for-byte from
-- 20260901230000_admin_analytics_daily_sparks.sql; the ONLY changes are one extra union arm in
-- users.active_7d and one extra union arm in users.active_by_day (both public.user_seen_days).
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
          union select user_id from public.user_seen_days where day > now() - interval '7 days'
        ) u where user_id is not null and user_id <> all(v_excl)),
      'active_by_day', (
        select coalesce(jsonb_agg(jsonb_build_object('day', day, 'n', c) order by day), '[]'::jsonb)
        from (
          select gs::date as day, count(distinct a.user_id) as c
          from generate_series(current_date - 6, current_date, interval '1 day') gs
          left join (
            select user_id, created_at as at from public.tickets where created_at >= current_date - 6
            union all select user_id, created_at from public.accumulators where created_at >= current_date - 6
            union all select user_id, created_at from public.screenshot_imports where created_at >= current_date - 6
            union all select user_id, created_at from public.community_posts where created_at >= current_date - 6
            union all select user_id, created_at from public.community_comments where created_at >= current_date - 6
            union all select user_id, created_at from public.community_reactions where created_at >= current_date - 6
            union all select user_id, created_at from public.strategies where created_at >= current_date - 6
            union all select user_id, paid_at from public.payments where status = 'success' and paid_at >= current_date - 6
            union all select user_id, answered_at from public.user_prompts where answered_at >= current_date - 6
            union all select user_id, day::timestamptz from public.user_seen_days where day >= current_date - 6
          ) a on a.at >= gs and a.at < gs + interval '1 day'
               and a.user_id is not null and a.user_id <> all(v_excl)
          group by 1
        ) t
      ),
      'telegram_by_day', (
        select coalesce(jsonb_agg(jsonb_build_object('day', day, 'n', c) order by day), '[]'::jsonb)
        from (
          select gs::date as day, count(p.id) as c
          from generate_series(current_date - 6, current_date, interval '1 day') gs
          left join public.profiles p on p.telegram_linked_at >= gs and p.telegram_linked_at < gs + interval '1 day' and p.id <> all(v_excl)
          group by 1
        ) t
      ),
      'telegram_linked', (select count(*) from public.profiles where id <> all(v_excl) and telegram_linked_at is not null)
    ),
    'funnel', jsonb_build_object(
      'onboarded', (select count(*) from public.profiles where id <> all(v_excl) and onboarded = true),
      'with_bet', (select count(distinct user_id) from public.tickets where user_id <> all(v_excl)),
      'with_agent', (select count(distinct user_id) from public.strategies where user_id <> all(v_excl)),
      'push_enabled', (select count(distinct user_id) from public.push_subscriptions where user_id <> all(v_excl)),
      'onboarded_by_day', (
        select coalesce(jsonb_agg(jsonb_build_object('day', day, 'n', c) order by day), '[]'::jsonb)
        from (
          select gs::date as day, count(p.id) as c
          from generate_series(current_date - 6, current_date, interval '1 day') gs
          left join public.profiles p on p.onboarded = true and p.created_at >= gs and p.created_at < gs + interval '1 day' and p.id <> all(v_excl)
          group by 1
        ) t
      ),
      'first_bet_by_day', (
        select coalesce(jsonb_agg(jsonb_build_object('day', day, 'n', c) order by day), '[]'::jsonb)
        from (
          select gs::date as day, count(b.user_id) as c
          from generate_series(current_date - 6, current_date, interval '1 day') gs
          left join (select user_id, min(created_at) f from public.tickets where user_id is not null group by 1) b
            on b.f >= gs and b.f < gs + interval '1 day' and b.user_id <> all(v_excl)
          group by 1
        ) t
      ),
      'first_agent_by_day', (
        select coalesce(jsonb_agg(jsonb_build_object('day', day, 'n', c) order by day), '[]'::jsonb)
        from (
          select gs::date as day, count(b.user_id) as c
          from generate_series(current_date - 6, current_date, interval '1 day') gs
          left join (select user_id, min(created_at) f from public.strategies where user_id is not null group by 1) b
            on b.f >= gs and b.f < gs + interval '1 day' and b.user_id <> all(v_excl)
          group by 1
        ) t
      ),
      'push_by_day', (
        select coalesce(jsonb_agg(jsonb_build_object('day', day, 'n', c) order by day), '[]'::jsonb)
        from (
          select gs::date as day, count(b.user_id) as c
          from generate_series(current_date - 6, current_date, interval '1 day') gs
          left join (select user_id, min(created_at) f from public.push_subscriptions where user_id is not null group by 1) b
            on b.f >= gs and b.f < gs + interval '1 day' and b.user_id <> all(v_excl)
          group by 1
        ) t
      )
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

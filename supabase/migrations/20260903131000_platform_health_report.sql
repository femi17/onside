-- Mirror of remotely applied migration platform_health_report (2026-09-03).
-- Token-gated platform-health snapshot for the daily 'platform-health' cloud agent (reuses
-- routine_token). Reads only small/indexed tables + the fixtures scan COUNTERS (pg_stat, not the
-- table) — so it also serves as a daily disk-IO watch without ever scanning fixtures. jsonb out,
-- mirrors rule_lab_report's pattern; the agent formats it and sends via routine_send_dm.
create or replace function public.platform_health(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  tok text;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'routine_token';
  if tok is null or p_token is distinct from tok then
    raise exception 'invalid token';
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'users', jsonb_build_object(
      'total', (select count(*) from auth.users where deleted_at is null),
      'confirmed', (select count(*) from auth.users where deleted_at is null and email_confirmed_at is not null),
      'new_7d', (select count(*) from auth.users where deleted_at is null and created_at > now()-interval '7 days'),
      'with_agents', (select count(distinct user_id) from public.strategies),
      'with_tracked_bets', (select count(distinct user_id) from public.tickets),
      'active_7d', (select count(distinct user_id) from public.user_seen_days where day > current_date - 7)
    ),
    'monetization', jsonb_build_object(
      'paid_active', (select count(*) from public.profiles where plan in ('pro','pro_max') and (plan_until is null or plan_until > now())),
      'pro', (select count(*) from public.profiles where plan='pro' and (plan_until is null or plan_until > now())),
      'pro_max', (select count(*) from public.profiles where plan='pro_max' and (plan_until is null or plan_until > now())),
      'recurring_subs', (select count(*) from public.profiles where paystack_subscription_code is not null)
    ),
    'agents', jsonb_build_object(
      'running', (select count(*) from public.strategies where status='running'),
      'learning', (select count(*) from public.strategies where status='running' and learning),
      'paper', (select count(*) from public.strategies where status='draft' and name like '📄 Paper%')
    ),
    'picks', (
      select jsonb_build_object(
        'settled_all', count(*) filter (where d.result in ('won','lost')),
        'hit_all', round(100.0*count(*) filter (where d.result='won')/nullif(count(*) filter (where d.result in ('won','lost')),0),1),
        'pending', count(*) filter (where d.result='pending'),
        'settled_7d', count(*) filter (where d.result in ('won','lost') and d.delivered_at > now()-interval '7 days'),
        'hit_7d', round(100.0*count(*) filter (where d.result='won' and d.delivered_at > now()-interval '7 days')/nullif(count(*) filter (where d.result in ('won','lost') and d.delivered_at > now()-interval '7 days'),0),1)
      )
      from public.deliveries d
      join public.strategies s on s.id=d.strategy_id and s.status <> 'draft'
    ),
    'tickets', jsonb_build_object(
      'settled', (select count(*) from public.tickets where status in ('won','lost')),
      'hit', (select round(100.0*count(*) filter (where status='won')/nullif(count(*) filter (where status in ('won','lost')),0),1) from public.tickets)
    ),
    'community', jsonb_build_object(
      'posts', (select count(*) from public.community_posts where hidden=false),
      'members', (select count(*) from public.profiles where community_opt_in)
    ),
    'learning', jsonb_build_object(
      'proven_rules', (select count(*) from public.proven_rules),
      'rule_lab_cells', (select count(*) from public.rule_lab),
      'model_signal_cells', (select count(*) from public.model_signal_lab)
    ),
    'infra', (
      select jsonb_build_object(
        'fixtures_seq_scan', seq_scan,
        'fixtures_seq_tup_read', seq_tup_read,
        'fixtures_size', pg_size_pretty(pg_total_relation_size('public.fixtures'))
      )
      from pg_stat_user_tables where relname='fixtures'
    )
  );
end;
$$;

revoke all on function public.platform_health(text) from public;
grant execute on function public.platform_health(text) to anon, authenticated, service_role;

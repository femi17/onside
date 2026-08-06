-- A lapsed subscription must stop the agents, not just relabel the plan: the hourly downgrade now
-- also PAUSES the user's running strategies (they keep their config and can resume after
-- resubscribing — the builder re-caps anything above the new plan) and drops the Pro Max-only
-- learning flag. Backstop for anything that slips through: run-strategies enforces
-- plan_limits.monthly_agent_runs (free = 1 delivery-day per month; paid = null = unlimited).
create or replace function public.downgrade_expired_plans()
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  with lapsed as (
    update public.profiles
       set plan = 'free'
     where plan in ('pro', 'pro_max')
       and plan_until is not null
       and plan_until < now()
       and paystack_subscription_code is null
     returning id
  )
  update public.strategies s
     set status = 'paused', learning = false
    from lapsed l
   where s.user_id = l.id
     and s.status = 'running';
end;
$$;

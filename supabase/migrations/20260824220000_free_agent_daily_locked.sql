-- OWNER-RULED PLAN CHANGE (2026-08-24): Free agents hunt DAILY, but the agent is LOCKED as
-- built — editing and deleting are Pro features. Rationale: a monthly run can't form a habit
-- (the daily loop is the product), and the upgrade pressure moves from absence to control.
-- Delete had to lock too: the builder runs an agent on creation, so create→copy picks→
-- delete→recreate would mint unlimited agent runs on free.
--
-- 1) Daily: the engine already treats monthly_agent_runs NULL as unlimited/daily — data change only.
update public.plan_limits set monthly_agent_runs = null where plan = 'free';

-- 2) The lock, enforced AT THE DATABASE (hidden buttons are not enforcement):
--    UPDATE on free: only name / status (pause-resume) / shield may change; every aiming
--    field (market, rule, leagues, schedule, caps) raises. share_token / rule_parsed /
--    last_run_at pass for the engine via the service-role bypass (same pattern as
--    protect_profile_plan); share_token also changes via the user-invoked share RPC, so it
--    is deliberately absent from the blocked list.
--    DELETE on free: allowed only while the user holds MORE agents than the free cap
--    (downgrade cleanup shrinks to the cap and stops) — a within-cap free user can never
--    free the slot, which is what closes the recreate exploit.
create or replace function public.protect_free_agent()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_plan text;
  v_cap int;
  v_cnt int;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  select plan into v_plan from public.profiles where id = coalesce(old.user_id, new.user_id);
  if coalesce(v_plan, 'free') <> 'free' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    select max_agents into v_cap from public.plan_limits where plan = 'free';
    select count(*) into v_cnt from public.strategies where user_id = old.user_id;
    if v_cnt > coalesce(v_cap, 1) then return old; end if;
    raise exception 'FREE_AGENT_DELETE_LOCKED: retiring an agent is a Pro feature';
  end if;

  if new.market_key        is distinct from old.market_key
     or new.market_label   is distinct from old.market_label
     or new.custom_market  is distinct from old.custom_market
     or new.markets        is distinct from old.markets
     or new.side           is distinct from old.side
     or new.line           is distinct from old.line
     or new.period         is distinct from old.period
     or new.bet_value      is distinct from old.bet_value
     or new.rule_text      is distinct from old.rule_text
     or new.league_ids     is distinct from old.league_ids
     or new.league_mode    is distinct from old.league_mode
     or new.deliver_at     is distinct from old.deliver_at
     or new.target_day     is distinct from old.target_day
     or new.kickoff_at     is distinct from old.kickoff_at
     or new.kickoff_until  is distinct from old.kickoff_until
     or new.selectivity    is distinct from old.selectivity
     or new.min_edge       is distinct from old.min_edge
     or new.max_per_prediction is distinct from old.max_per_prediction
     or new.learning       is distinct from old.learning
  then
    raise exception 'FREE_AGENT_LOCKED: tuning an agent is a Pro feature';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_protect_free_agent on public.strategies;
create trigger trg_protect_free_agent
  before update or delete on public.strategies
  for each row execute function public.protect_free_agent();

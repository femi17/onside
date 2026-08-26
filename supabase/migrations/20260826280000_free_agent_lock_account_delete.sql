-- Bug found by the immutable-record dry-run: account deletion CASCADES into strategies, and
-- protect_free_agent blocked that cascade for free users (no service_role jwt in the auth
-- admin session + the profile row is already gone so the plan lookup read as 'free') —
-- making delete-account fail for any free user with an agent. Ruling stays intact for the
-- real case (a free user retiring an agent from the app still blocks); the fix: when the
-- OWNER'S PROFILE NO LONGER EXISTS the delete is an account-deletion cascade — allow it.
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
  v_has_profile boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  select true, plan into v_has_profile, v_plan
  from public.profiles where id = coalesce(old.user_id, new.user_id);
  -- no profile row = the account itself is being deleted; the agent goes with it
  if not coalesce(v_has_profile, false) then
    return case tg_op when 'DELETE' then old else new end;
  end if;
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

-- Free-tier fairness pass.
--
-- 1) Manual accas are unlimited & free for EVERYONE. Only slip UPLOADS cost anything (a Haiku
--    vision read), and those are already metered by max_slip_uploads_per_day. Grouping games you
--    tracked by hand into an acca costs nothing, so the daily acca cap now applies to
--    screenshot-sourced accas only — a manual acca is never blocked, on any plan.
create or replace function public.enforce_acca_daily_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_plan text;
  v_tz text;
  v_limit integer;
  v_count integer;
begin
  -- manual accas (source <> 'screenshot') are unlimited for all plans
  if coalesce(new.source, 'manual') <> 'screenshot' then
    return new;
  end if;
  select plan, coalesce(timezone, 'Africa/Lagos') into v_plan, v_tz from profiles where id = new.user_id;
  v_plan := coalesce(v_plan, 'free');
  v_tz := coalesce(v_tz, 'Africa/Lagos');
  select max_accas_per_day into v_limit from plan_limits where plan = v_plan;
  v_limit := coalesce(v_limit, 1);

  select count(*) into v_count from accumulators
    where user_id = new.user_id and source = 'screenshot'
      and (created_at at time zone v_tz)::date = (now() at time zone v_tz)::date;

  if v_count >= v_limit then
    raise exception 'DAILY_ACCA_LIMIT:%:%', v_plan, v_limit using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

-- 2) Acca history is now unlimited for everyone. Accas are just rows; capping how many you can
--    KEEP while creation is unlimited was inconsistent (you'd make one and an old one vanished).
--    Pro / Pro Max stay differentiated on the limits that actually cost (agents, slip reads,
--    leagues, games per run, learning). prune_accumulator_history no-ops when the cap is null.
update public.plan_limits set max_accas_history = null where plan in ('free', 'pro');

-- 3) Free agents: monthly delivery allowance 1 -> 4 (~weekly) once the new 7-day daily TRIAL ends.
--    The trial itself lives in run-strategies (gated on profiles.created_at), not here.
update public.plan_limits set monthly_agent_runs = 4 where plan = 'free';

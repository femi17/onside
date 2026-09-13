-- Mirror of remotely applied migration gen_acca_free_8_legs (2026-09-13). Supersedes the caps in
-- 20260902120000_acca_generator_limit.sql (that file was stale: paid had since been raised to 24 in
-- the DB without a mirror). Current caps: free = 1 generated slip/day, 8 legs; pro/pro_max =
-- unlimited slips/day, 24 legs. Deletes still don't refund the day's slot.
create or replace function public.enforce_generated_acca_limit()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_plan text; v_tz text; v_limit integer; v_max_legs integer; v_count integer;
begin
  if coalesce(new.source, '') <> 'generated' then return new; end if;

  select plan, coalesce(timezone, 'Africa/Lagos') into v_plan, v_tz from profiles where id = new.user_id;
  v_plan := coalesce(v_plan, 'free');
  v_tz := coalesce(v_tz, 'Africa/Lagos');

  if v_plan in ('pro', 'pro_max') then
    v_limit := null; v_max_legs := 24;
  else
    v_limit := 1; v_max_legs := 8;
  end if;

  if coalesce(new.leg_count, 0) > v_max_legs then
    raise exception 'GEN_ACCA_LEGS:%:%', v_plan, v_max_legs using errcode = 'check_violation';
  end if;

  if v_limit is not null then
    select count(*) into v_count from accumulators
      where user_id = new.user_id and source = 'generated'
        and (created_at at time zone v_tz)::date = (now() at time zone v_tz)::date;
    if v_count >= v_limit then
      raise exception 'DAILY_GEN_LIMIT:%:%', v_plan, v_limit using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$function$;
